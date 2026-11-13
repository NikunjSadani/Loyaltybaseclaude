import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Msg91Service } from '../../notifications/msg91.service';
import { loadHolidaySet } from '../../common/holiday-calendar';
import { loadReportRecipients, REPORTS_CLIENT_ID } from '../../common/report-recipients';
import { formatDateIST, istMonthKey } from '../../common/ist-date';
import {
  KYC_FIELD_SLA_KEY,
  KYC_GIFSY_SLA_KEY,
  KYC_FIELD_SLA_DEFAULT,
  KYC_GIFSY_SLA_DEFAULT,
  KYC_SLA_MIN_HOURS,
  KYC_SLA_MAX_HOURS,
  KYC_FIELD_STATUSES,
  KYC_GIFSY_STATUS,
  KycSlaTargets,
} from '../../common/kyc-sla-stage';
import { resolveMonthState, shiftMonthKey } from '../../sales-import/months/month-state';
import { latestTargetWriteByMonth, targetsNewerThanApply, tenantHasTargetNamesDef } from '../../sales-import/kpi/focus-data';
import { buildDailyOpsDigest, digestWindow, kycPendingBuckets, MAX_FAILED_REDEMPTION_ROWS } from './daily-ops-digest-report';
import type {
  DigestInput,
  DigestWindow,
  KycSection,
  MessagesSection,
  PayoutsSection,
  PointsSection,
  RedemptionsSection,
  ReportKey,
  SalesImportSection,
  SectionResult,
  TenantDigest,
  VisibilitySection,
  VouchersSection,
} from './report.types';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A Hubble order in PROCESSING longer than this is "stuck". */
export const HUBBLE_STUCK_MS = 30 * MINUTE_MS;
/** OTPs live minutes; bounding by expiresAt (indexed) keeps the OTP-failure scan off the whole table. */
const OTP_LOOKBACK_MS = DAY_MS;
/** Sales-import months considered for "open month" rows (same default range as the months list). */
const SALES_MONTHS_BACK = 5;
const KYC_PENDING_STATUSES = [...KYC_FIELD_STATUSES, KYC_GIFSY_STATUS];
const KYC_REJECT_STATUSES = ['REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED'] as const;
/** Case-insensitive match on the integration-stamped provider ('Hubble'). */
const HUBBLE_PROVIDER = { equals: 'hubble', mode: 'insensitive' as const };

/** Outcome of one run (returned from the endpoint for observability). */
interface ReportOutcome {
  key: ReportKey;
  status: 'sent' | 'no-recipients' | 'error';
  recipients?: number;
  tenants?: number;
  tenantsNeedingAttention?: number;
  error?: string;
}

interface TenantMeta {
  clientId: string;
  name: string;
  hubble: boolean;
  salesImport: boolean;
  visibility: boolean;
}

const num = (v: unknown): number => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : 0n);

/**
 * Runs the daily INTERNAL Gifsy email — the Daily Operations Digest (owner-approved 2026-11-13;
 * it replaced the separate Credits/Payouts + KYC actionables emails). Driven by Cloud Scheduler →
 * the secret-gated POST /v1/reports/run endpoint (Mon–Sat 09:30 IST).
 *
 * Does ALL the Prisma: per tenant, per section, each section in its own try/catch — a failing
 * section is passed to the builder as `{ ok:false }` and renders "couldn't load this section"
 * for that tenant (never silently omitted) while the rest of the email still sends. Then hands
 * the plain structs to the PURE builder and sends ONE email to the digest recipient list.
 * Always sends (an all-quiet day says so), unless there are no recipients.
 */
@Injectable()
export class ScheduledReportsService {
  private readonly logger = new Logger(ScheduledReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
  ) {}

  async runDailyReports(nowMs: number = Date.now()): Promise<{ dateLabel: string; reports: ReportOutcome[] }> {
    const dateLabel = formatDateIST(new Date(nowMs));
    const outcome = await this.runDigest(nowMs, dateLabel);
    this.logger.log(`Daily operations digest (${dateLabel}): ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ''}`);
    return { dateLabel, reports: [outcome] };
  }

  private async runDigest(nowMs: number, dateLabel: string): Promise<ReportOutcome> {
    const key: ReportKey = 'dailyDigest';
    try {
      const { dailyDigest: to } = await loadReportRecipients(this.prisma);
      if (to.length === 0) return { key, status: 'no-recipients' };

      const input = await this.collect(nowMs, dateLabel);
      const result = buildDailyOpsDigest(input);
      await this.msg91.sendEmail({ to, subject: result.subject, html: result.html });
      return {
        key,
        status: 'sent',
        recipients: to.length,
        tenants: input.tenants.length,
        tenantsNeedingAttention: result.tenantsNeedingAttention,
      };
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      this.logger.error(`Daily operations digest failed: ${error}`);
      return { key, status: 'error', error };
    }
  }

  /** Assemble the builder input. Public for the runner spec (exercises section isolation). */
  async collect(nowMs: number, dateLabel: string): Promise<DigestInput> {
    const window = digestWindow(nowMs);
    const tenants = await this.loadTenants();
    const holidays = await loadHolidaySet(this.prisma);
    const slaTargets = await this.loadSlaTargets();
    const defaultTargets: KycSlaTargets = { fieldHrs: KYC_FIELD_SLA_DEFAULT, gifsyHrs: KYC_GIFSY_SLA_DEFAULT };

    const out: TenantDigest[] = [];
    // Tenants one at a time (a handful of tenants; keeps the DB pool calm); sections within a
    // tenant one at a time too — each is a few indexed count/aggregate queries.
    for (const t of tenants) {
      const c = t.clientId;
      const digest: TenantDigest = {
        clientId: c,
        name: t.name,
        kyc: await this.section('kyc', c, () => this.kyc(c, window, slaTargets.get(c) ?? defaultTargets, holidays, nowMs)),
        points: await this.section('points', c, () => this.points(c, window)),
        redemptions: await this.section('redemptions', c, () => this.redemptions(c, window)),
        payouts: await this.section('payouts', c, () => this.payouts(c, window)),
        messages: await this.section('messages', c, () => this.messages(c, window)),
      };
      if (t.hubble) digest.vouchers = await this.section('vouchers', c, () => this.vouchers(c, window, nowMs));
      if (t.visibility) digest.visibility = await this.section('visibility', c, () => this.visibility(c, window));
      if (t.salesImport) digest.salesImport = await this.section('salesImport', c, () => this.salesImport(c, window, nowMs));
      out.push(digest);
    }

    const unattributedOtpFailed = await this.section('otp-unattributed', '-', () =>
      this.prisma.otpCode.count({
        where: {
          userId: null,
          deliveryStatus: 'FAILED',
          expiresAt: { gte: new Date(window.startMs - OTP_LOOKBACK_MS) },
          updatedAt: { gte: new Date(window.startMs), lt: new Date(window.endMs) },
        },
      }),
    );

    return { window, dateLabel, tenants: out, unattributedOtpFailed };
  }

  /** Run one section loader, isolating any failure to that section. */
  private async section<T>(label: string, clientId: string, load: () => Promise<T>): Promise<SectionResult<T>> {
    try {
      return { ok: true, data: await load() };
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      this.logger.error(`Digest section "${label}" failed for ${clientId}: ${error}`);
      // Keep the rendered reason short — the full error is in the logs.
      return { ok: false, error: error.split('\n')[0].slice(0, 160) };
    }
  }

  private range(w: DigestWindow) {
    return { gte: new Date(w.startMs), lt: new Date(w.endMs) };
  }

  // ── Sections ──────────────────────────────────────────────────────────────────────────────

  private async kyc(
    clientId: string,
    w: DigestWindow,
    targets: KycSlaTargets,
    holidays: Set<string>,
    nowMs: number,
  ): Promise<KycSection> {
    const inWindow = this.range(w);
    const submitted = await this.prisma.kycSubmission.count({ where: { user: { clientId }, submittedAt: inWindow } });
    const approved = await this.prisma.kycSubmission.count({
      where: { user: { clientId }, status: 'APPROVED', approvedAt: inWindow },
    });
    const rejected = await this.prisma.kycStatusHistory.count({
      where: { toStatus: { in: [...KYC_REJECT_STATUSES] }, createdAt: inWindow, kycSubmission: { user: { clientId } } },
    });
    const pendingRows = await this.prisma.kycSubmission.findMany({
      where: { user: { clientId }, status: { in: KYC_PENDING_STATUSES as never } },
      select: {
        status: true,
        submittedAt: true,
        createdAt: true,
        statusHistory: { where: { toStatus: KYC_GIFSY_STATUS as never }, select: { toStatus: true, createdAt: true } },
      },
    });
    const { field, gifsy } = kycPendingBuckets(pendingRows as never, targets, holidays, nowMs);
    return { submitted, approved, rejected, field, gifsy };
  }

  private async points(clientId: string, w: DigestWindow): Promise<PointsSection> {
    const groups = await this.prisma.pointsLedger.groupBy({
      by: ['transactionType'],
      where: {
        createdAt: this.range(w),
        transactionType: { in: ['EARN', 'REDEEM', 'EXPIRE'] },
        wallet: { partner: { clientId } },
      },
      _sum: { points: true },
    });
    const sum = (t: string) => num(groups.find((g) => g.transactionType === t)?._sum?.points);
    const negativeWallets = await this.prisma.wallet.count({
      where: { redeemablePoints: { lt: 0 }, partner: { clientId } },
    });
    return {
      credited: sum('EARN'),
      redeemed: Math.abs(sum('REDEEM')),
      expired: Math.abs(sum('EXPIRE')),
      negativeWallets,
    };
  }

  private async redemptions(clientId: string, w: DigestWindow): Promise<RedemptionsSection> {
    const inWindow = this.range(w);
    const requested = await this.prisma.redemptionOrder.count({ where: { partner: { clientId }, createdAt: inWindow } });
    const completed = await this.prisma.redemptionStatusHistory.count({
      where: { toStatus: 'DELIVERED', createdAt: inWindow, order: { partner: { clientId } } },
    });
    const failedWhere = { toStatus: 'FAILED' as const, createdAt: inWindow, order: { partner: { clientId } } };
    const failed = await this.prisma.redemptionStatusHistory.count({ where: failedWhere });
    const rows =
      failed === 0
        ? []
        : await this.prisma.redemptionStatusHistory.findMany({
            where: failedWhere,
            orderBy: { createdAt: 'desc' },
            take: MAX_FAILED_REDEMPTION_ROWS,
            select: {
              notes: true,
              order: {
                select: {
                  cancelReason: true,
                  partner: { select: { businessName: true, partnerCode: true } },
                  reward: { select: { name: true } },
                },
              },
            },
          });
    return {
      requested,
      completed,
      failed,
      failedRows: rows.map((r) => ({
        outlet: [r.order?.partner?.businessName, r.order?.partner?.partnerCode ? `(${r.order.partner.partnerCode})` : '']
          .filter(Boolean)
          .join(' '),
        reward: r.order?.reward?.name ?? '',
        reason: r.order?.cancelReason ?? r.notes ?? '',
      })),
    };
  }

  private async vouchers(clientId: string, w: DigestWindow, nowMs: number): Promise<VouchersSection> {
    const inWindow = this.range(w);
    const hubbleOrder = { partner: { clientId }, voucherProvider: HUBBLE_PROVIDER };
    const issued = await this.prisma.redemptionStatusHistory.count({
      where: { toStatus: 'DELIVERED', createdAt: inWindow, order: hubbleOrder },
    });
    const failed = await this.prisma.redemptionStatusHistory.count({
      where: { toStatus: 'FAILED', createdAt: inWindow, order: hubbleOrder },
    });
    // PROCESSING = handed to Hubble, waiting for its webhook. updatedAt is stamped when the order
    // entered PROCESSING (any later write would be a status move / reconcile flag).
    const stuckProcessing = await this.prisma.redemptionOrder.count({
      where: { ...hubbleOrder, status: 'PROCESSING', updatedAt: { lt: new Date(nowMs - HUBBLE_STUCK_MS) } },
    });
    const needsReconcile = await this.prisma.redemptionOrder.count({
      where: { partner: { clientId }, metadata: { path: ['hubbleNeedsReconcile'], equals: true } },
    });
    return { issued, failed, stuckProcessing, needsReconcile };
  }

  private async payouts(clientId: string, w: DigestWindow): Promise<PayoutsSection> {
    const inWindow = this.range(w);
    const batches = await this.prisma.creditBatch.aggregate({
      where: { clientId, status: { in: ['CONFIRMED', 'PARTIALLY_REVERSED'] }, confirmedAt: inWindow },
      _count: { _all: true },
      _sum: { totalPoints: true, totalPayoutPaise: true },
    });
    const creditPaid = await this.prisma.creditPayoutEntry.aggregate({
      where: { clientId, status: 'PAID', paidAt: inWindow },
      _count: { _all: true },
      _sum: { amountPaise: true },
    });
    const redemptionPaid = await this.prisma.payoutTransaction.aggregate({
      where: { partner: { clientId }, status: 'SUCCESS', completedAt: inWindow },
      _count: { _all: true },
      _sum: { amountPaise: true },
    });
    const creditFailed = await this.prisma.creditPayoutEntry.count({
      where: { clientId, status: 'FAILED', updatedAt: inWindow },
    });
    const txnFailed = await this.prisma.payoutTransaction.count({
      where: { partner: { clientId }, status: { in: ['FAILED', 'REVERSED'] }, updatedAt: inWindow },
    });
    const awaiting = await this.prisma.creditPayoutEntry.aggregate({
      where: { clientId, status: 'PROCESSING' },
      _count: { _all: true },
      _sum: { amountPaise: true },
    });
    return {
      batchesConfirmed: num(batches._count?._all),
      batchPoints: num(batches._sum?.totalPoints),
      batchPayoutPaise: big(batches._sum?.totalPayoutPaise),
      creditPaid: num(creditPaid._count?._all),
      creditPaidPaise: big(creditPaid._sum?.amountPaise),
      redemptionPaid: num(redemptionPaid._count?._all),
      redemptionPaidPaise: big(redemptionPaid._sum?.amountPaise),
      failedOrReturned: creditFailed + txnFailed,
      awaitingUtr: num(awaiting._count?._all),
      awaitingUtrPaise: big(awaiting._sum?.amountPaise),
    };
  }

  /** Failures are counted when they were RECORDED (updatedAt) in the window — a DLR can land after the send. */
  private async messages(clientId: string, w: DigestWindow): Promise<MessagesSection> {
    const inWindow = this.range(w);
    const receipts = await this.prisma.messageDeliveryReceipt.groupBy({
      by: ['channel'],
      where: { clientId, status: 'FAILED', updatedAt: inWindow },
      _count: { _all: true },
    });
    const byChannel = (ch: string) => num(receipts.find((r) => r.channel === ch)?._count?._all);
    const otpFailed = await this.prisma.otpCode.count({
      where: {
        user: { clientId },
        deliveryStatus: 'FAILED',
        expiresAt: { gte: new Date(w.startMs - OTP_LOOKBACK_MS) },
        updatedAt: inWindow,
      },
    });
    const broadcastFailed = await this.prisma.whatsappBroadcastRecipient.count({
      where: { clientId, status: 'FAILED', updatedAt: inWindow },
    });
    return { otpFailed, smsFailed: byChannel('SMS'), whatsappFailed: byChannel('WHATSAPP'), broadcastFailed };
  }

  private async visibility(clientId: string, w: DigestWindow): Promise<VisibilitySection> {
    const inWindow = this.range(w);
    const submitted = await this.prisma.visibilityCaptureSubmission.count({ where: { clientId, createdAt: inWindow } });
    const approved = await this.prisma.visibilityCapture.count({ where: { clientId, status: 'APPROVED', reviewedAt: inWindow } });
    const rejected = await this.prisma.visibilityCapture.count({
      where: { clientId, status: { in: ['REJECTED', 'CHANGES_REQUESTED'] }, reviewedAt: inWindow },
    });
    const pending = await this.prisma.visibilityCapture.count({ where: { clientId, status: 'SUBMITTED' } });
    return { submitted, approved, rejected, pending };
  }

  /**
   * Imports processed/failed in the window + every OPEN month (last 6, not future) with its last
   * apply and the "targets changed since apply" flag — the SAME rule SalesMonthsService.list uses
   * (resolveMonthState + tenantHasTargetNamesDef + latestTargetWriteByMonth + targetsNewerThanApply).
   */
  private async salesImport(clientId: string, w: DigestWindow, nowMs: number): Promise<SalesImportSection> {
    const inWindow = this.range(w);
    const processed = await this.prisma.salesImport.count({ where: { clientId, status: 'READY', finishedAt: inWindow } });
    const failed = await this.prisma.salesImport.count({ where: { clientId, status: 'FAILED', updatedAt: inWindow } });

    const current = istMonthKey(new Date(nowMs));
    const months: string[] = [];
    for (let i = SALES_MONTHS_BACK; i >= 0; i--) months.push(shiftMonthKey(current, -i));
    const rows = await this.prisma.salesMonthStatus.findMany({ where: { clientId, month: { in: months } } });
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    const open = months.filter((m) => {
      const st = resolveMonthState(m, current, byMonth.get(m) ?? null);
      return st.state === 'OPEN' && st.relation !== 'FUTURE';
    });
    const focusOn = open.length > 0 && (await tenantHasTargetNamesDef(this.prisma, clientId));
    const targetTimes = focusOn ? await latestTargetWriteByMonth(this.prisma, clientId, open) : new Map<string, Date>();

    return {
      processed,
      failed,
      openMonths: open.reverse().map((m) => {
        const lastAppliedAt = byMonth.get(m)?.lastAppliedAt ?? null;
        const targetAt = targetTimes.get(m);
        return {
          month: m,
          lastAppliedAtMs: lastAppliedAt ? lastAppliedAt.getTime() : null,
          targetsChangedSinceApply: targetsNewerThanApply(targetAt ?? null, lastAppliedAt, targetAt !== undefined),
        };
      }),
    };
  }

  // ── Shared inputs ─────────────────────────────────────────────────────────────────────────

  /**
   * All ACTIVE tenants (minus the Gifsy operator row) with display name and the gates for the
   * optional sections: features.hubbleVoucherEnabled, features.salesImport, and the per-tenant
   * `visibilityEnabled` program setting (=== true, the same rule as TenantSettingsService).
   */
  private async loadTenants(): Promise<TenantMeta[]> {
    const clients = await this.prisma.client.findMany({
      where: { status: 'ACTIVE', id: { not: REPORTS_CLIENT_ID } },
      select: { id: true, internalName: true, branding: true, features: true },
    });
    const ids = clients.map((c) => c.id);
    const visRows =
      ids.length === 0
        ? []
        : await this.prisma.programSetting.findMany({
            where: { clientId: { in: ids }, settingKey: 'visibilityEnabled' },
            select: { clientId: true, settingValue: true },
          });
    const visibilityOn = new Set(visRows.filter((r) => r.settingValue === true).map((r) => r.clientId));
    return clients.map((c) => {
      const branding = (c.branding ?? {}) as Record<string, unknown>;
      const features = (c.features ?? {}) as Record<string, unknown>;
      const name = typeof branding.displayName === 'string' && branding.displayName.trim() ? branding.displayName : c.internalName;
      return {
        clientId: c.id,
        name,
        hubble: features.hubbleVoucherEnabled === true,
        salesImport: features.salesImport === true,
        visibility: visibilityOn.has(c.id),
      };
    });
  }

  /** clientId → the two-stage KYC SLA targets { fieldHrs, gifsyHrs } (validated 1–168); tenants
   *  without a row default to 24/96. */
  private async loadSlaTargets(): Promise<Map<string, KycSlaTargets>> {
    const rows = await this.prisma.programSetting.findMany({
      where: { settingKey: { in: [KYC_FIELD_SLA_KEY, KYC_GIFSY_SLA_KEY] } },
      select: { clientId: true, settingKey: true, settingValue: true },
    });
    const bound = (raw: unknown, def: number): number => {
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      return Number.isInteger(n) && n >= KYC_SLA_MIN_HOURS && n <= KYC_SLA_MAX_HOURS ? n : def;
    };
    const map = new Map<string, KycSlaTargets>();
    for (const r of rows) {
      const cur = map.get(r.clientId) ?? { fieldHrs: KYC_FIELD_SLA_DEFAULT, gifsyHrs: KYC_GIFSY_SLA_DEFAULT };
      if (r.settingKey === KYC_FIELD_SLA_KEY) cur.fieldHrs = bound(r.settingValue, KYC_FIELD_SLA_DEFAULT);
      else if (r.settingKey === KYC_GIFSY_SLA_KEY) cur.gifsyHrs = bound(r.settingValue, KYC_GIFSY_SLA_DEFAULT);
      map.set(r.clientId, cur);
    }
    return map;
  }
}
