import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PointsLedgerType, WalletTransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveCreditFieldNames } from '../common/credit-field-name.helper';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { AdjustType, AdjustWalletDto, ListTransactionsQueryDto } from './dto/wallet.dto';

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
    } = params;

    const isCredit = points > 0;
    const magnitude = Math.abs(points);
    let balanceBefore = wallet.redeemablePoints;

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
      const decrement = Math.min(magnitude, balanceBefore);
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
        throw new BadRequestException('Insufficient wallet balance for debit');
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
        expiresAt,
        sourceType,
        sourceId,
        notes: description,
      },
    });

    return {
      transactionId: txRecord.id,
      newRedeemable: updatedWallet.redeemablePoints,
      ledgerId: ledgerRow.id,
    };
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
    const outlet = await this.prisma.outlet.findFirst({
      where: { clientId, partnerId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { outletCode: true },
    });
    const outletCode = outlet?.outletCode ?? '';

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
    const { partnerId } = await this.resolveAdminOutlet(user, outletCode);
    if (!partnerId) {
      // Pre-KYC outlet: no partner/wallet yet → empty page.
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      return { transactions: [], pagination: { page, limit, total: 0, pages: 0 } };
    }
    return this.loadPassbook(partnerId, user.clientId, q);
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
      return this.applyMovement(t, {
        wallet,
        walletTxType: 'CREDIT_REVERSAL',
        ledgerType: PointsLedgerType.REVERSE,
        points: amount,
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
      // Route through the single write-path: writes WalletTransaction AND
      // PointsLedger (ADJUST). On debit this decrements redeemablePoints ONLY —
      // it no longer decrements earnedPoints/lifetimeEarned (bug #1 fixed).
      const movement = await this.applyMovement(tx, {
        wallet,
        walletTxType: isCredit ? 'CREDIT_ADJUSTMENT' : 'DEBIT_ADJUSTMENT',
        ledgerType: PointsLedgerType.ADJUST,
        points: isCredit ? dto.amount : -dto.amount,
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
   *  - earnedPoints: decremented by `points` (the full approved amount).
   *  - redeemablePoints: decremented by min(points, redeemablePoints) — CLAMPED at 0.
   *    If the partner has already redeemed some of the awarded points, redeemablePoints
   *    may be < points. We clamp rather than throw so the reversal still lands; the
   *    shortfall is recorded in the ledger description for owner review.
   *  - lifetimeEarned / lifetimeRedeemed / lifetimeExpired: UNTOUCHED (monotonic).
   *
   * ⚠️  OWNER REVIEW FLAG — partial-redemption shortfall:
   *   When redeemablePoints < points the full earnedPoints decrement still fires but
   *   only partial redeemable is removed. The delta (`shortfall`) is appended to the
   *   description so it is visible in the passbook. A future enhancement could write
   *   a compensating debit against future credits or flag the partner account.
   *   Do NOT silently ignore this — it means the client credited points that the
   *   partner already spent, and a cash settlement may be needed out-of-band.
   *
   * NOTE: applyMovement does NOT decrement earnedPoints (by design — it only touches
   * redeemable + ledger/expiry counters). We therefore do the earnedPoints decrement
   * here as a separate wallet.update BEFORE calling applyMovement, so both writes
   * happen inside the same tx and can never desync.
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
    const redeemableDecrement = Math.min(points, wallet.redeemablePoints);
    const shortfall = points - redeemableDecrement;

    let desc = opts.description ?? `Clawback: credit batch POINTS reversal`;
    if (shortfall > 0) {
      desc += ` [SHORTFALL: ${shortfall} pts already redeemed — owner review required]`;
    }

    const movement = await this.applyMovement(tx, {
      wallet,
      walletTxType: 'DEBIT_ADJUSTMENT',
      ledgerType: PointsLedgerType.ADJUST,
      // passing -points is correct: applyMovement's internal decrement = min(magnitude, redeemableBefore)
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
   * Expire due points. Finds EARN ledger lots that are past their expiresAt and
   * not yet expired, and for each writes a DEBIT_EXPIRY / ledger EXPIRE movement,
   * decrementing redeemablePoints (floored at 0), bumping expiredPoints +
   * lifetimeExpired, and marking the source EARN lot isExpired = true.
   *
   * Idempotent + safe to re-run: a lot is only swept once (isExpired guard), and
   * the redeemable decrement floors at 0 so over-expiry can never drive the balance
   * negative. No cron here — scheduling is DEFERRED to P7/infra; this is exposed as
   * a GIFSY-triggerable method/endpoint so it can be run manually or by a future job.
   *
   * @returns a summary of what was swept (counts + total points expired).
   */
  async expireDuePoints(opts: { now?: Date; limit?: number } = {}) {
    const now = opts.now ?? new Date();
    const take = opts.limit ?? 1000;

    const dueLots = await this.prisma.pointsLedger.findMany({
      where: {
        transactionType: PointsLedgerType.EARN,
        isExpired: false,
        points: { gt: 0 },
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
        // Claim the lot with a GUARDED update: only the run that flips isExpired
        // false→true proceeds. A concurrent sweep (manual double-trigger or a future
        // cron overlap) sees count 0 here and skips — this is what makes re-runs
        // concurrency-safe, not just single-threaded-idempotent.
        const claim = await tx.pointsLedger.updateMany({
          where: { id: lot.id, isExpired: false },
          data: { isExpired: true },
        });
        if (claim.count === 0) return false;

        // Re-read the wallet inside the tx so the redeemable floor is consistent.
        const wallet = await tx.wallet.findFirst({ where: { id: lot.walletId } });
        if (!wallet) return false;

        // Expire only the portion still available in the spendable balance — never
        // more than what the lot granted, never more than redeemable holds. If the
        // lot's points were already redeemed (expirable === 0) the lot is still
        // marked consumed above, but no balance moves and no movement row is written.
        const expirable = Math.min(lot.points, wallet.redeemablePoints);

        if (expirable > 0) {
          await this.applyMovement(tx, {
            wallet,
            walletTxType: 'DEBIT_EXPIRY',
            ledgerType: PointsLedgerType.EXPIRE,
            points: -expirable,
            schemeId: lot.schemeId,
            referenceType: 'POINTS_LEDGER',
            referenceId: lot.id,
            sourceType: 'EXPIRY_SWEEP',
            sourceId: lot.id,
            description: 'Points expired',
          });
          expiredLots += 1;
          totalExpired += expirable;
        }
      });
    }

    return { expiredLots, expiredPoints: totalExpired };
  }

  private getDefaultDescription(transactionType: string): string {
    const map: Record<string, string> = {
      CREDIT_POINTS_EARNED: 'Points earned',
      CREDIT_BONUS: 'Bonus points credited',
      CREDIT_REVERSAL: 'Points reversed to wallet',
      CREDIT_ADJUSTMENT: 'Manual credit adjustment',
      DEBIT_REDEMPTION: 'Points redeemed',
      DEBIT_EXPIRY: 'Points expired',
      DEBIT_ADJUSTMENT: 'Manual debit adjustment',
      LOCK_HOLDING: 'Points locked',
      UNLOCK_HOLDING: 'Points unlocked',
    };
    return map[transactionType] ?? 'Wallet transaction';
  }
}
