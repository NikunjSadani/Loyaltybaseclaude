import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WHATSAPP_KYC } from '../notifications/whatsapp-kyc.config';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { paiseToRupees, toPaiseBigInt } from '../common/money';
import {
  resolveEffectiveKycStatus,
  isPartnerPayable,
} from '../kyc/kyc-eligibility';
import {
  CreateBatchDto,
  CreateFieldDto,
  CreatePayoutDownloadDto,
  CreateReversalDto,
  FieldAction,
  FieldAwardValue,
  ListBatchesQueryDto,
  ListFieldsQueryDto,
  ListPayoutDownloadsQueryDto,
  ListReversalsQueryDto,
  PatchFieldDto,
  PatchReversalDto,
  PayoutGroupType,
  ReversalAction,
} from './dto/credits.dto';
import {
  generatePayoutFileBuffer,
  parseUtrUpload,
  PayoutBatch,
  PayoutBatchRow,
} from './credits.helpers';

/**
 * Awards & Credits (§12a) — ported from platform/src/app/api/admin/credits/*
 * onto /v1/admin/credits. This is the REAL parameter-upload credit model:
 * CreditBatch (uploaded rows) → confirm → CreditPayoutEntry → payout download
 * (bank file) → UTR upload (mark paid) → reversals (maker-checker).
 *
 * Every query is tenant-scoped by `clientId` (from the session-bound JWT). The
 * source role gates (CLIENT_ADMIN + GIFSY_ADMIN, or GIFSY_ADMIN-only) are
 * enforced by @Roles on the controller and the RBAC permission keys by
 * @RequirePermission. The pure parser/generator logic lives in
 * credits.helpers.ts; notifications go through the foundation NotificationsService
 * (the source's MSG91 WhatsApp/email helpers become QUEUED notification rows).
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly msg91: Msg91Service,
    private readonly walletService: WalletService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * Format a `YYYY-MM` period (or a Date) as "MMM YYYY" (e.g. "July 2026") for the
   * WhatsApp money-notification bodies. A malformed period falls back to the raw string.
   */
  private monthYear(periodOrDate: string | Date): string {
    const MONTHS = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    if (periodOrDate instanceof Date) {
      return `${MONTHS[periodOrDate.getMonth()]} ${periodOrDate.getFullYear()}`;
    }
    const m = /^(\d{4})-(\d{2})$/.exec(periodOrDate);
    if (!m) return periodOrDate;
    const monthIdx = Number(m[2]) - 1;
    return monthIdx >= 0 && monthIdx < 12 ? `${MONTHS[monthIdx]} ${m[1]}` : periodOrDate;
  }

  /** Format a date as "DD MMM YYYY" (e.g. "06 Jul 2026") for the WhatsApp money-notification bodies. */
  private formatDate(d: Date): string {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(d.getDate()).padStart(2, '0');
    return `${day} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  /**
   * Send the outlet OWNER a WhatsApp template on a POINTS credit (deoleo_points_credit).
   *
   * Fire-and-forget + POST-COMMIT: MUST NEVER throw into — or roll back — the credit
   * batch (the batch is CONFIRMED before this runs). Every path is wrapped in try/catch
   * and swallowed (mirrors KycService.sendKycWhatsapp). Tenant-gated via WHATSAPP_KYC:
   * a clientId with no `pointsCreditTemplate` no-ops. Skips silently if the owner has
   * no phone.
   *
   * bodyValues (in template order):
   *   {{1}} ownerName · {{2}} points credited · {{3}} redeemable balance AFTER the credit
   *   {{4}} month-year credited ("July 2026") · {{5}} date credited ("06 Jul 2026")
   */
  private async sendPointsCreditWhatsapp(
    clientId: string,
    data: {
      partnerId: string;
      ownerName?: string | null;
      phone?: string | null;
      totalPoints: number;
      period: string;
    },
  ): Promise<void> {
    try {
      const template = WHATSAPP_KYC[clientId]?.pointsCreditTemplate;
      if (!template) return; // tenant not configured for WhatsApp → no-op

      const phone = data.phone?.trim();
      if (!phone) {
        this.logger.warn(`[credit-whatsapp] points-credit skipped — no owner phone (client ${clientId})`);
        return;
      }

      // Redeemable balance AFTER the credit — read the partner's wallet. A missing
      // wallet (never credited) reads 0; never throws.
      const wallet = await this.prisma.wallet.findFirst({
        where: { partnerId: data.partnerId },
        select: { redeemablePoints: true },
      });
      const redeemableBalance = wallet?.redeemablePoints ?? 0;

      const ownerName = data.ownerName?.trim() || 'Partner';
      await this.msg91.sendWhatsappTemplate(phone, template, [
        ownerName,
        String(data.totalPoints),
        String(redeemableBalance),
        this.monthYear(data.period),
        this.formatDate(new Date()),
      ]);
    } catch (e) {
      // Non-critical: a WhatsApp delivery failure must NEVER fail the credit batch.
      this.logger.warn(`[credit-whatsapp] points-credit send failed (client ${clientId}): ${e}`);
    }
  }

  // ─── Settings-enforcement helpers (Stream MONEY-CREDITS) ──────────────────
  // The credit/payout safety caps and the month-cutoff window were previously
  // FRONTEND-ONLY (platform/src/app/admin/credits-payouts/upload/page.tsx +
  // credits-payouts-parser.ts). They are bypassable via a direct API call, so we
  // now MIRROR them server-side from the per-tenant TenantSettingsService.

  /** Current month as `YYYY-MM` on the server clock — matches the FE's `getPreviousMonth`
   *  baseline and the existing `targets.helpers.currentMonthKey` (both server-clock, no IST
   *  conversion; the FE's `isUploadWindowOpen` likewise reads a plain `new Date()`). */
  private currentPeriodKey(now: Date = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Mirror of the FE `isUploadWindowOpen(cutoffDay)` =
   * `new Date().getDate() <= cutoffDay`. A batch for a PRIOR month (period strictly
   * before the current month, `YYYY-MM` string compare) may only be created/confirmed
   * while today's day-of-month is on/before `monthCutoffDay`. Current/future-month
   * batches are unaffected (the FE only ever uploads the previous month, so the prior-
   * month case is the one the window guards).
   */
  private assertWithinUploadWindow(period: string, monthCutoffDay: number): void {
    const now = new Date();
    const current = this.currentPeriodKey(now);
    // Only PRIOR-month batches are gated. Same string-compare as targets isMonthLocked.
    if (period < current && now.getDate() > monthCutoffDay) {
      throw new BadRequestException(
        `The upload window for prior-month period ${period} closed on day ${monthCutoffDay} ` +
          `of the current month (today is day ${now.getDate()}). Batches for past months ` +
          `can no longer be created or confirmed.`,
      );
    }
  }

  /**
   * Mirror of the FE safety-cap rule (credits-payouts-parser.ts ~L219): a POINTS-award
   * row's whole-points value may not exceed `safetyCapPoints`; a PAYOUT-award row's
   * rupee value (row.amount is integer PAISE → ÷100 rupees) may not exceed `safetyCapInr`.
   * Only OK rows are checked (ERROR/SKIP rows carry no live award). Rejects naming the
   * offending outlet/field so the admin can locate the row.
   */
  private assertWithinSafetyCaps(
    rows: { outletId: string; outletName?: string; fieldName?: string; amount: number; awardType: string; status: string }[],
    safetyCapPoints: number,
    safetyCapInr: number,
  ): void {
    for (const r of rows) {
      if (r.status !== 'OK') continue;
      const who = `${r.outletName ?? r.outletId} (${r.outletId})${r.fieldName ? ` / field "${r.fieldName}"` : ''}`;
      if (r.awardType === 'POINTS') {
        if (r.amount > safetyCapPoints) {
          throw new BadRequestException(
            `Row for ${who} awards ${r.amount} points, exceeding the safety cap of ${safetyCapPoints} points.`,
          );
        }
      } else if (r.awardType === 'PAYOUT') {
        // row.amount is integer paise; the cap is in rupees.
        const rupees = r.amount / 100;
        if (rupees > safetyCapInr) {
          throw new BadRequestException(
            `Row for ${who} awards ₹${rupees.toFixed(2)}, exceeding the safety cap of ₹${safetyCapInr}.`,
          );
        }
      }
    }
  }

  // ─── Code generators ───────────────────────────────────────────────────────

  /** Batch code: CB-YYYY-MM-NNN (per client + period). */
  private async generateBatchCode(clientId: string, period: string): Promise<string> {
    const prefix = `CB-${period}`;
    const count = await this.prisma.creditBatch.count({
      where: { clientId, batchCode: { startsWith: prefix } },
    });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** Download code: PD-YYYY-MM-NNN (per client + period). */
  private async generateDownloadCode(clientId: string, period: string): Promise<string> {
    const prefix = `PD-${period}`;
    const count = await this.prisma.creditPayoutDownload.count({
      where: { clientId, downloadCode: { startsWith: prefix } },
    });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** Fire-and-forget enqueue; never fails the request (mirrors the source). */
  private async notify(params: Parameters<NotificationsService['enqueue']>[0]): Promise<void> {
    await this.notifications.enqueue(params).catch(() => {
      // Non-critical: notification failures must not fail the request.
    });
  }

  // ─── GET /v1/admin/credits/batches ─────────────────────────────────────────
  // Server-side period filter (was client-side in the status page) + pagination.
  async listBatches(user: JwtPayload, q: ListBatchesQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    // Tenant scope is never widened; the optional YYYY-MM period filter is applied here.
    const where: Prisma.CreditBatchWhereInput = { clientId: user.clientId };
    if (q.period) where.period = q.period;

    const [batches, total] = await Promise.all([
      this.prisma.creditBatch.findMany({
        where,
        orderBy: { uploadedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          batchCode: true,
          period: true,
          status: true,
          uploadedBy: true,
          uploadedAt: true,
          confirmedBy: true,
          confirmedAt: true,
          totalOutlets: true,
          totalPoints: true,
          totalPayoutPaise: true,
        },
      }),
      this.prisma.creditBatch.count({ where }),
    ]);

    return { batches, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ─── POST /v1/admin/credits/batches ────────────────────────────────────────
  async createBatch(user: JwtPayload, dto: CreateBatchDto) {
    // Load per-tenant settings and ENFORCE the safety caps + month-cutoff window
    // server-side (these were FE-only and bypassable via direct API).
    const { creditsPayouts } = await this.tenantSettings.getEffectiveSettings(user.clientId);
    // NOTE: creditsPayouts.fourEyesEnabled is intentionally NOT enforced here — the
    // maker-checker approval workflow is DEFERRED to post-go-live (no UI toggle exists yet).
    this.assertWithinUploadWindow(dto.period, creditsPayouts.monthCutoffDay);
    this.assertWithinSafetyCaps(
      dto.rows,
      creditsPayouts.safetyCapPoints,
      creditsPayouts.safetyCapInr,
    );

    const batchCode = await this.generateBatchCode(user.clientId, dto.period);

    const batch = await this.prisma.creditBatch.create({
      data: {
        clientId: user.clientId,
        batchCode,
        period: dto.period,
        uploadedBy: user.sub ?? '',
        totalOutlets: dto.totalOutlets,
        // totalPoints is whole points (a count, NOT money — no ×100).
        totalPoints: dto.totalPoints,
        // totalPayoutPaise: integer paise received from the client; stored as BigInt.
        totalPayoutPaise: toPaiseBigInt(dto.totalPayoutPaise),
        // rows JSON stores per-row `amount` in paise (PAYOUT) or whole points (POINTS).
        rows: dto.rows as unknown as Prisma.InputJsonValue,
      },
    });

    return batch;
  }

  // ─── GET /v1/admin/credits/batches/:id ─────────────────────────────────────
  async getBatch(user: JwtPayload, id: string) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  // ─── POST /v1/admin/credits/batches/:id/confirm ────────────────────────────
  async confirmBatch(user: JwtPayload, id: string) {
    // Read the batch first for its data (rows, period, etc.). The status-flip below
    // uses a guarded updateMany claim so a concurrent double-confirm cannot
    // double-credit points.
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    if (batch.status !== 'PENDING_CONFIRM') {
      throw new BadRequestException(`Batch is already ${batch.status}`);
    }

    // Enforce the month-cutoff window on confirm too (a PENDING batch created before
    // the cutoff must not be confirmed after it has closed). fourEyesEnabled is
    // intentionally NOT enforced (deferred to post-go-live — see createBatch note).
    const { creditsPayouts } = await this.tenantSettings.getEffectiveSettings(user.clientId);
    this.assertWithinUploadWindow(batch.period, creditsPayouts.monthCutoffDay);

    // Parse rows from JSON.
    const rows = batch.rows as unknown as {
      outletId: string;
      outletName: string;
      fieldId: string;
      fieldName: string;
      amount: number;
      narration: string;
      awardType: string;
      status: string;
    }[];

    const payoutRows = rows.filter((r) => r.awardType === 'PAYOUT' && r.status === 'OK');
    // amount > 0: creditEarn rejects non-positive amounts; a 0/negative POINTS row
    // would throw inside the tx and roll back the whole confirm (incl. PAYOUT entries).
    const pointsRows = rows.filter(
      (r) => r.awardType === 'POINTS' && r.status === 'OK' && r.amount > 0,
    );

    // Rows that genuinely cannot be credited, WITH a reason surfaced to the admin
    // (never dropped silently). The only remaining skip causes are an unresolvable
    // outlet code or an outlet not linked to any partner — a missing wallet is no
    // longer a skip (we create it; see below).
    const skipped: {
      outletId: string;
      fieldName: string;
      points: number;
      reason: 'OUTLET_NOT_FOUND' | 'OUTLET_NOT_LINKED_TO_PARTNER';
    }[] = [];
    let pointsCredited = 0; // count of credited rows
    let pointsCreditedTotal = 0; // sum of credited points
    // Collected for the best-effort PUSH "points earned" trigger AFTER commit. We
    // sum per partner so a partner credited under several fields gets one push.
    const creditedByPartner = new Map<string, number>();

    // Bulk money mutation over uploaded rows — raise the interactive-tx timeout (default 5s) so the ATOMIC transaction survives a full-tenant batch; must stay all-or-nothing (do NOT chunk — would risk partial/double credit).
    const updated = await this.prisma.$transaction(async (tx) => {
      // ── Concurrency guard ──────────────────────────────────────────────────
      // Replace the plain update with a conditional updateMany. Only the first
      // concurrent caller flips status PENDING_CONFIRM→CONFIRMED (count===1);
      // subsequent racing callers see count===0 and throw, preventing
      // double-crediting of wallet points.
      const claimed = await tx.creditBatch.updateMany({
        where: { id, status: 'PENDING_CONFIRM' },
        data: {
          status: 'CONFIRMED',
          confirmedBy: user.sub,
          confirmedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Batch already confirmed');
      }

      // Re-read to get the full record back (updateMany does not return the row).
      const confirmed = await tx.creditBatch.findFirst({ where: { id } });

      // ── PAYOUT rows → CreditPayoutEntry ───────────────────────────────────
      // NOTE (duplicate-outletCode safety): one CreditPayoutEntry is created per
      // PAYOUT row, so the same outletCode CAN produce multiple entries (e.g. an
      // outlet awarded under several credit fields). This does NOT double the
      // payout: createPayoutDownload groups entries by outletId and SUMS amountPaise
      // into a single bank-file line per outlet, so two entries become one payout
      // for their combined amount — the intended behaviour. No dedup needed here.
      if (payoutRows.length > 0) {
        await tx.creditPayoutEntry.createMany({
          data: payoutRows.map((r) => ({
            clientId: user.clientId,
            batchId: id,
            outletId: r.outletId,
            outletName: r.outletName,
            fieldId: r.fieldId,
            fieldName: r.fieldName,
            period: batch.period,
            // r.amount is integer paise (invariant: upload parser converts rupees→paise
            // before POSTing; the batch JSON therefore always stores paise for PAYOUT rows).
            amountPaise: toPaiseBigInt(r.amount),
            narration: r.narration ?? '',
          })),
        });
      }

      // ── POINTS rows → wallet creditEarn (gap #16) ────────────────────────
      // Each row is one ledger entry. Multiple rows for the same partner roll up
      // naturally in the wallet aggregate via successive creditEarn calls.
      // We skip rather than throw if no outlet/partner/wallet exists, so a bad row
      // cannot abort the whole confirm.
      for (const r of pointsRows) {
        // Resolve outletCode → partnerId (tenant-scoped). A row that cannot resolve
        // to a partner is skipped WITH a reason (surfaced to the admin), never dropped
        // silently.
        const outlet = await tx.outlet.findFirst({
          where: { outletCode: r.outletId, clientId: user.clientId },
          select: { partnerId: true },
        });
        if (!outlet) {
          skipped.push({
            outletId: r.outletId,
            fieldName: r.fieldName,
            points: r.amount,
            reason: 'OUTLET_NOT_FOUND',
          });
          continue;
        }
        if (!outlet.partnerId) {
          skipped.push({
            outletId: r.outletId,
            fieldName: r.fieldName,
            points: r.amount,
            reason: 'OUTLET_NOT_LINKED_TO_PARTNER',
          });
          continue;
        }

        // Get-or-create the wallet. Points ACCRUE even before KYC approval (Deoleo
        // runs non-KYC campaigns) — but a wallet is otherwise created only at KYC
        // approval, so pre-KYC credits were being silently skipped. `partnerId` is
        // @unique, so this upsert is race-safe; an existing wallet is left untouched.
        // Disbursement is still gated on KYC-APPROVED at payout time
        // (createPayoutDownload holds non-approved entries), so accruing points to a
        // not-yet-approved partner's wallet here is correct.
        await tx.wallet.upsert({
          where: { partnerId: outlet.partnerId },
          create: { partnerId: outlet.partnerId },
          update: {},
        });

        // r.amount is whole points for POINTS rows.
        await this.walletService.creditEarn(
          outlet.partnerId,
          user.clientId,
          r.amount,
          {
            referenceType: 'CREDIT_BATCH',
            referenceId: id,
            sourceType: 'CREDIT_FIELD',
            sourceId: r.fieldId,
            description: r.narration ?? null,
          },
          tx,
        );
        pointsCredited += 1;
        pointsCreditedTotal += r.amount;
        creditedByPartner.set(
          outlet.partnerId,
          (creditedByPartner.get(outlet.partnerId) ?? 0) + r.amount,
        );
      }

      return confirmed;
    }, { timeout: 180_000, maxWait: 20_000 });

    // Best-effort PUSH "points earned" trigger (PWA F5). Resolve each credited
    // partner's userId AFTER commit and enqueue a PUSH row. Wrapped so push can
    // NEVER break the money path; the SMS/email below is unaffected.
    try {
      for (const [partnerId, totalPoints] of creditedByPartner) {
        // Fetch the owner identity for BOTH the PUSH (userId) and the WhatsApp
        // (ownerName + phone) in one read.
        const partner = await this.prisma.channelPartner.findFirst({
          where: { id: partnerId },
          select: { userId: true, ownerName: true, phone: true },
        });
        if (partner?.userId) {
          await this.notifications
            .enqueue({
              userId: partner.userId,
              channel: 'PUSH',
              subject: 'Points credited',
              body: `You earned ${totalPoints} points.`,
              // url = deep-link so a tapped push opens a real authenticated route (a urless push falls back to '/' → /auth/login).
              variables: { event: 'WALLET_POINTS_EARNED', points: totalPoints, batchId: id, url: '/partner/wallet' },
            })
            .catch(() => undefined);
        }

        // Owner WhatsApp on points credit (deoleo_points_credit). Tenant-gated +
        // fire-and-forget + POST-COMMIT: this MUST NEVER throw into or roll back the
        // money transaction (the batch is already CONFIRMED above). Mirrors the KYC
        // send style — resolve the template, no-op if the tenant is unconfigured or
        // the owner has no phone, and swallow any delivery failure.
        await this.sendPointsCreditWhatsapp(user.clientId, {
          partnerId,
          ownerName: partner?.ownerName ?? null,
          phone: partner?.phone ?? null,
          totalPoints,
          period: batch.period,
        });
      }
    } catch {
      // Best-effort: a push/whatsapp failure must never affect a confirmed credit batch.
    }

    // Notify the team (fire-and-forget; don't block confirm on failure).
    // Recipients come from the tenant's creditsPayouts.notifyEmails; if that list is
    // empty we KEEP the legacy ops@gifsy.in fallback so notifications never silently stop.
    // totalPayoutPaise is a BigInt from Prisma — convert to rupees for the human-readable email.
    const recipientEmails =
      creditsPayouts.notifyEmails.length > 0
        ? creditsPayouts.notifyEmails
        : ['ops@gifsy.in'];
    for (const recipientEmail of recipientEmails) {
      await this.notify({
        userId: batch.uploadedBy,
        channel: 'EMAIL',
        recipientEmail,
        subject: `[Gifsy] New Batch Confirmed — ${user.clientId} — ${batch.period}`,
        body: `New batch ${id} confirmed for ${user.clientId} (period ${batch.period}).`,
        variables: {
          event: 'CREDITS_NEW_BATCH_CONFIRMED',
          tenantName: user.clientId,
          batchId: id,
          period: batch.period,
          totalOutlets: Number(batch.totalOutlets),
          totalPoints: Number(batch.totalPoints),
          // Express as rupees for the team email — humans read ₹, not paise.
          totalPayoutRupees: paiseToRupees(batch.totalPayoutPaise ?? 0n),
          uploadedBy: batch.uploadedBy,
          recipientEmails,
        },
      });
    }

    return {
      batch: updated,
      payoutEntriesCreated: payoutRows.length,
      pointsCredited,
      pointsCreditedTotal,
      skipped,
    };
  }

  // ─── GET /v1/admin/credits/batches/:id/reversals ───────────────────────────
  async listBatchReversals(user: JwtPayload, id: string) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');

    return this.prisma.creditReversal.findMany({
      where: { batchId: id, clientId: user.clientId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  // ─── POST /v1/admin/credits/batches/:id/reversals ──────────────────────────
  // Maker-checker: client requests, Gifsy approves.
  async createReversal(user: JwtPayload, id: string, dto: CreateReversalDto) {
    const batch = await this.prisma.creditBatch.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    if (batch.status === 'PENDING_CONFIRM') {
      throw new BadRequestException('Cannot reverse a batch that has not been confirmed');
    }

    if (dto.requestedPaise > dto.originalPaise) {
      throw new BadRequestException(
        'Requested reversal amount cannot exceed original amount',
      );
    }

    // Block a duplicate pending reversal for the same outlet+field in this batch.
    const existingPending = await this.prisma.creditReversal.findFirst({
      where: {
        batchId: id,
        clientId: user.clientId,
        outletId: dto.outletId,
        fieldId: dto.fieldId,
        status: 'PENDING_GIFSY',
      },
    });
    if (existingPending) {
      throw new BadRequestException(
        'A pending reversal already exists for this outlet and field in this batch',
      );
    }

    // The pre-check above is the fast path, but a concurrent request can slip past
    // it (read-then-write race). The DB partial-unique index
    // `credit_reversals_pending_unique` on (batchId,outletId,fieldId) WHERE
    // status='PENDING_GIFSY' is the authoritative guard — translate its P2002 into
    // the same clean 400.
    try {
      return await this.prisma.creditReversal.create({
        data: {
          clientId: user.clientId,
          batchId: id,
          outletId: dto.outletId,
          outletName: dto.outletName,
          fieldId: dto.fieldId,
          fieldName: dto.fieldName,
          period: batch.period,
          awardType: dto.awardType,
          // Store as BigInt paise (or whole points for POINTS awardType).
          originalPaise: toPaiseBigInt(dto.originalPaise),
          requestedPaise: toPaiseBigInt(dto.requestedPaise),
          requestedBy: user.sub,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException(
          'A pending reversal already exists for this outlet and field in this batch.',
        );
      }
      throw e;
    }
  }

  // ─── GET /v1/admin/credits/eligible-outlets ────────────────────────────────
  async eligibleOutlets(user: JwtPayload) {
    const outlets = await this.prisma.outlet.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        partner: { clientId: user.clientId, isActive: true },
      },
      include: {
        outletType: { select: { code: true } },
      },
      orderBy: { outletCode: 'asc' },
    });

    return outlets.map((o) => ({
      id: o.outletCode,
      name: o.name,
      type: o.outletType.code,
      phone: o.phone ?? undefined,
    }));
  }

  // ─── GET /v1/admin/credits/outlet-types ────────────────────────────────────
  // The award editor needs the tenant's ENABLED outlet types so an admin can set
  // POINTS/PAYOUT/NA per type without a hardcoded list. Keyed on OutletType.code —
  // the SAME value the upload parser resolves against (`outletTypeAwards[outlet.type]`,
  // where outlet.type is the OutletType.code) — so the configured map keys always
  // match the codes stored on outlets. Tenant-scoped; enabled + active only.
  async listOutletTypes(user: JwtPayload): Promise<{ code: string; label: string }[]> {
    const configs = await this.prisma.outletTypeClientConfig.findMany({
      where: {
        clientId: user.clientId,
        isEnabled: true,
        outletType: { isActive: true },
      },
      include: { outletType: { select: { code: true, name: true } } },
    });
    return configs
      .map((c) => ({ code: c.outletType.code, label: c.displayName ?? c.outletType.name }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  // ─── GET /v1/admin/credits/fields ──────────────────────────────────────────
  async listFields(user: JwtPayload, q: ListFieldsQueryDto) {
    const activeOnly = q.active === 'true';
    return this.prisma.creditField.findMany({
      where: {
        clientId: user.clientId,
        ...(activeOnly ? { isActive: true } : {}),
      },
      orderBy: { order: 'asc' },
    });
  }

  // ─── POST /v1/admin/credits/fields ─────────────────────────────────────────
  async createField(user: JwtPayload, dto: CreateFieldDto) {
    // Duplicate-name guard (per client).
    const existing = await this.prisma.creditField.findFirst({
      where: { clientId: user.clientId, name: dto.name },
    });
    if (existing) throw new BadRequestException(`A field named "${dto.name}" already exists.`);

    // Next order value.
    const maxOrderField = await this.prisma.creditField.findFirst({
      where: { clientId: user.clientId },
      orderBy: { order: 'desc' },
    });
    const nextOrder = (maxOrderField?.order ?? 0) + 1;

    return this.prisma.creditField.create({
      data: {
        clientId: user.clientId,
        name: dto.name,
        isSeparatePayout: dto.isSeparatePayout,
        outletTypeAwards: dto.outletTypeAwards as unknown as Prisma.InputJsonValue,
        order: nextOrder,
      },
    });
  }

  // ─── PATCH /v1/admin/credits/fields/:id ────────────────────────────────────
  // Two independent mutations, either (or both) may be supplied:
  //   • `action`           → flip isActive (activate/deactivate)
  //   • `outletTypeAwards`  → set the per-outlet-type award map (POINTS/PAYOUT/NA)
  // The award map decides whether an uploaded row becomes wallet POINTS or a bank
  // PAYOUT, so each value is strictly validated against the POINTS/PAYOUT/NA set —
  // a malformed map must never silently misroute money.
  async patchField(user: JwtPayload, id: string, dto: PatchFieldDto) {
    const field = await this.prisma.creditField.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!field) throw new NotFoundException('Field not found');

    const data: Prisma.CreditFieldUpdateInput = {};

    if (dto.action !== undefined) {
      data.isActive = dto.action === FieldAction.activate;
    }

    if (dto.outletTypeAwards !== undefined) {
      const VALID = new Set<string>([
        FieldAwardValue.POINTS,
        FieldAwardValue.PAYOUT,
        FieldAwardValue.NA,
      ]);
      for (const [outletType, award] of Object.entries(dto.outletTypeAwards)) {
        if (!outletType || outletType.trim() === '') {
          throw new BadRequestException('Award map contains a blank outlet-type key.');
        }
        if (!VALID.has(award)) {
          throw new BadRequestException(
            `Invalid award "${award}" for outlet type "${outletType}". Must be POINTS, PAYOUT, or NA.`,
          );
        }
      }
      data.outletTypeAwards = dto.outletTypeAwards as Prisma.InputJsonValue;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'Nothing to update — provide an action (activate/deactivate) or an outletTypeAwards map.',
      );
    }

    return this.prisma.creditField.update({ where: { id }, data });
  }

  // ─── GET /v1/admin/credits/payout-downloads ────────────────────────────────
  async listPayoutDownloads(user: JwtPayload, q: ListPayoutDownloadsQueryDto) {
    return this.prisma.creditPayoutDownload.findMany({
      where: {
        clientId: user.clientId,
        ...(q.period ? { period: q.period } : {}),
      },
      orderBy: { downloadedAt: 'desc' },
      include: {
        _count: { select: { entries: true } },
      },
    });
  }

  // ─── POST /v1/admin/credits/payout-downloads ───────────────────────────────
  // Builds the bank payout file, records the download, and marks entries
  // PROCESSING. Returns the xlsx buffer + identifiers; the controller streams it.
  async createPayoutDownload(
    user: JwtPayload,
    dto: CreatePayoutDownloadDto,
  ): Promise<{
    buffer: Buffer;
    downloadCode: string;
    downloadId: string;
    // GLB-1(a): entries excluded from the bank file because the partner is not
    // KYC-APPROVED or the outlet is inactive/deleted. The awards stay PENDING and
    // re-enter the next download once the gate clears.
    heldEntries: Array<{
      outletId: string;
      outletName: string;
      amountPaise: number;
      reason: string;
      entryIds: string[];
    }>;
  }> {
    const { period, groupType, fieldId, fieldName } = dto;

    // Active separate fields (used to exclude from STANDARD).
    const separateFields = await this.prisma.creditField.findMany({
      where: { clientId: user.clientId, isSeparatePayout: true, isActive: true },
      select: { id: true },
    });
    const separateFieldIds = new Set(separateFields.map((f) => f.id));

    // GLM-2: include FAILED entries (bank-rejected, never paid) alongside PENDING so
    // they can be re-banked in a fresh download. A corrected re-upload then flips
    // FAILED→PAID via the existing UTR path (no double-pay: FAILED was never paid).
    // REVERSED entries are intentionally EXCLUDED: they have been clawed back and
    // must never re-enter the bank file (REVERSED ≠ bank-rejected; REVERSED = clawed back).
    const baseWhere: Prisma.CreditPayoutEntryWhereInput = {
      clientId: user.clientId,
      period,
      status: { in: ['PENDING', 'FAILED'] },
    };

    // GLM-2: baseWhere now carries `status: { in: ['PENDING','FAILED'] }` so that
    // bank-rejected (FAILED) entries are eligible for re-banking. REVERSED entries
    // are excluded because the `in` list does not include 'REVERSED'.
    let entryWhere: Prisma.CreditPayoutEntryWhereInput = baseWhere;
    if (groupType === PayoutGroupType.SEPARATE && fieldId) {
      entryWhere = { ...baseWhere, fieldId };
    } else if (groupType === PayoutGroupType.STANDARD) {
      entryWhere = {
        ...baseWhere,
        NOT:
          separateFieldIds.size > 0
            ? { fieldId: { in: [...separateFieldIds] } }
            : undefined,
      };
    }

    const entries = await this.prisma.creditPayoutEntry.findMany({
      where: entryWhere,
      include: { batch: { select: { batchCode: true } } },
    });

    if (entries.length === 0) {
      throw new BadRequestException(
        `No PENDING or FAILED payout entries found for period ${period}${
          fieldId ? ` / field ${fieldId}` : ''
        }.`,
      );
    }

    // Group by outlet, sum amounts (in integer paise — no float accumulation).
    // amountPaise is a BigInt from Prisma; Number() is safe (paise « MAX_SAFE_INTEGER).
    const outletMap = new Map<
      string,
      { outletName: string; amountPaise: number; entryIds: string[] }
    >();
    for (const e of entries) {
      const cur = outletMap.get(e.outletId);
      if (cur) {
        cur.amountPaise += Number(e.amountPaise);
        cur.entryIds.push(e.id);
      } else {
        outletMap.set(e.outletId, {
          outletName: e.outletName,
          amountPaise: Number(e.amountPaise),
          entryIds: [e.id],
        });
      }
    }

    // Fetch bank details from ChannelPartner via Outlet.outletCode (tenant-scoped).
    // GLB-1(a): also fetch the partner's KycSubmission candidates and isActive/deletedAt
    // so that non-KYC-APPROVED or inactive/deleted outlets are excluded from the payable
    // rows and surfaced in a "heldEntries" list instead.
    //
    // KYC resolver note: we fetch ALL submissions for the partner (no take:1 limit)
    // and pass them to resolveEffectiveKycStatus() which applies a deterministic
    // createdAt→updatedAt→id tiebreak. This avoids the stale-APPROVED race where
    // a millisecond-tie could surface an old APPROVED after a reKyc() in-place mutation.
    //
    // Null-partnerId: a KycSubmission may have partnerId=null but a matching userId
    // (submitted before the partner record was created). Including all partner-keyed
    // submissions covers the normal path; the service will call resolveEffectiveKycStatus
    // on whatever candidates Prisma returns.
    const outletCodes = [...outletMap.keys()];
    const outlets = await this.prisma.outlet.findMany({
      where: { clientId: user.clientId, outletCode: { in: outletCodes } },
      include: {
        partner: {
          select: {
            id: true,
            userId: true,
            bankName: true,
            bankAccountNumber: true,
            bankAccountHolder: true,
            ifscCode: true,
            upiId: true,
            isActive: true,
            deletedAt: true,
            // Fetch ALL submissions so resolveEffectiveKycStatus can apply the
            // deterministic tiebreak. The resolver selects the effective status.
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        },
      },
    });
    const outletDbMap = new Map(outlets.map((o) => [o.outletCode, o]));

    const bankSnapshots = outletCodes.map((code) => {
      const o = outletDbMap.get(code);
      return {
        outletId: code,
        bankName: o?.partner?.bankName ?? '',
        accountNumber: o?.partner?.bankAccountNumber ?? '',
        ifscCode: o?.partner?.ifscCode ?? '',
        upiId: o?.partner?.upiId ?? '',
        snapshotAt: new Date().toISOString(),
      };
    });
    const snapshotMap = new Map(bankSnapshots.map((s) => [s.outletId, s]));

    // GLB-1(a): Split codes into payable (KYC-APPROVED + active) vs held.
    // Held entries stay PENDING and re-enter the next download once the gate clears —
    // their downloadId is NOT set here and their status is NOT flipped to PROCESSING.
    const payableCodes: string[] = [];
    const heldEntries: Array<{
      outletId: string;
      outletName: string;
      amountPaise: number;
      reason: string;
      entryIds: string[];
    }> = [];

    for (const code of outletCodes) {
      const o = outletDbMap.get(code);
      const partner = o?.partner;
      const info = outletMap.get(code)!;

      // Canonical eligibility gate: inactive or soft-deleted partner → held.
      if (!partner || partner.isActive === false || partner.deletedAt != null) {
        heldEntries.push({
          outletId: code,
          outletName: info.outletName,
          amountPaise: info.amountPaise,
          reason: partner?.deletedAt != null ? 'PARTNER_DELETED' : 'PARTNER_INACTIVE',
          entryIds: info.entryIds,
        });
        continue;
      }

      // Partner KYC must be APPROVED. Use the canonical resolver (deterministic
      // createdAt→updatedAt→id tiebreak) so a stale APPROVED row cannot sneak
      // through after a reKyc() in-place mutation. Default for no submission = null
      // = NOT approved (never ?? 'APPROVED').
      const kycStatus = resolveEffectiveKycStatus(partner.kycSubmissions ?? []);
      if (kycStatus !== 'APPROVED') {
        heldEntries.push({
          outletId: code,
          outletName: info.outletName,
          amountPaise: info.amountPaise,
          reason: `KYC_NOT_APPROVED:${kycStatus ?? 'NO_SUBMISSION'}`,
          entryIds: info.entryIds,
        });
        continue;
      }

      payableCodes.push(code);
    }

    const rows: PayoutBatchRow[] = payableCodes.map((code) => {
      const info = outletMap.get(code)!;
      const o = outletDbMap.get(code);
      const snapshot = snapshotMap.get(code)!;
      // Populate the real KYC status from the canonical resolver (will always be
      // 'APPROVED' here because non-approved codes were excluded into heldEntries
      // above). Fallback is 'APPROVED' ONLY because we know the code is payable —
      // this is a display value, not a gate. The gate above uses ?? null (never
      // ?? 'APPROVED'), so a no-submission partner is correctly held, not paid.
      const kycStatus = resolveEffectiveKycStatus(o?.partner?.kycSubmissions ?? []) ?? 'APPROVED';
      return {
        outletId: code,
        outletName: info.outletName,
        phone: o?.phone ?? '',
        bankName: snapshot.bankName,
        accountNumber: snapshot.accountNumber,
        ifscCode: snapshot.ifscCode,
        upiId: snapshot.upiId,
        kycStatus,
        // amount in the Excel file is rupees for human readability; convert from paise.
        amount: paiseToRupees(info.amountPaise),
        isDeactivated: !(o?.isActive ?? true),
        utrStatus: 'PENDING',
        entryIds: info.entryIds,
      };
    });

    // Abort if every entry is held and nothing is payable.
    if (payableCodes.length === 0) {
      throw new BadRequestException(
        `No payable entries for period ${period}: all ${heldEntries.length} outlet(s) are held (KYC not approved or partner inactive/deleted).`,
      );
    }

    const downloadCode = await this.generateDownloadCode(user.clientId, period);
    // totalAmountPaise: integer sum in paise for PAYABLE rows only (exact, no float drift).
    // GLB-1(a): held entries are excluded from the bank file and their entryIds must
    // NOT be marked PROCESSING — they stay PENDING and re-enter the next download.
    const payableEntryIds = payableCodes.flatMap((code) => outletMap.get(code)!.entryIds);
    const totalAmountPaise = payableCodes.reduce(
      (s, code) => s + outletMap.get(code)!.amountPaise,
      0,
    );

    const payoutBatch: PayoutBatch = {
      id: downloadCode,
      creditBatchId: 'MULTI',
      period,
      groupType,
      ...(fieldId ? { fieldId } : {}),
      ...(fieldName ? { fieldName } : {}),
      status: 'OPEN',
      downloadedAt: new Date().toISOString(),
      downloadedBy: user.sub,
      // PayoutBatch.totalAmount is rupees (for the Excel file header); convert.
      totalAmount: paiseToRupees(totalAmountPaise),
      bankSnapshots,
      rows,
    };

    // Create download record + mark ONLY payable entries with downloadId/PROCESSING.
    // Held entries retain status=PENDING and downloadId=null so they re-enter the next
    // download once KYC clears — the award is never abandoned, just deferred.
    const download = await this.prisma.$transaction(async (tx) => {
      const rec = await tx.creditPayoutDownload.create({
        data: {
          clientId: user.clientId,
          downloadCode,
          period,
          groupType,
          fieldId: fieldId ?? null,
          fieldName: fieldName ?? null,
          downloadedBy: user.sub,
          totalAmountPaise: toPaiseBigInt(totalAmountPaise),
          bankSnapshots: bankSnapshots as unknown as Prisma.InputJsonValue,
        },
      });

      // GLB-1(a): only flip the payable subset to PROCESSING; held entries stay PENDING/FAILED.
      // GLM-2: FAILED entries (bank-rejected, re-selected for re-banking) are also flipped
      // to PROCESSING here, with their prior downloadId replaced by the new download's id.
      // This is correct: FAILED was never paid — treating it like PENDING for re-banking
      // incurs no double-pay risk. REVERSED entries are excluded by the entryWhere above.
      if (payableEntryIds.length > 0) {
        await tx.creditPayoutEntry.updateMany({
          where: { id: { in: payableEntryIds } },
          data: { downloadId: rec.id, status: 'PROCESSING' },
        });
      }

      return rec;
    });

    const buffer = generatePayoutFileBuffer(payoutBatch);

    return { buffer, downloadCode, downloadId: download.id, heldEntries };
  }

  // ─── POST /v1/admin/credits/payout-downloads/:id/utr ───────────────────────
  // [id] is the CreditPayoutDownload id. Parses the UTR upload; previews unless
  // ?apply=true, then applies PAID/FAILED to entries and notifies paid outlets.
  async uploadUtr(user: JwtPayload, id: string, file: Express.Multer.File, apply: boolean) {
    const download = await this.prisma.creditPayoutDownload.findFirst({
      where: { id, clientId: user.clientId },
      include: {
        entries: {
          select: { id: true, outletId: true, status: true, utr: true, amountPaise: true },
        },
      },
    });
    if (!download) throw new NotFoundException('Payout download not found');

    if (!file) throw new BadRequestException('No file uploaded');

    const ab = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    );

    // Injectable batch rows from DB.
    const batchRows = download.entries.map((e) => ({
      outletId: e.outletId,
      utrStatus: (e.status === 'PAID'
        ? 'PAID'
        : e.status === 'FAILED'
          ? 'FAILED'
          : 'PENDING') as 'PENDING' | 'PAID' | 'FAILED',
      utr: e.utr ?? undefined,
    }));

    // Known UTRs across all downloads for this client (dup detection).
    const usedUtrs = await this.prisma.creditPayoutEntry.findMany({
      where: { clientId: user.clientId, utr: { not: null } },
      select: { utr: true },
    });
    const knownUtrs = new Set<string>(
      usedUtrs.filter((e) => e.utr != null).map((e) => e.utr!.toUpperCase()),
    );

    const parseResult = parseUtrUpload(ab, {
      downloadCode: download.downloadCode,
      batchRows,
      knownUtrs,
    });

    // Preview unless apply=true.
    if (!apply) {
      return { parseResult, downloadCode: download.downloadCode };
    }

    if (!parseResult.canProceed) {
      throw new BadRequestException('Cannot apply — parse result has errors or no valid rows');
    }

    const now = new Date();
    // Bulk money mutation over uploaded rows — raise the interactive-tx timeout (default 5s) so the ATOMIC transaction survives a full-tenant batch; must stay all-or-nothing (do NOT chunk — would risk partial/double credit).
    await this.prisma.$transaction(async (tx) => {
      for (const row of parseResult.rows) {
        if (row.status !== 'OK') continue;

        const entry = download.entries.find((e) => e.outletId === row.outletId);
        if (!entry) continue;

        await tx.creditPayoutEntry.update({
          where: { id: entry.id },
          data: {
            status: row.success ? 'PAID' : 'FAILED',
            utr: row.success ? row.utr || null : null,
            paidAt: row.success ? now : null,
          },
        });
      }

      const stillPending = download.entries.some((e) => {
        const row = parseResult.rows.find((r) => r.outletId === e.outletId);
        return !row || row.status === 'SKIP';
      });
      await tx.creditPayoutDownload.update({
        where: { id: download.id },
        data: { status: stillPending ? 'PARTIALLY_PAID' : 'PAID' },
      });
    }, { timeout: 180_000, maxWait: 20_000 });

    // Notify paid outlets (fire-and-forget; needs phone from outlet).
    const paidOutletIds = parseResult.rows
      .filter((r) => r.status === 'OK' && r.success)
      .map((r) => r.outletId);

    if (paidOutletIds.length > 0) {
      const outlets = await this.prisma.outlet.findMany({
        where: { clientId: user.clientId, outletCode: { in: paidOutletIds } },
        select: {
          outletCode: true,
          name: true,
          phone: true,
          partnerId: true,
          // The payout WhatsApp addresses the outlet OWNER by name.
          partner: { select: { ownerName: true } },
        },
      });
      const phoneMap = new Map(outlets.map((o) => [o.outletCode, o]));
      for (const row of parseResult.rows) {
        if (row.status !== 'OK' || !row.success) continue;
        const entry = download.entries.find((e) => e.outletId === row.outletId);
        const outlet = phoneMap.get(row.outletId);
        if (!entry || !outlet?.phone) continue;

        // Owner WhatsApp on payout credit (deoleo_payout_credit). DIRECT send (the old
        // queued WHATSAPP notify() never delivered — the queue only drains PUSH), fire-
        // and-forget + POST-COMMIT: the money tx above is already committed, so this
        // MUST NEVER throw into it. Tenant-gated via WHATSAPP_KYC.
        //   {{1}} ownerName · {{2}} points · {{3}} UTR · {{4}} date of payment · {{5}} month
        // pointsPaid = paid amount as a whole number (Deoleo: 1 point = ₹1 → paise ÷ 100).
        try {
          const template = WHATSAPP_KYC[user.clientId]?.payoutCreditTemplate;
          if (template) {
            const ownerName = outlet.partner?.ownerName?.trim() || 'Partner';
            const pointsPaid = Math.round(Number(entry.amountPaise) / 100);
            await this.msg91.sendWhatsappTemplate(outlet.phone, template, [
              ownerName,
              String(pointsPaid),
              row.utr ?? '',
              this.formatDate(new Date()),
              this.monthYear(download.period),
            ]);
          }
        } catch (e) {
          // Non-critical: a WhatsApp delivery failure must NEVER fail the payout.
          this.logger.warn(`[credit-whatsapp] payout-credit send failed (client ${user.clientId}): ${e}`);
        }
      }
    }

    return {
      applied: true,
      paidCount: parseResult.summary.paidCount,
      failedCount: parseResult.summary.failedCount,
      skippedCount: parseResult.summary.skipped,
    };
  }

  // ─── GET /v1/admin/credits/reversals ───────────────────────────────────────
  // Existing status/period filters preserved; adds skip/take + count pagination.
  async listReversals(user: JwtPayload, q: ListReversalsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.CreditReversalWhereInput = { clientId: user.clientId };
    if (q.status) where.status = q.status as Prisma.CreditReversalWhereInput['status'];
    if (q.period) where.period = q.period;

    const [reversals, total] = await Promise.all([
      this.prisma.creditReversal.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.creditReversal.count({ where }),
    ]);

    return { reversals, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ─── PATCH /v1/admin/credits/reversals/:id ─────────────────────────────────
  async patchReversal(user: JwtPayload, id: string, dto: PatchReversalDto) {
    // Read the reversal first to validate state + derive amounts. The actual status
    // flip uses a guarded updateMany to prevent a double-execute from double-debiting.
    const reversal = await this.prisma.creditReversal.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!reversal) throw new NotFoundException('Reversal not found');
    if (reversal.status !== 'PENDING_GIFSY') {
      throw new BadRequestException(`Reversal is already ${reversal.status}`);
    }

    const { action, approvedPaise, remarks } = dto;

    // requestedPaise is a BigInt from Prisma; Number() is safe (paise « MAX_SAFE_INTEGER).
    const requestedPaiseNum = Number(reversal.requestedPaise);

    if (action === ReversalAction.approve && approvedPaise !== undefined) {
      if (approvedPaise > requestedPaiseNum) {
        throw new BadRequestException('Approved amount cannot exceed requested amount');
      }
    }

    const newStatus =
      action === ReversalAction.reject
        ? 'REJECTED'
        : approvedPaise !== undefined && approvedPaise < requestedPaiseNum
          ? 'PARTIAL'
          : 'APPROVED';

    const finalApprovedPaise =
      action === ReversalAction.approve
        ? toPaiseBigInt(approvedPaise ?? requestedPaiseNum)
        : null;

    return this.prisma.$transaction(async (tx) => {
      // ── Concurrency guard ─────────────────────────────────────────────────
      // Only the first concurrent caller flips PENDING_GIFSY → newStatus (count===1).
      // A racing second call sees count===0 and throws, preventing double-debit.
      const claimed = await tx.creditReversal.updateMany({
        where: { id, status: 'PENDING_GIFSY' },
        data: {
          status: newStatus,
          approvedPaise: finalApprovedPaise,
          approvedBy: user.sub,
          approvedAt: new Date(),
          remarks: remarks ?? null,
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Reversal already processed');
      }

      // ── POINTS reversal → wallet clawback (#16 reversal) ─────────────────
      let clawbackShortfall = 0;
      if (action === ReversalAction.approve && reversal.awardType === 'POINTS') {
        // approvedPaise field holds approved whole points for POINTS-type reversals.
        const approvedPoints = Number(finalApprovedPaise ?? 0n);
        if (approvedPoints > 0) {
          // Resolve outletCode → partnerId (tenant-scoped).
          const outlet = await tx.outlet.findFirst({
            where: { outletCode: reversal.outletId, clientId: user.clientId },
            select: { partnerId: true },
          });

          if (outlet?.partnerId) {
            // Guard: check wallet existence without throwing (a throw aborts the tx).
            const wallet = await tx.wallet.findFirst({
              where: { partnerId: outlet.partnerId },
              select: { id: true },
            });

            if (wallet) {
              const cb = await this.walletService.clawbackAward(
                outlet.partnerId,
                approvedPoints,
                {
                  referenceType: 'CREDIT_REVERSAL',
                  referenceId: id,
                  sourceType: 'CREDIT_FIELD',
                  sourceId: reversal.fieldId,
                  description: `Clawback for reversal ${id} — batch POINTS reversal`,
                },
                tx,
              );
              clawbackShortfall = cb.shortfall;
            }
            // If no wallet: reversal still lands; points were never credited to
            // a wallet so there is nothing to claw back. This is a consistent no-op.
          }
        }
      }

      // ── GLM-1: PAYOUT reversal → cash clawback ────────────────────────────
      // A PAYOUT-type reversal means cash (not points) was (or will be) disbursed.
      //
      // WHY ITERATE ALL ENTRIES (not findFirst):
      //   One outlet+field can legitimately produce MULTIPLE CreditPayoutEntry rows
      //   across different batches (e.g. monthly top-ups). The old findFirst(orderBy
      //   createdAt desc) clawed back only the LATEST entry — silently missing any
      //   earlier outstanding entries for the same outlet+field+scope. We now iterate
      //   ALL matching entries and apply the correct action to each.
      //
      // ACTION PER ENTRY:
      //   PENDING / PROCESSING → status=REVERSED + downloadId=null (permanently
      //     removed from payability — GLM-2's re-download excludes REVERSED entries).
      //     IMPORTANT: must be REVERSED (not FAILED) so GLM-2 cannot resurrect them.
      //     Cash never left; no receivable.
      //   PAID → cash already disbursed; record its amount as a recoverable receivable
      //     and accumulate into clawbackShortfall.
      //   REVERSED → already clawed back (idempotent for a repeated reversal attempt);
      //     skip silently.
      //   FAILED → bank-rejected; cash never left; mark REVERSED to permanently
      //     remove from payability (GLM-2 would otherwise re-bank it, which we do NOT
      //     want after an approved reversal).
      let payoutClawbackNote: string | null = null;
      if (action === ReversalAction.approve && reversal.awardType === 'PAYOUT') {
        const approvedPaiseNum = Number(finalApprovedPaise ?? 0n);
        if (approvedPaiseNum > 0) {
          // Find ALL CreditPayoutEntry rows for this outlet+field combination
          // (tenant-scoped). outletId in the reversal is the outletCode (same as
          // CreditPayoutEntry.outletId).
          const payoutEntries = await tx.creditPayoutEntry.findMany({
            where: {
              clientId: user.clientId,
              outletId: reversal.outletId,
              fieldId: reversal.fieldId ?? undefined,
              // Only actionable statuses: REVERSED is already done (idempotent),
              // FAILED needs to be permanently removed (not re-bankable).
              status: { in: ['PENDING', 'PROCESSING', 'PAID', 'FAILED'] },
            },
            orderBy: { createdAt: 'desc' },
          });

          if (payoutEntries.length === 0) {
            // No matching payout entries found: the award may have been reversed before
            // confirmation or the entries were already deleted. Reversal lands cleanly.
            payoutClawbackNote = `No matching PAYOUT entries found for outlet ${reversal.outletId} / field ${reversal.fieldId ?? 'any'}; reversal recorded with no cash action.`;
          } else {
            let reversedCount = 0;
            let paidReceivablePaise = 0;
            const entryNotes: string[] = [];

            for (const payoutEntry of payoutEntries) {
              if (
                payoutEntry.status === 'PENDING' ||
                payoutEntry.status === 'PROCESSING' ||
                payoutEntry.status === 'FAILED'
              ) {
                // Cash not yet disbursed (PENDING/PROCESSING) OR bank-rejected (FAILED):
                // permanently remove from payability by marking REVERSED with downloadId=null.
                // REVERSED is the correct terminal status — GLM-2 excludes REVERSED from
                // re-banking, whereas FAILED is considered bank-rejected and re-bankable.
                await tx.creditPayoutEntry.update({
                  where: { id: payoutEntry.id },
                  data: { status: 'REVERSED', downloadId: null },
                });
                reversedCount++;
                entryNotes.push(
                  `entry ${payoutEntry.id} (was ${payoutEntry.status}) → REVERSED`,
                );
              } else if (payoutEntry.status === 'PAID') {
                // Cash already disbursed: record a recoverable receivable (off-platform).
                // Accumulate across all PAID entries for this outlet+field.
                paidReceivablePaise += Number(payoutEntry.amountPaise);
                entryNotes.push(
                  `entry ${payoutEntry.id} (PAID ₹${(Number(payoutEntry.amountPaise) / 100).toFixed(2)}) → recoverable receivable`,
                );
              }
            }

            // clawbackShortfall is the aggregate of all PAID entries' amounts.
            // This mirrors the POINTS-clawback shortfall pattern.
            if (paidReceivablePaise > 0) {
              clawbackShortfall = paidReceivablePaise;
            }

            payoutClawbackNote = [
              `GLM-1 clawback: ${payoutEntries.length} entries processed`,
              `(${reversedCount} reversed, ${paidReceivablePaise > 0 ? `₹${(paidReceivablePaise / 100).toFixed(2)} recoverable receivable` : 'no paid receivable'}).`,
              ...entryNotes,
            ].join(' | ');
          }
        }
      }

      // Persist the PENDING (un-reversible) portion for the reversal report:
      //   supposed = approvedPaise · reversed = approvedPaise - shortfallPaise · pending = shortfallPaise.
      // The client settles `pending` off-platform; the platform does nothing with it.
      // This applies to both POINTS shortfalls (wallet balance shortfall) and PAYOUT
      // shortfalls (already-paid cash recoverable).
      if (clawbackShortfall > 0) {
        await tx.creditReversal.update({
          where: { id },
          data: { shortfallPaise: toPaiseBigInt(clawbackShortfall) },
        });
      }

      const finalReversal = await tx.creditReversal.findFirst({ where: { id } });
      return { ...finalReversal, clawbackShortfall, payoutClawbackNote };
    });
  }
}
