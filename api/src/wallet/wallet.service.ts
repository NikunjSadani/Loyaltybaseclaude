import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PointsLedgerType, WalletTransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveCreditFieldNames } from '../common/credit-field-name.helper';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { istMonthBounds } from '../common/ist-date';
import { AdjustType, AdjustWalletDto, ListTransactionsQueryDto, StatementQueryDto } from './dto/wallet.dto';
import { buildStatementResponse, defaultTxDescription, EMPTY_STATEMENT } from '../common/points-statement.helper';

/**
 * Wallet & Points — ported from platform/src/app/api/wallet/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT). Admin adjustments are
 * GIFSY-only (enforced by @Roles on the controller; tenant scope re-checked here).
 * Business logic lives here; the controller is a thin HTTP adapter.
 *
 * ═══ THE CANONICAL WALLET INVARIANT (P5 — Stream W, locked) ═══════════════════
 * The wallet carries spendable balances AND monotonic lifetime accumulators. They
 * must never desync, and every mutation writes BOTH a WalletTransaction (passbook)
 * AND a PointsLedger row (the source-of-truth lots, e.g. for expiry), atomically.
 *
 *  - redeemablePoints : currently spendable balance (the only "live" balance in P5).
 *  - lockedPoints     : currently held — stays 0 in P5. Holding/lock is DEFERRED
 *                       (lost its config home when TierConfig was dropped in S2).
 *                       The fields + LOCK/UNLOCK enums survive for a future ~½-day
 *                       add (a symmetric unlock-sweep). We do NOT touch them here.
 *  - redeemedPoints   : running total consumed by redemptions (net of reversals).
 *  - expiredPoints    : running total expired.
 *  - earnedPoints, lifetimeEarned, lifetimeRedeemed, lifetimeExpired :
 *                       MONOTONIC lifetime accumulators — NEVER decremented.
 *
 * Therefore:
 *  - A CREDIT (earn/bonus/credit-adjust) increments earnedPoints + lifetimeEarned
 *    + redeemablePoints.
 *  - A REVERSAL re-credits redeemablePoints only (it is NOT new earning, so it does
 *    NOT bump earnedPoints/lifetimeEarned — documented on reverse()).
 *  - A DEBIT (redeem/expiry/debit-adjust) decrements redeemablePoints ONLY and
 *    increments the matching running/lifetime counter (redeemed+lifetimeRedeemed
 *    for a redemption; expired+lifetimeExpired for expiry). It NEVER decrements
 *    earnedPoints/lifetimeEarned. (The old adjust() decremented earnedPoints on a
 *    debit — bug #1, fixed here. Nothing wrote PointsLedger — bug #2 / Gap #28,
 *    fixed here by routing every path through applyMovement().)
 * ═════════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // ─── Core ledger-aware primitive ────────────────────────────────────────────

  /**
   * The single wallet write-path. Updates the wallet aggregates per the canonical
   * invariant, then writes BOTH a WalletTransaction and a PointsLedger row inside
   * the supplied transaction client. Every public mutation routes through here so
   * the passbook and the ledger can never desync.
   *
   * `points` is SIGNED (positive on credit, negative on debit). `balanceType` is
   * the WalletTransaction balance dimension the before/after pair is computed on
   * (always 'REDEEMABLE' in P5 since that is the only live balance).
   */
  private async applyMovement(
    tx: Prisma.TransactionClient,
    params: {
      wallet: { id: string; redeemablePoints: number };
      walletTxType: WalletTransactionType;
      ledgerType: PointsLedgerType;
      points: number; // signed: + credit, - debit
      balanceType?: string;
      referenceType?: string | null;
      referenceId?: string | null;
      schemeId?: string | null;
      expiresAt?: Date | null;
      description?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
      // When true on a DEBIT, decrement redeemablePoints ATOMICALLY via a guarded
      // conditional update (WHERE redeemablePoints >= magnitude) and reject if the
      // balance is insufficient — closing the read-then-write TOCTOU race (two
      // concurrent debits, or a debit racing a redemption, driving redeemable
      // negative). Opt-in so the existing floor-to-0 callers (expiry sweep) are
      // byte-unchanged; only the admin adjust DEBIT sets it today.
      requireSufficientRedeemable?: boolean;
      // Caller-specific message for the guarded-insufficient reject, so a redemption
      // race reads "for redemption" while an admin debit reads "for debit".
      insufficientMessage?: string;
    },
  ): Promise<{ transactionId: string; newRedeemable: number; ledgerId: string }> {
    const {
      wallet,
      walletTxType,
      ledgerType,
      points,
      balanceType = 'REDEEMABLE',
      referenceType = null,
      referenceId = null,
      schemeId = null,
      expiresAt = null,
      description = null,
      sourceType = null,
      sourceId = null,
      requireSufficientRedeemable = false,
      insufficientMessage = 'Insufficient wallet balance for debit',
    } = params;

    const isCredit = points > 0;
    const magnitude = Math.abs(points);
    let balanceBefore = wallet.redeemablePoints;

    // A "spendable lot" is a positive credit row of a type that represents available
    // balance (EARN / REVERSE / credit-ADJUST). Only these carry remainingPoints for
    // FIFO consume + expiry; every debit / lock row keeps the default 0.
    const isSpendableCreditLot =
      isCredit &&
      (ledgerType === PointsLedgerType.EARN ||
        ledgerType === PointsLedgerType.REVERSE ||
        ledgerType === PointsLedgerType.ADJUST);

    // Aggregate updates per the invariant. earnedPoints/lifetimeEarned are bumped
    // ONLY for true earning movements (EARN/credit-adjust/bonus), never on reversal
    // or any debit. redeemable floors at 0 on debit (never goes negative).
    const data: Prisma.WalletUpdateInput = { lastTransactionAt: new Date() };

    if (isCredit) {
      data.redeemablePoints = { increment: magnitude };
      // A REVERSE re-credits spendable balance but is NOT new earning.
      if (ledgerType !== PointsLedgerType.REVERSE) {
        data.earnedPoints = { increment: magnitude };
        data.lifetimeEarned = { increment: magnitude };
      }
    } else if (requireSufficientRedeemable) {
      // Atomic-guarded debit: decrement by the FULL magnitude (the guarded WHERE
      // below ensures redeemable >= magnitude, so this can never go negative even
      // under a concurrent debit). No flooring.
      data.redeemablePoints = { decrement: magnitude };
      if (ledgerType === PointsLedgerType.REDEEM) {
        data.redeemedPoints = { increment: magnitude };
        data.lifetimeRedeemed = { increment: magnitude };
      }
      // DEBIT_ADJUSTMENT (ledgerType ADJUST) only decrements redeemable.
    } else {
      // Floor redeemable at 0 — guards the expiry sweep against over-decrementing.
      // The outer Math.max(0, …) matters only when the balance is ALREADY NEGATIVE (e.g. a
      // legacy/migrated wallet): min(magnitude, negative) is a NEGATIVE decrement, which would
      // ADD points on a debit. Clamp to 0 → a debit never moves such a wallet up; the whole
      // magnitude is then a shortfall. For balanceBefore >= 0 this is identical to before.
      const decrement = Math.max(0, Math.min(magnitude, balanceBefore));
      data.redeemablePoints = { decrement };
      if (ledgerType === PointsLedgerType.REDEEM) {
        data.redeemedPoints = { increment: magnitude };
        data.lifetimeRedeemed = { increment: magnitude };
      } else if (ledgerType === PointsLedgerType.EXPIRE) {
        data.expiredPoints = { increment: decrement };
        data.lifetimeExpired = { increment: decrement };
      }
      // DEBIT_ADJUSTMENT (ledgerType ADJUST, debit direction) only decrements
      // redeemable — it has no dedicated running counter.
    }

    let updatedWallet: Awaited<ReturnType<typeof tx.wallet.update>>;
    if (!isCredit && requireSufficientRedeemable) {
      // Conditional update: only decrements when the CURRENT balance still covers it.
      // count===0 means a concurrent debit consumed the balance between our read and
      // this write → reject cleanly instead of going negative.
      const guarded = await tx.wallet.updateMany({
        where: { id: wallet.id, redeemablePoints: { gte: magnitude } },
        data,
      });
      if (guarded.count !== 1) {
        throw new BadRequestException(insufficientMessage);
      }
      updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      // Keep the recorded before/after pair internally consistent under concurrency.
      balanceBefore = updatedWallet.redeemablePoints + magnitude;
    } else {
      updatedWallet = await tx.wallet.update({ where: { id: wallet.id }, data });
    }

    const txRecord = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        transactionType: walletTxType,
        points,
        balanceBefore,
        balanceAfter: updatedWallet.redeemablePoints,
        balanceType,
        referenceType,
        referenceId,
        description,
      },
    });

    const ledgerRow = await tx.pointsLedger.create({
      data: {
        walletId: wallet.id,
        schemeId,
        transactionType: ledgerType,
        points,
        // Spendable credit lots start fully-remaining; everything else (debits, locks) at 0.
        remainingPoints: isSpendableCreditLot ? magnitude : 0,
        expiresAt,
        sourceType,
        sourceId,
        notes: description,
      },
    });

    // FIFO bookkeeping: a SPENDING debit (redeem / debit-adjust / clawback) consumes the
    // oldest spendable lots' remainingPoints so the lot mirror tracks the scalar. The expiry
    // sweep is EXCLUDED — it decrements the specific due lot itself (see expireDuePoints).
    // This never touches redeemablePoints (already moved above) — pure lot bookkeeping.
    if (!isCredit && ledgerType !== PointsLedgerType.EXPIRE) {
      await this.consumeFifoLots(tx, wallet.id, magnitude);
    }

    return {
      transactionId: txRecord.id,
      newRedeemable: updatedWallet.redeemablePoints,
      ledgerId: ledgerRow.id,
    };
  }

  /**
   * FIFO-consume `amount` points from the oldest spendable lots of a wallet by decrementing
   * each lot's `remainingPoints` (oldest earn first: createdAt asc, id tiebreak). Each decrement
   * is guarded (`isExpired:false AND remainingPoints >= take`) so it can't race a concurrent
   * redeem or the expiry sweep (which fences a lot by flipping isExpired first) into negative.
   *
   * Bookkeeping ONLY — the caller (applyMovement) has already moved the authoritative
   * `wallet.redeemablePoints` scalar; this just keeps the lot mirror aligned. It is tolerant of a
   * shortfall: a pre-fix wallet whose lots predate this feature has remainingPoints 0, so there is
   * nothing to consume — the scalar (guarded elsewhere) remains the source of truth for
   * sufficiency, and the mirror re-converges as new lots are earned/spent. Returns the amount
   * actually consumed from lots.
   */
  private async consumeFifoLots(
    tx: Prisma.TransactionClient,
    walletId: string,
    amount: number,
  ): Promise<number> {
    let remaining = amount;
    const lots = await tx.pointsLedger.findMany({
      where: {
        walletId,
        isExpired: false,
        remainingPoints: { gt: 0 },
        points: { gt: 0 },
        transactionType: {
          in: [
            PointsLedgerType.EARN,
            PointsLedgerType.REVERSE,
            PointsLedgerType.ADJUST,
          ],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(lot.remainingPoints, remaining);
      // Guarded decrement: only when the lot is still unexpired and still holds >= take.
      // count 0 ⇒ a concurrent movement changed it; skip and let the scalar guard govern.
      const res = await tx.pointsLedger.updateMany({
        where: { id: lot.id, isExpired: false, remainingPoints: { gte: take } },
        data: { remainingPoints: { decrement: take } },
      });
      if (res.count === 1) remaining -= take;
    }
    return amount - remaining;
  }

  /** Run `fn` inside the supplied tx, or open a fresh $transaction if none given. */
  private withTx<T>(
    tx: Prisma.TransactionClient | undefined,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (tx) return fn(tx);
    return this.prisma.$transaction((inner) => fn(inner));
  }

  /** Load a partner's wallet inside a tx; throws NotFound if absent. */
  private async requireWallet(tx: Prisma.TransactionClient, partnerId: string) {
    const wallet = await tx.wallet.findFirst({ where: { partnerId } });
    if (!wallet) throw new NotFoundException('Wallet not found for this partner');
    return wallet;
  }

  /**
   * Resolve the active expiry config for a credit and compute its expiresAt.
   * Rule: prefer the scheme-specific active config when a schemeId is supplied and
   * a matching `{ schemeId, isActive: true }` row exists; otherwise fall back to the
   * client's `{ isDefault: true, isActive: true }` config. If neither exists →
   * null (no expiry). expiresAt = now + expiryDays.
   */
  private async resolveExpiresAt(
    tx: Prisma.TransactionClient,
    clientId: string,
    schemeId?: string | null,
  ): Promise<Date | null> {
    let config: Awaited<ReturnType<typeof tx.pointExpiryConfig.findFirst>> = null;
    if (schemeId) {
      config = await tx.pointExpiryConfig.findFirst({
        where: { clientId, schemeId, isActive: true },
      });
    }
    if (!config) {
      config = await tx.pointExpiryConfig.findFirst({
        where: { clientId, isDefault: true, isActive: true },
      });
    }
    if (!config) return null;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + config.expiryDays);
    return expiresAt;
  }

  // ─── Public read paths ──────────────────────────────────────────────────────

  /** The zeroed wallet summary (no partner / no wallet row yet). Carries the tenant rate. */
  private zeroedSummary(conversionRate: number) {
    return {
      earnedPoints: 0,
      lockedPoints: 0,
      redeemablePoints: 0,
      redeemedPoints: 0,
      expiredPoints: 0,
      lifetimeEarned: 0,
      lifetimeRedeemed: 0,
      lifetimeExpired: 0,
      currency: 'POINTS',
      conversionRate,
    };
  }

  /**
   * SHARED wallet-summary builder — the single source of truth for the summary shape,
   * used by BOTH the partner-facing getWallet and the GIFSY admin outlet route so the
   * two can never diverge. Resolves the per-tenant points→₹ rate, loads the partner's
   * wallet, and returns the summary (zeroed — but still rate-carrying — when absent).
   * Tenant scope / partner authorization is the CALLER's responsibility.
   */
  private async loadWalletSummary(partnerId: string, clientId: string) {
    const conversionRate = await this.tenantSettings.getConversionRate(clientId);
    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId } });
    if (!wallet) return this.zeroedSummary(conversionRate);

    return {
      earnedPoints: wallet.earnedPoints,
      lockedPoints: wallet.lockedPoints,
      redeemablePoints: wallet.redeemablePoints,
      redeemedPoints: wallet.redeemedPoints,
      expiredPoints: wallet.expiredPoints,
      lifetimeEarned: wallet.lifetimeEarned,
      lifetimeRedeemed: wallet.lifetimeRedeemed,
      lifetimeExpired: wallet.lifetimeExpired,
      currency: 'POINTS',
      conversionRate,
    };
  }

  /** GET /v1/wallet — the ACTIVE partner's wallet summary (zeros if no partner/wallet). */
  async getWallet(user: JwtPayload, requestedPartnerId?: string) {
    // Wave 3: resolve the ACTIVE partner (own, or an authorized switched-to sibling). The selector is
    // re-authorized here — a forged/foreign id can NEVER surface another partner's wallet balance.
    const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!partnerId) {
      // No operable partner → graceful zeros (unchanged), still carrying the tenant rate.
      const conversionRate = await this.tenantSettings.getConversionRate(user.clientId);
      return this.zeroedSummary(conversionRate);
    }

    return this.loadWalletSummary(partnerId, user.clientId);
  }

  /**
   * SHARED passbook builder — the single source of truth for the paginated passbook,
   * used by BOTH the partner-facing listTransactions and the GIFSY admin outlet route
   * so the two can never diverge. Includes the CREDIT_BATCH field-name resolution.
   * Tenant scope / partner authorization is the CALLER's responsibility.
   */
  private async loadPassbook(
    partnerId: string,
    clientId: string,
    q: { page?: number; limit?: number; type?: WalletTransactionType },
    // When the caller already knows the exact outlet in context (the GIFSY admin route
    // resolves it by code), pass it so CREDIT_BATCH field-name resolution replays THAT
    // outlet's rows — not the partner's primary outlet. Omitted (partner path) → derive
    // the primary as before.
    knownOutletCode?: string,
  ) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const emptyResult = {
      transactions: [],
      pagination: { page, limit, total: 0, pages: 0 },
    };

    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId },
    });
    if (!wallet) return emptyResult;

    const where: Prisma.WalletTransactionWhereInput = { walletId: wallet.id };
    if (q.type) where.transactionType = q.type;

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    // ── Resolve the credit FIELD NAME for CREDIT_BATCH rows on this page ──────────
    // WalletTransaction stores the batch id + narration, not the field name; the
    // shared resolver replays the batch `rows` JSON read-time. Because this endpoint
    // is PAGINATED, resolving over ONLY the page could mis-map when a batch straddles
    // a page boundary (consumption order would be wrong). So we resolve over ALL of
    // this wallet's CREDIT_BATCH txns (a separate lightweight query), then apply the
    // Map to the page → pagination-robust, page boundaries can never mis-map.
    let outletCode = knownOutletCode ?? '';
    if (!knownOutletCode) {
      const outlet = await this.prisma.outlet.findFirst({
        where: { clientId, partnerId, deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: { outletCode: true },
      });
      outletCode = outlet?.outletCode ?? '';
    }

    const allCreditTxns = await this.prisma.walletTransaction.findMany({
      where: { walletId: wallet.id, referenceType: 'CREDIT_BATCH' },
      select: {
        id: true,
        referenceType: true,
        referenceId: true,
        description: true,
        points: true,
        createdAt: true,
      },
    });
    const fieldNameByTxId = await resolveCreditFieldNames(
      this.prisma,
      clientId,
      outletCode,
      allCreditTxns,
    );

    const passbook = transactions.map((t) => ({
      id: t.id,
      transactionType: t.transactionType,
      description: t.description ?? this.getDefaultDescription(t.transactionType),
      points: t.points,
      date: t.createdAt,
      balanceType: t.balanceType,
      balanceAfter: t.balanceAfter,
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      // Credit rows resolve to their batch field name; everything else is null.
      fieldName: fieldNameByTxId.get(t.id) ?? null,
      // RAW upload narration (BEFORE the getDefaultDescription fallback) — null/empty
      // when the upload carried no narration, so the FE only shows a real note.
      narration: t.description,
    }));

    return {
      transactions: passbook,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** GET /v1/wallet/transactions — paginated passbook for the caller's ACTIVE partner. */
  async listTransactions(user: JwtPayload, q: ListTransactionsQueryDto, requestedPartnerId?: string) {
    // Resolve the ACTIVE partner from the login-picker selector (own, or an authorized
    // same-group same-phone sibling), re-authorized so a forged header can't reach another passbook.
    const active = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (active.forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!active.partnerId) {
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      return { transactions: [], pagination: { page, limit, total: 0, pages: 0 } };
    }

    return this.loadPassbook(active.partnerId, user.clientId, q);
  }

  /**
   * GET /v1/wallet/statement — the caller's ACTIVE partner's FULL, UNPAGINATED points statement
   * (oldest first) for an optional IST month range, with the STORED per-row balances and the
   * opening/closing balance (owner decision D3). Built by the shared loader the sales ledger also
   * uses, so the two can never drift. Same access boundary as the passbook (forged selector →
   * 403). No partner / no wallet yet (pre-KYC) → an empty zero statement, not a 404.
   */
  async statement(user: JwtPayload, q: StatementQueryDto, requestedPartnerId?: string) {
    const active = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (active.forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!active.partnerId) return { ...EMPTY_STATEMENT, rows: [] };

    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId: active.partnerId } });
    if (!wallet) return { ...EMPTY_STATEMENT, rows: [] };

    const outlet = await this.prisma.outlet.findFirst({
      where: { clientId: user.clientId, partnerId: active.partnerId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { outletCode: true },
    });

    return buildStatementResponse(this.prisma, this.logger, {
      wallet,
      clientId: user.clientId,
      outletCode: outlet?.outletCode ?? '',
      from: q.from,
      to: q.to,
    });
  }

  /**
   * GET /v1/wallet/points-credited?month=YYYY-MM — total points CREDITED (earned) to the caller's
   * ACTIVE partner wallet during the IST calendar month `monthKey`.
   *
   * WHY a dedicated aggregate (not the passbook): /wallet/transactions is PAGINATED (page 1,
   * limit 20, newest-first). For an active wholesaler with months of credits + a daily expiry
   * sweep, last month's earn credit sits far past page 1, so summing the first page would under-
   * report (often to 0). This sums server-side over the WHOLE month window via a DB aggregate, so
   * it is correct at any scale and never fetches more than one row's worth of data to the client.
   *
   * WHAT counts as "credited": the genuine EARN credits — CREDIT_POINTS_EARNED, CREDIT_BONUS and
   * CREDIT_ADJUSTMENT (the credit types that bump lifetimeEarned per the wallet invariant above).
   * CREDIT_REVERSAL is EXCLUDED: it re-credits redeemable points from a reversed redemption but is
   * NOT new earning, so it must not inflate a "reward credited last month" figure.
   *
   * Tenant- + partner-scoped via the same login-picker access boundary as the passbook. Returns
   * { month, points } with points 0 when the caller has no operable partner / no wallet / no
   * credits in that month. Additive read-only — no existing behaviour changes.
   */
  async pointsCreditedInMonth(user: JwtPayload, monthKey: string, requestedPartnerId?: string) {
    if (!/^\d{4}-\d{2}$/.test(monthKey ?? '')) {
      throw new BadRequestException('month must be a YYYY-MM value');
    }

    const active = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (active.forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!active.partnerId) return { month: monthKey, points: 0 };

    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId: active.partnerId },
      select: { id: true },
    });
    if (!wallet) return { month: monthKey, points: 0 };

    const { start, endExclusive } = istMonthBounds(monthKey);
    const agg = await this.prisma.walletTransaction.aggregate({
      _sum: { points: true },
      where: {
        walletId: wallet.id,
        transactionType: {
          in: [
            WalletTransactionType.CREDIT_POINTS_EARNED,
            WalletTransactionType.CREDIT_BONUS,
            WalletTransactionType.CREDIT_ADJUSTMENT,
          ],
        },
        createdAt: { gte: start, lt: endExclusive },
      },
    });

    return { month: monthKey, points: agg._sum.points ?? 0 };
  }

  // ─── GIFSY-only admin: wallet BY OUTLET ─────────────────────────────────────
  //
  // Support/ops tooling: a GIFSY operator (optionally assumed into a tenant) inspects
  // ANY outlet's wallet by outlet CODE. Tenant scope is user.clientId — a foreign-tenant
  // outlet code 404s (never surfaces another tenant's wallet). `Outlet` has a
  // @@unique([clientId, outletCode]) so the (tenant, code) lookup is unique. A pre-KYC
  // outlet with no partner yet (partnerId null) has no wallet → zeroed summary / empty page.

  /**
   * Resolve an outlet by CODE within the operator's tenant. 404s a foreign-tenant /
   * missing / soft-deleted outlet — this tenant-scope invariant must not be widened.
   * `partnerId` may be null (an outlet created pre-KYC has no ChannelPartner / wallet yet).
   */
  private async resolveAdminOutlet(user: JwtPayload, outletCode: string) {
    const outlet = await this.prisma.outlet.findFirst({
      where: { clientId: user.clientId, outletCode, deletedAt: null },
      select: { outletCode: true, name: true, ownerName: true, partnerId: true },
    });
    if (!outlet) throw new NotFoundException('Outlet not found in this tenant.');
    return {
      outlet: { outletCode: outlet.outletCode, name: outlet.name, ownerName: outlet.ownerName },
      partnerId: outlet.partnerId,
    };
  }

  /** GET /v1/wallet/admin/outlet/:outletCode/summary — GIFSY-only wallet summary by outlet code. */
  async adminOutletWallet(user: JwtPayload, outletCode: string) {
    const { outlet, partnerId } = await this.resolveAdminOutlet(user, outletCode);
    if (!partnerId) {
      // Pre-KYC outlet: no partner/wallet yet → zeroed summary (still carries the tenant rate).
      const conversionRate = await this.tenantSettings.getConversionRate(user.clientId);
      return { outlet, partnerId: null, hasWallet: false, wallet: this.zeroedSummary(conversionRate) };
    }
    return {
      outlet,
      partnerId,
      hasWallet: true,
      wallet: await this.loadWalletSummary(partnerId, user.clientId),
    };
  }

  /** GET /v1/wallet/admin/outlet/:outletCode/transactions — GIFSY-only passbook by outlet code. */
  async adminOutletTransactions(
    user: JwtPayload,
    outletCode: string,
    q: { page?: number; limit?: number; type?: WalletTransactionType },
  ) {
    const { outlet, partnerId } = await this.resolveAdminOutlet(user, outletCode);
    if (!partnerId) {
      // Pre-KYC outlet: no partner/wallet yet → empty page.
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      return { transactions: [], pagination: { page, limit, total: 0, pages: 0 } };
    }
    // Resolve credit field-names against THIS outlet's rows (the one the admin selected),
    // not the partner's primary outlet.
    return this.loadPassbook(partnerId, user.clientId, q, outlet.outletCode);
  }

  // ─── Core mutations (composable: pass `tx` to compose inside a caller's $transaction) ─

  /**
   * Credit earned points (CREDIT_POINTS_EARNED / ledger EARN). The primitive that
   * P6 credits + 5.4 refunds reuse. Stamps expiresAt from the active
   * PointExpiryConfig (see resolveExpiresAt). Points land directly in
   * redeemablePoints (holding deferred). `clientId` is needed to resolve the
   * tenant's expiry config.
   *
   * NOTE: tenant scope on `partnerId` is the CALLER's responsibility (this is an
   * internal primitive, not a user-facing route). adjust() does the wrong-tenant
   * check before delegating to applyMovement directly.
   */
  async creditEarn(
    partnerId: string,
    clientId: string,
    amount: number,
    opts: {
      schemeId?: string | null;
      referenceType?: string | null;
      referenceId?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
      description?: string | null;
    } = {},
    tx?: Prisma.TransactionClient,
  ) {
    if (amount <= 0) throw new BadRequestException('Credit amount must be positive');

    return this.withTx(tx, async (t) => {
      const wallet = await this.requireWallet(t, partnerId);
      const expiresAt = await this.resolveExpiresAt(t, clientId, opts.schemeId ?? null);
      return this.applyMovement(t, {
        wallet,
        walletTxType: 'CREDIT_POINTS_EARNED',
        ledgerType: PointsLedgerType.EARN,
        points: amount,
        schemeId: opts.schemeId ?? null,
        expiresAt,
        referenceType: opts.referenceType ?? null,
        referenceId: opts.referenceId ?? null,
        sourceType: opts.sourceType ?? null,
        sourceId: opts.sourceId ?? null,
        description: opts.description ?? null,
      });
    });
  }

  /**
   * Debit redeemable points for a redemption (DEBIT_REDEMPTION / ledger REDEEM).
   * Throws BadRequest (400) when redeemablePoints < amount. Used by 5.4 redeem.
   *
   * The pre-check below is a fast reject; the actual decrement is ATOMICALLY GUARDED
   * (requireSufficientRedeemable) so two concurrent redemptions (or a redemption racing
   * an admin debit) on the same wallet can never both pass the check and drive the
   * balance negative — the loser's guarded update matches 0 rows and rejects cleanly.
   */
  async debitRedeem(
    partnerId: string,
    amount: number,
    opts: { referenceId?: string | null; description?: string | null } = {},
    tx?: Prisma.TransactionClient,
  ) {
    if (amount <= 0) throw new BadRequestException('Redeem amount must be positive');

    return this.withTx(tx, async (t) => {
      const wallet = await this.requireWallet(t, partnerId);
      if (wallet.redeemablePoints < amount) {
        throw new BadRequestException('Insufficient wallet balance for redemption');
      }
      return this.applyMovement(t, {
        wallet,
        walletTxType: 'DEBIT_REDEMPTION',
        ledgerType: PointsLedgerType.REDEEM,
        points: -amount,
        referenceType: 'REDEMPTION_ORDER',
        referenceId: opts.referenceId ?? null,
        description: opts.description ?? null,
        // Close the TOCTOU: decrement only if the CURRENT balance still covers it.
        requireSufficientRedeemable: true,
        insufficientMessage: 'Insufficient wallet balance for redemption',
      });
    });
  }

  /**
   * Re-credit points (CREDIT_REVERSAL / ledger REVERSE) — used by 5.4
   * refund-on-cancel/return and P6 reversal. Increments redeemablePoints but does
   * NOT bump earnedPoints/lifetimeEarned: a reversal restores previously-spent
   * points, it is not new earning (keeping lifetimeEarned monotonic + truthful).
   */
  async reverse(
    partnerId: string,
    amount: number,
    opts: { referenceId?: string | null; description?: string | null } = {},
    tx?: Prisma.TransactionClient,
  ) {
    if (amount <= 0) throw new BadRequestException('Reversal amount must be positive');

    return this.withTx(tx, async (t) => {
      const wallet = await this.requireWallet(t, partnerId);
      // A reversed/refunded redemption becomes a fresh spendable lot with a FRESH expiry
      // window (owner-confirmed): restored points are re-dated per the tenant's current
      // expiry config, so the REVERSE lot is expirable like any other credit lot.
      const partner = await t.channelPartner.findFirst({
        where: { id: partnerId },
        select: { clientId: true },
      });
      const expiresAt = partner
        ? await this.resolveExpiresAt(t, partner.clientId, null)
        : null;
      return this.applyMovement(t, {
        wallet,
        walletTxType: 'CREDIT_REVERSAL',
        ledgerType: PointsLedgerType.REVERSE,
        points: amount,
        expiresAt,
        referenceType: 'REDEMPTION_ORDER',
        referenceId: opts.referenceId ?? null,
        description: opts.description ?? null,
      });
    });
  }

  /** POST /v1/wallet/adjust — GIFSY-only manual credit/debit on a partner wallet. */
  async adjust(user: JwtPayload, dto: AdjustWalletDto) {
    // GIFSY-only is enforced by @Roles on the controller; tenant scope checked here.
    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId: dto.partnerId, partner: { user: { clientId: user.clientId } } },
    });
    if (!wallet) throw new NotFoundException('Wallet not found for this partner');

    const isCredit = dto.type === AdjustType.CREDIT;
    if (!isCredit && wallet.redeemablePoints < dto.amount) {
      throw new BadRequestException('Insufficient wallet balance for debit');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // A manual CREDIT is treated as earning → create an expirable spendable lot with a
      // fresh expiry window (like EARN). A DEBIT carries no expiry and FIFO-consumes lots.
      const expiresAt = isCredit
        ? await this.resolveExpiresAt(tx, user.clientId, null)
        : null;
      // Route through the single write-path: writes WalletTransaction AND
      // PointsLedger (ADJUST). On debit this decrements redeemablePoints ONLY —
      // it no longer decrements earnedPoints/lifetimeEarned (bug #1 fixed).
      const movement = await this.applyMovement(tx, {
        wallet,
        walletTxType: isCredit ? 'CREDIT_ADJUSTMENT' : 'DEBIT_ADJUSTMENT',
        ledgerType: PointsLedgerType.ADJUST,
        points: isCredit ? dto.amount : -dto.amount,
        expiresAt,
        description: `Manual ${dto.type.toLowerCase()} by admin. Reason: ${dto.reason}`,
        sourceType: 'ADMIN_ADJUSTMENT',
        sourceId: user.sub,
        // Atomic-guarded debit: the pre-tx check above is a fast UX reject; this closes
        // the TOCTOU so a concurrent redemption can't drive redeemable negative.
        requireSufficientRedeemable: !isCredit,
      });

      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'WALLET',
          entityId: wallet.id,
          actorId: user.sub,
          metadata: {
            partnerId: dto.partnerId,
            amount: dto.amount,
            type: dto.type,
            reason: dto.reason,
            approvedBy: dto.approvedBy,
            transactionId: movement.transactionId,
          },
        },
      });

      return movement;
    });

    return {
      transactionId: result.transactionId,
      newBalance: result.newRedeemable,
    };
  }

  /**
   * Clawback previously-earned points on a credit-batch POINTS reversal (#16).
   * Writes DEBIT_ADJUSTMENT (WalletTransaction) + ADJUST (PointsLedger), inside the
   * supplied transaction so it is atomic with the reversal status update.
   *
   * Invariant-aware decrement rules:
   *  - redeemablePoints: decremented by max(0, min(points, redeemablePoints)) — CLAMPED at 0,
   *    and an already-NEGATIVE balance is left unchanged (never raised by a debit; the whole
   *    amount is the shortfall).
   *    If the partner has already redeemed some of the awarded points, redeemablePoints
   *    may be < points. We clamp rather than throw so the reversal still lands; the
   *    shortfall is recorded in the ledger description for owner review.
   *  - earnedPoints / lifetimeEarned / lifetimeRedeemed / lifetimeExpired: UNTOUCHED.
   *    Every lifetime* counter AND earnedPoints are monotonic (the locked-wallet invariant):
   *    a clawback only reduces the spendable balance, exactly like a DEBIT_ADJUSTMENT.
   *
   * ⚠️  OWNER REVIEW FLAG — partial-redemption shortfall:
   *   When redeemablePoints < points only the available part is removed from the balance,
   *   but the PointsLedger/WalletTransaction row still records the FULL `-points` (with the
   *   `shortfall` appended to the description, so it is visible in the passbook). That is
   *   deliberate — it records the client's full reversal of points the partner had already
   *   spent — but it means the ledger row intentionally debits more than the scalar moved,
   *   so a balance reconstructed purely from ledger `points` can trail the true scalar for
   *   such a wallet (the authoritative balance is always wallet.redeemablePoints). A future
   *   enhancement could write a compensating debit against future credits or flag the account.
   *   Do NOT silently ignore this — a cash settlement may be needed out-of-band.
   *
   * NOTE: this routes through applyMovement's floored-debit path (redeemable decrements by
   * max(0, min(magnitude, balance)); no lifetime/earned counter moves). The read of redeemablePoints
   * below is only to derive `shortfall` for the description — not a second balance write.
   */
  async clawbackAward(
    partnerId: string,
    points: number,
    opts: {
      referenceType?: string | null;
      referenceId?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
      description?: string | null;
    } = {},
    tx: Prisma.TransactionClient,
  ): Promise<{ transactionId: string; newRedeemable: number; ledgerId: string; shortfall: number }> {
    if (points <= 0) throw new BadRequestException('Clawback amount must be positive');

    const wallet = await tx.wallet.findFirst({ where: { partnerId } });
    if (!wallet) throw new NotFoundException('Wallet not found for this partner');

    // A clawback reduces ONLY the spendable balance (redeemablePoints) — exactly like
    // a DEBIT_ADJUSTMENT. earnedPoints and every lifetime* counter are MONOTONIC and
    // are NEVER decremented (the locked wallet invariant): the wallet still records
    // that the points were earned; the reversal shows up as redeemablePoints dropping
    // plus a DEBIT_ADJUSTMENT ledger entry. applyMovement floors redeemable at 0.
    // Must mirror applyMovement's floored decrement exactly (incl. the Math.max(0, …) clamp for
    // an already-negative wallet, where NOTHING is removed and the whole amount is shortfall).
    const redeemableDecrement = Math.max(0, Math.min(points, wallet.redeemablePoints));
    const shortfall = points - redeemableDecrement;

    let desc = opts.description ?? `Clawback: credit batch POINTS reversal`;
    if (shortfall > 0) {
      desc +=
        wallet.redeemablePoints < 0
          ? ` [SHORTFALL: ${shortfall} pts not recovered — wallet balance already negative (${wallet.redeemablePoints}) — owner review required]`
          : ` [SHORTFALL: ${shortfall} pts already redeemed — owner review required]`;
    }

    const movement = await this.applyMovement(tx, {
      wallet,
      walletTxType: 'DEBIT_ADJUSTMENT',
      ledgerType: PointsLedgerType.ADJUST,
      // passing -points is correct: applyMovement's internal decrement = max(0, min(magnitude, redeemableBefore))
      points: -points,
      referenceType: opts.referenceType ?? null,
      referenceId: opts.referenceId ?? null,
      sourceType: opts.sourceType ?? null,
      sourceId: opts.sourceId ?? null,
      description: desc,
    });

    return { ...movement, shortfall };
  }

  // ─── Expiry sweep ────────────────────────────────────────────────────────────

  /**
   * Expire due points. Finds SPENDABLE lots (EARN / REVERSE / credit-ADJUST) that are past
   * their expiresAt, still hold unspent `remainingPoints`, and are not yet expired. For each,
   * expires only the lot's REMAINING (unspent) points — never the lot's original amount — so
   * FIFO redemption of an older lot can never cause a newer lot's valid points to be destroyed.
   *
   * Per lot it: (1) claims the lot by flipping isExpired false→true (fencing it off from any
   * concurrent redeem FIFO-consume), (2) reads the now-frozen remainingPoints, (3) zeroes the
   * lot's remainingPoints and writes a DEBIT_EXPIRY / ledger EXPIRE movement for exactly that
   * amount (decrementing redeemablePoints, floored at 0; bumping expiredPoints + lifetimeExpired).
   *
   * Idempotent + concurrency-safe: the isExpired claim admits only one sweep; a fully-redeemed
   * lot (remainingPoints 0) is marked expired with no balance move and no EXPIRE row.
   *
   * @returns a summary of what was swept (counts + total points expired).
   */
  async expireDuePoints(opts: { now?: Date; limit?: number } = {}) {
    const now = opts.now ?? new Date();
    const take = opts.limit ?? 1000;

    const dueLots = await this.prisma.pointsLedger.findMany({
      where: {
        transactionType: {
          in: [
            PointsLedgerType.EARN,
            PointsLedgerType.REVERSE,
            PointsLedgerType.ADJUST,
          ],
        },
        isExpired: false,
        points: { gt: 0 },
        remainingPoints: { gt: 0 },
        expiresAt: { lte: now },
      },
      orderBy: { expiresAt: 'asc' },
      take,
    });

    if (dueLots.length === 0) {
      return { expiredLots: 0, expiredPoints: 0 };
    }

    let expiredLots = 0;
    let totalExpired = 0;

    for (const lot of dueLots) {
      await this.prisma.$transaction(async (tx) => {
        // 0) LOCK THE WALLET ROW FIRST — before claiming the lot. A redeem locks the wallet
        //    (guarded scalar update) THEN its lots; by taking the wallet lock first the sweep
        //    acquires locks in the SAME order (wallet → lot), so the two can never deadlock.
        //    It also pins the scalar: nothing can change redeemablePoints between our read and
        //    our decrement below, so the floor is exact and the balance can never go negative.
        await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${lot.walletId} FOR UPDATE`;

        // 1) CLAIM the lot by flipping isExpired false→true. Makes re-runs concurrency-safe
        //    (a second sweep sees count 0 and skips) AND fences the lot from any concurrent
        //    redeem (consumeFifoLots only touches isExpired:false lots).
        const claim = await tx.pointsLedger.updateMany({
          where: { id: lot.id, isExpired: false },
          data: { isExpired: true },
        });
        if (claim.count === 0) return;

        // 2) Read the now-frozen remaining and the (locked) wallet.
        const fresh = await tx.pointsLedger.findUnique({ where: { id: lot.id } });
        const remaining = fresh?.remainingPoints ?? 0;
        if (remaining > 0) {
          // The lot is expired → zero its remaining regardless of how much is still backed.
          await tx.pointsLedger.update({ where: { id: lot.id }, data: { remainingPoints: 0 } });
        }
        const wallet = await tx.wallet.findFirst({ where: { id: lot.walletId } });
        if (!wallet) return;

        // 3) Expire only what the locked scalar actually still backs for this lot — never
        //    more. Aligned wallet: remaining <= scalar → expire = remaining. Transiently
        //    drifted wallet (Σremaining > scalar from a concurrent-redeem race): clamp to the
        //    scalar so we neither go negative nor write a phantom EXPIRE row the balance can't
        //    back. applyMovement does NOT FIFO-consume on EXPIRE, so no other lot is touched.
        const expire = Math.min(remaining, wallet.redeemablePoints);
        if (expire <= 0) return; // fully redeemed before expiry — nothing to expire

        await this.applyMovement(tx, {
          wallet,
          walletTxType: 'DEBIT_EXPIRY',
          ledgerType: PointsLedgerType.EXPIRE,
          points: -expire,
          schemeId: lot.schemeId,
          referenceType: 'POINTS_LEDGER',
          referenceId: lot.id,
          sourceType: 'EXPIRY_SWEEP',
          sourceId: lot.id,
          description: 'Points expired',
        });
        expiredLots += 1;
        totalExpired += expire;
      });
    }

    return { expiredLots, expiredPoints: totalExpired };
  }

  private getDefaultDescription(transactionType: string): string {
    // Shared with the statement builder so the passbook and statement can't drift.
    return defaultTxDescription(transactionType);
  }
}
