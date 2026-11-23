import { internalSecretConfigured } from '../../common/internal-call';
import { heldDigestFigures } from '../../wallet/held-opening-balances/held-balance-facts';
import { TdsService } from '../../tds/tds.service';
import { FundService } from '../../fund/fund.service';
import { financialYear } from '../../tds/tds.helpers';
import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { loadMonthStatusCounts, loadReviewActions } from '../../visibility/visibility-metrics';
import { Msg91Service } from '../../notifications/msg91.service';
import { loadHolidaySet } from '../../common/holiday-calendar';
import {
  allowedRecipientDomains,
  loadReportRecipients,
  REPORTS_CLIENT_ID,
  splitRecipientsByDomain,
} from '../../common/report-recipients';
import { formatDateIST, istMonthKey } from '../../common/ist-date';
import {
  KYC_FIELD_SLA_KEY,
  KYC_GIFSY_SLA_KEY,
  KYC_FIELD_SLA_DEFAULT,
  KYC_GIFSY_SLA_DEFAULT,
  KYC_SLA_MIN_HOURS,
  KYC_SLA_MAX_HOURS,
  KycSlaTargets,
} from '../../common/kyc-sla-stage';
import { resolveMonthState, shiftMonthKey } from '../../sales-import/months/month-state';
import { latestTargetWriteByMonth, targetsNewerThanApply, tenantHasTargetNamesDef } from '../../sales-import/kpi/focus-data';
import { loadBillingProgress, summarizeBillingProgress } from '../../admin-core/dashboards/billing-progress';
import { kycAddressableOutletWhere, KYC_LATEST_SUBMISSION_SELECT } from '../../admin-core/dashboards/kyc-pending-sla';
import {
  DISPERSAL_RETRY_MIN_AGE_MS,
  SETTLE_FAILURES_BEFORE_ALERT,
  failedMayStillCompleteWhere,
  HUBBLE_KNOWN_STATUSES,
  ALERT_LOOKUP_FAILED,
  ALERT_NO_ORDER_UNVERIFIED,
} from '../../voucher-dispersal/voucher-dispersal.processor';
import { HUBBLE_NO_ORDER_REFUND_REASON } from '../../rewards/rewards.service';
import { blockedWalletsWhere, unsequencedWithHistoryWhere } from '../../wallet/wallet.service';
import { buildDailyOpsDigest, failedSections, kycPendingBuckets, MAX_FAILED_REDEMPTION_ROWS } from './daily-ops-digest-report';
import {
  DIGEST_RUN_STATE_KEY,
  DigestRunState,
  DigestRunStatus,
  leaseIsLive,
  nextFailStreaks,
  parseRunState,
  planDigestWindow,
  RUN_BUDGET_MS,
  WindowPlan,
} from './digest-run-state';
import type {
  BillingSection,
  DigestInput,
  DigestWindow,
  KycSection,
  LocationSection,
  MessagesSection,
  PayoutsSection,
  PointsSection,
  RedemptionsSection,
  ReportKey,
  SalesImportSection,
  SectionResult,
  TenantDigest,
  TenantStatus,
  VisibilitySection,
  VoucherDispersalSection,
  VouchersSection, TdsExcessSection } from './report.types';
import { FENCE_BLOCK_ENTITY, POOR_ACCURACY_M, isLocationRequired } from '../../common/location-gate.helper';
import { SALES_ROLES } from '../location/location-compliance-report';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A Hubble order in PROCESSING longer than this is "stuck". */
export const HUBBLE_STUCK_MS = 30 * MINUTE_MS;
/** OTPs live minutes; bounding by expiresAt (indexed) keeps the OTP-failure scan off the whole table. */
const OTP_LOOKBACK_MS = DAY_MS;
/** Sales-import months considered for "open month" rows (same default range as the months list). */
const SALES_MONTHS_BACK = 5;
const KYC_REJECT_STATUSES = ['REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED'] as const;
/** Case-insensitive match on the integration-stamped provider ('Hubble'). */
const HUBBLE_PROVIDER = { equals: 'hubble', mode: 'insensitive' as const };
/** Orders whose FAILED flip refunded them (the refund paths zero pointsDeducted). */
const REFUNDED_OR_CLOSED_ORDER = ['FAILED', 'CANCELLED', 'RETURNED'] as const;

/** Outcome of one run (returned from the endpoint for observability; the controller maps it to an HTTP status). */
export interface ReportOutcome {
  key: ReportKey;
  /**
   * sent        — emailed with complete data (window recorded as the last successful send).
   * degraded    — emailed, but something did not load (any section, a time-budget skip, a shared input, the run state) — NOT a
   *               successful send: the window is not advanced and the HTTP status is 500.
   * skipped     — an email (complete or not) already went out today (one per IST day); force=true re-runs.
   * no-recipients / in-progress / error — nothing sent (409 / 409 / 500).
   */
  status: DigestRunStatus;
  recipients?: number;
  tenants?: number;
  tenantsNeedingAttention?: number;
  attentionItems?: number;
  window?: { startMs: number; endMs: number; label: string };
  /** Configured addresses NOT sent to (not on an allowed internal domain). */
  droppedRecipients?: string[];
  /** What did not load (degraded runs): tenant sections, Gifsy-wide sections, shared inputs, time budget. */
  failedSections?: string[];
  /** Run-level problems shown in the email's "incomplete" box. */
  notices?: string[];
  /** 'already-sent' with the time of that send, when skipped. */
  skipped?: 'already-sent';
  lastSentAt?: string;
  error?: string;
}

interface TenantMeta {
  clientId: string;
  name: string;
  status: TenantStatus;
  hubble: boolean;
  salesImport: boolean;
  visibility: boolean;
  /** features.visibilityCaptureMode is PHOTO_APPROVAL (the default when unset) — the capture-and-review flow. */
  visibilityPhoto: boolean;
  /** features.requireLocation (location gate). */
  requireLocation: boolean;
}

const num = (v: unknown): number => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : 0n);
/** When the last email (complete or not) went out. */
const lastEmailedAt = (s: DigestRunState): string | undefined => {
  const all = [s.lastSuccess?.sentAt, s.lastAttempted?.sentAt].filter((x): x is string => !!x);
  return all.sort().pop();
};
/** The error a section skipped by the time budget carries. */
export const TIME_BUDGET_SKIP = 'not loaded (time budget)';
const short = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0].slice(0, 160);

/**
 * Runs the daily INTERNAL Gifsy email — the Daily Operations Digest (owner-approved 2026-11-13;
 * it replaced the separate Credits/Payouts + KYC actionables emails). Driven by Cloud Scheduler →
 * the secret-gated POST /v1/reports/run endpoint (Mon–Sat 09:30 IST).
 *
 * Lifecycle of one run (digest-run-state.ts): read the run state → plan the window (from the last COMPLETE
 * send, ≤ 7 days; skip when an email already went out today unless force) → load recipients (internal domains
 * only; others dropped loudly) → take the lease (compare-and-set) → collect within the time budget → send →
 * record the outcome (compare-and-set, only while still holding the lease). Every failure is visible: the
 * endpoint answers non-2xx for degraded / error / no-recipients / in-progress so Cloud Scheduler marks the
 * run failed.
 *
 * Collect does ALL the Prisma: per tenant, per section, each section in its own try/catch — a failing
 * section is passed to the builder as `{ ok:false }` and renders "couldn't load this section". ANY part
 * that did not load (a tenant section, the Gifsy-wide OTP / dispersal sections, a shared input, or a section
 * skipped by the time budget) makes the run DEGRADED: the email still goes out, but the window is not
 * advanced, so the next email repeats it (and says so at the top).
 */
@Injectable()
export class ScheduledReportsService {
  private readonly logger = new Logger(ScheduledReportsService.name);
  /** Wall clock for the time budget + lease (overridable in specs; the report clock is `nowMs`). */
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
    // Owner 2026-11-18: the digest flags 194R TDS taken in excess, from the SAME 194R report the screen shows.
    private readonly tds: TdsService,
    // Visibility digest lines (PHOTO_APPROVAL tenants): the in-scope rule needs the tenant's visibilityConfig.
    private readonly tenantSettings: TenantSettingsService,
    // Fund reconciliation: the per-client digest line + the once-a-day low-balance e-mails to client recipients.
    private readonly fund: FundService,
  ) {}

  async runDailyReports(
    nowMs: number = Date.now(),
    opts: { force?: boolean } = {},
  ): Promise<{ dateLabel: string; reports: ReportOutcome[] }> {
    const dateLabel = formatDateIST(new Date(nowMs));
    const outcome = await this.runDigest(nowMs, dateLabel, opts.force === true);
    const msg = `Daily operations digest (${dateLabel}${opts.force ? ', force' : ''}): ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ''}`;
    if (outcome.status === 'sent' || outcome.status === 'skipped') this.logger.log(msg);
    else this.logger.error(msg);
    return { dateLabel, reports: [outcome] };
  }

  private async runDigest(nowMs: number, dateLabel: string, force: boolean): Promise<ReportOutcome> {
    const key: ReportKey = 'dailyDigest';
    const deadlineMs = this.clock() + RUN_BUDGET_MS;

    // 1. Run state → window (fast path; re-checked under the lease). A read failure falls back to the fixed
    //    rule and DEGRADES the run, and the state is then never written back (it would erase the history).
    let state: DigestRunState = {};
    let stateReadError: string | null = null;
    try {
      state = parseRunState((await this.readStateRow())?.settingValue);
    } catch (e) {
      stateReadError = short(e);
      this.logger.error(`Digest run state could not be read: ${stateReadError}`);
    }
    let plan: WindowPlan = planDigestWindow(nowMs, stateReadError ? {} : state, force);
    const persist = !stateReadError;
    if (plan.skip) {
      return { key, status: 'skipped', skipped: 'already-sent', lastSentAt: lastEmailedAt(state), window: plan.window };
    }

    // 2. Recipients — internal domains only. A read failure is an ERROR (never mistaken for "nobody").
    let to: string[];
    let dropped: string[];
    try {
      const { dailyDigest } = await loadReportRecipients(this.prisma);
      const split = splitRecipientsByDomain(dailyDigest, allowedRecipientDomains());
      to = split.allowed;
      dropped = split.blocked;
    } catch (e) {
      const error = `couldn't read the recipient list: ${short(e)}`;
      if (persist) await this.recordAttempt({ status: 'error', error, window: plan.window });
      return { key, status: 'error', error, window: plan.window };
    }
    if (dropped.length > 0) {
      this.logger.warn(`Daily operations digest: NOT sending to non-internal address(es): ${dropped.join(', ')}`);
    }
    if (to.length === 0) {
      if (persist) await this.recordAttempt({ status: 'no-recipients', window: plan.window });
      return { key, status: 'no-recipients', droppedRecipients: dropped, window: plan.window };
    }

    // 3. Lease — compare-and-set on a FRESH read; the plan is recomputed from that same state.
    let token: string | null = null;
    if (persist) {
      const claim = await this.claimLease(nowMs, force);
      if (claim.result === 'in-progress') {
        return { key, status: 'in-progress', error: 'another digest run is in progress', window: plan.window };
      }
      if (claim.result === 'already-sent') {
        return { key, status: 'skipped', skipped: 'already-sent', lastSentAt: lastEmailedAt(claim.state), window: claim.plan.window };
      }
      token = claim.token;
      state = claim.state;
      plan = claim.plan;
    }

    // 4. Collect (within the budget) → build → send → record.
    try {
      const input = await this.collect(nowMs, dateLabel, plan.window, deadlineMs);
      if (stateReadError) {
        input.sharedFailures = [{ key: 'shared/run-history', label: 'run history' }, ...(input.sharedFailures ?? [])];
        input.runNotices = [
          `Couldn't read the digest run history (${stateReadError}) — the window is the fixed "since the previous working day" rule, so activity since the last complete send may be missed or repeated, and a repeat send today is not blocked.`,
          ...(input.runNotices ?? []),
        ];
      }
      input.runNotices = [...plan.notices, ...(input.runNotices ?? [])];
      input.windowNotes = plan.notes;
      input.repeatNotice = plan.repeatNotice;
      input.droppedRecipients = dropped;
      const failed = failedSections(input);
      const streaks = nextFailStreaks(state.failStreaks, failed.map((f) => f.key));
      const maxRuns = Math.max(0, ...Object.values(streaks));
      if (maxRuns > 0) {
        input.incompleteStreak = {
          runs: maxRuns,
          sections: failed.filter((f) => streaks[f.key] === maxRuns).map((f) => f.label),
        };
      }
      const result = buildDailyOpsDigest(input);
      await this.msg91.sendEmail({ to, subject: result.subject, html: result.html });
      const status: DigestRunStatus = failed.length > 0 ? 'degraded' : 'sent';
      const saveError = !persist
        ? null
        : await this.finishRun(token, nowMs, {
            status,
            window: plan.window,
            recipients: to.length,
            forced: plan.forced,
            failedSections: failed.map((f) => f.label),
            failStreaks: streaks,
            error: failed.length > 0 ? `not loaded: ${failed.map((f) => f.label).join('; ')}`.slice(0, 500) : undefined,
          });
      return {
        key,
        status: saveError ? 'error' : status,
        recipients: to.length,
        tenants: input.tenants.length,
        tenantsNeedingAttention: result.tenantsNeedingAttention,
        attentionItems: result.attentionItems,
        window: plan.window,
        ...(failed.length > 0 ? { failedSections: failed.map((f) => f.label) } : {}),
        ...(dropped.length > 0 ? { droppedRecipients: dropped } : {}),
        ...((input.runNotices?.length ?? 0) > 0 ? { notices: input.runNotices } : {}),
        ...(saveError ? { error: `the email WAS sent, but the run could not be recorded (${saveError}) — the next run may repeat this window` } : {}),
      };
    } catch (e) {
      const error = short(e);
      this.logger.error(`Daily operations digest failed: ${error}`);
      if (persist) await this.finishRun(token, nowMs, { status: 'error', window: plan.window, error });
      return { key, status: 'error', error, window: plan.window };
    }
  }

  // ── Run state persistence (compare-and-set on a fresh read; never a blind overwrite) ─────────

  private readStateRow() {
    return this.prisma.programSetting.findUnique({
      where: { clientId_settingKey: { clientId: REPORTS_CLIENT_ID, settingKey: DIGEST_RUN_STATE_KEY } },
      select: { id: true, updatedAt: true, settingValue: true },
    });
  }

  /**
   * Apply `mutate` to the CURRENT state: read fresh, compute, write with `updateMany where {id, updatedAt}`
   * (or a create that collides on the unique key). A concurrent write makes the CAS miss → re-read and retry
   * (≤ 3). `mutate` returning null = precondition failed (nothing written).
   */
  private async mutateRunState(
    mutate: (cur: DigestRunState) => DigestRunState | null,
  ): Promise<'written' | 'precondition' | 'contended'> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.readStateRow();
      const next = mutate(parseRunState(row?.settingValue));
      if (next === null) return 'precondition';
      const value = next as unknown as Prisma.InputJsonValue;
      if (row) {
        const won = await this.prisma.programSetting.updateMany({
          where: { id: row.id, updatedAt: row.updatedAt },
          data: { settingValue: value },
        });
        if (won.count === 1) return 'written';
        continue;
      }
      try {
        await this.prisma.programSetting.create({
          data: { clientId: REPORTS_CLIENT_ID, settingKey: DIGEST_RUN_STATE_KEY, settingValue: value, category: 'reports', isEditable: false },
        });
        return 'written';
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    return 'contended';
  }

  /**
   * Take the lease. Refused while another run's lease is live (TTL RUN_LEASE_MS; a forced run may break a
   * lease older than the run budget) or when — on the fresh state — an email already went out today.
   */
  private async claimLease(
    nowMs: number,
    force: boolean,
  ): Promise<
    | { result: 'claimed'; token: string; state: DigestRunState; plan: WindowPlan }
    | { result: 'in-progress' }
    | { result: 'already-sent'; state: DigestRunState; plan: WindowPlan }
  > {
    const token = randomUUID();
    // Filled in by the mutator (the LAST attempt's fresh read wins).
    const seen: { why: 'in-progress' | 'already-sent'; state: DigestRunState; plan: WindowPlan | null } = {
      why: 'in-progress',
      state: {},
      plan: null,
    };
    const res = await this.mutateRunState((cur) => {
      seen.state = cur;
      if (leaseIsLive(cur, this.clock(), force)) {
        seen.why = 'in-progress';
        return null;
      }
      const plan = planDigestWindow(nowMs, cur, force);
      seen.plan = plan;
      if (plan.skip) {
        seen.why = 'already-sent';
        return null;
      }
      return { ...cur, running: { startedAt: new Date(this.clock()).toISOString(), token } };
    });
    if (res === 'written' && seen.plan) return { result: 'claimed', token, state: seen.state, plan: seen.plan };
    if (res === 'precondition' && seen.why === 'already-sent' && seen.plan) {
      return { result: 'already-sent', state: seen.state, plan: seen.plan };
    }
    return { result: 'in-progress' };
  }

  /**
   * Record the outcome and release the lease — ONLY while this run still holds it (token match on the fresh
   * state), merged into that fresh state. A runner whose lease expired and was taken over writes nothing (its
   * outcome is reported as an error instead). Returns an error string when nothing could be recorded.
   */
  private async finishRun(
    token: string | null,
    nowMs: number,
    o: {
      status: DigestRunStatus;
      window: DigestWindow;
      recipients?: number;
      forced?: boolean;
      failedSections?: string[];
      failStreaks?: Record<string, number>;
      error?: string;
    },
  ): Promise<string | null> {
    const at = new Date(nowMs).toISOString();
    try {
      const res = await this.mutateRunState((cur) => {
        if (!token || cur.running?.token !== token) return null;
        const next: DigestRunState = {
          ...cur,
          running: null,
          lastAttempt: {
            at,
            status: o.status,
            windowStartMs: o.window.startMs,
            windowEndMs: o.window.endMs,
            ...(o.recipients !== undefined ? { recipients: o.recipients } : {}),
            ...(o.error ? { error: o.error } : {}),
          },
        };
        if (o.status === 'sent' || o.status === 'degraded') {
          const emailed = {
            windowStartMs: o.window.startMs,
            windowEndMs: o.window.endMs,
            sentAt: at,
            recipients: o.recipients ?? 0,
            status: o.status,
            ...(o.failedSections && o.failedSections.length > 0 ? { failedSections: o.failedSections } : {}),
            ...(o.forced ? { forced: true } : {}),
          };
          next.lastAttempted = emailed;
          next.failStreaks = o.failStreaks ?? {};
          if (o.status === 'sent') next.lastSuccess = { ...emailed, status: 'sent' };
        }
        return next;
      });
      if (res === 'written') return null;
      const err =
        res === 'precondition'
          ? 'this run no longer holds the run lease (it expired and another run took over) — its outcome was not recorded'
          : 'the run state kept changing under concurrent writes';
      this.logger.error(`Digest run state not written (${o.status}): ${err}`);
      return err;
    } catch (e) {
      const err = short(e);
      this.logger.error(`Digest run state could not be written (${o.status}): ${err}`);
      return err;
    }
  }

  /** Record an attempt that never took the lease (no-recipients / early error): ONLY lastAttempt changes. */
  private async recordAttempt(o: { status: DigestRunStatus; window: DigestWindow; error?: string }): Promise<void> {
    try {
      await this.mutateRunState((cur) => ({
        ...cur,
        lastAttempt: {
          at: new Date(this.clock()).toISOString(),
          status: o.status,
          windowStartMs: o.window.startMs,
          windowEndMs: o.window.endMs,
          ...(o.error ? { error: o.error } : {}),
        },
      }));
    } catch (e) {
      this.logger.error(`Digest run state could not be written (${o.status}): ${short(e)}`);
    }
  }

  // ── Collect ─────────────────────────────────────────────────────────────────────────────────

  /** Assemble the builder input for `window`. Public for the runner spec (exercises section isolation). */
  async collect(nowMs: number, dateLabel: string, window: DigestWindow, deadlineMs = Infinity): Promise<DigestInput> {
    const runNotices: string[] = [];
    const sharedFailures: Array<{ key: string; label: string }> = [];
    const section = <T,>(label: string, clientId: string, load: () => Promise<T>) => this.section(label, clientId, load, deadlineMs);
    const defaultTargets: KycSlaTargets = { fieldHrs: KYC_FIELD_SLA_DEFAULT, gifsyHrs: KYC_GIFSY_SLA_DEFAULT };

    let tenants: TenantMeta[] = [];
    try {
      tenants = await this.loadTenants();
    } catch (e) {
      const err = short(e);
      this.logger.error(`Digest: tenant list failed: ${err}`);
      sharedFailures.push({ key: 'shared/tenants', label: 'tenant list' });
      runNotices.push(`Couldn't load the tenant list (${err}) — this digest has NO tenant sections. Only the Gifsy-wide figures below are real.`);
    }
    let holidays = new Set<string>();
    try {
      holidays = await loadHolidaySet(this.prisma);
    } catch (e) {
      const err = short(e);
      this.logger.error(`Digest: holiday calendar failed: ${err}`);
      sharedFailures.push({ key: 'shared/holidays', label: 'holiday calendar' });
      runNotices.push(
        `Couldn't load the national holiday calendar (${err}) — KYC SLA ages below skip weekends only, so they may OVERSTATE breaches.`,
      );
    }
    let slaTargets = new Map<string, KycSlaTargets>();
    try {
      slaTargets = await this.loadSlaTargets();
    } catch (e) {
      const err = short(e);
      this.logger.error(`Digest: KYC SLA targets failed: ${err}`);
      sharedFailures.push({ key: 'shared/sla-targets', label: 'KYC SLA targets' });
      runNotices.push(
        `Couldn't load the per-tenant KYC SLA targets (${err}) — every tenant's KYC SLA below uses the defaults (${KYC_FIELD_SLA_DEFAULT} h field / ${KYC_GIFSY_SLA_DEFAULT} h Gifsy).`,
      );
    }

    const out: TenantDigest[] = [];
    // Tenants one at a time (a handful of tenants; keeps the DB pool calm); sections within a
    // tenant one at a time too — each is a few indexed count/aggregate queries.
    for (const t of tenants) {
      const c = t.clientId;
      const digest: TenantDigest = {
        clientId: c,
        name: t.name,
        status: t.status,
        hubbleEnabled: t.hubble,
        kyc: await section('kyc', c, () => this.kyc(c, window, slaTargets.get(c) ?? defaultTargets, holidays, nowMs)),
        points: await section('points', c, () => this.points(c, window)),
        redemptions: await section('redemptions', c, () => this.redemptions(c, window)),
        // Loaded for EVERY tenant: a live Hubble problem must show even after the flag was switched off.
        vouchers: await section('vouchers', c, () => this.vouchers(c, window, nowMs)),
        payouts: await section('payouts', c, () => this.payouts(c, window)),
        tds: await section('tds', c, () => this.tdsExcess(c, nowMs)),
        messages: await section('messages', c, () => this.messages(c, window)),
      };
      // Held opening balances (client migration): only tenants with held rows get the section (null = none).
      const held = await section('heldBalances', c, () => heldDigestFigures(this.prisma, c, window));
      if (!held.ok) digest.heldBalances = held;
      else if (held.data) digest.heldBalances = { ok: true, data: held.data };
      // Client fund: only clients with a fund set-up get the line (null = none). The once-a-day low-balance e-mail to
      // the client is sent from HERE — inside this run's lease + time budget, from the same single statement compute
      // (A7 / B5); a skipped section sends nothing.
      const fund = await section('fund', c, () => this.fund.digestAndAlert(c, nowMs));
      if (!fund.ok) digest.fund = fund;
      else if (fund.data.figures) {
        const a = fund.data.alert;
        const f = fund.data.figures;
        digest.fund = {
          ok: true,
          data: {
            balancePaise: f.balancePaise,
            committedPaise: f.committedPaise,
            thresholdPaise: f.thresholdPaise,
            isLow: f.isLow,
            hasOpening: f.hasOpening,
            missingRates: f.missingRates,
            recipients: f.recipients,
            ...(a ? { alert: { status: a.status, ...(a.error ? { error: a.error } : {}), ...(a.recipients != null ? { recipients: a.recipients } : {}) } } : {}),
          },
        };
      }
      if (t.visibility) digest.visibility = await section('visibility', c, () => this.visibility(c, window, t.visibilityPhoto, nowMs));
      // Every tenant (DEFAULT ON since 2026-11-21). An emergency-off tenant still loads it so its location history
      // is not hidden; the renderer shows it for them only when there was activity, with a "switched off" note.
      digest.location = await section('location', c, () => this.location(c, window, t.requireLocation));
      if (t.salesImport) {
        digest.salesImport = await section('salesImport', c, () => this.salesImport(c, window, nowMs));
        digest.billing = await section('billing', c, () => this.billing(c, nowMs));
      }
      out.push(digest);
    }

    const otpWindow = (extra: Prisma.OtpCodeWhereInput): Prisma.OtpCodeWhereInput => ({
      ...extra,
      deliveryStatus: 'FAILED',
      expiresAt: { gte: new Date(window.startMs - OTP_LOOKBACK_MS) },
      updatedAt: { gte: new Date(window.startMs), lt: new Date(window.endMs) },
    });
    // Gifsy-wide OTP failures: pre-login (no user) + Gifsy staff (users of the operator row, which the
    // tenant loop excludes) — attributed to a Gifsy-wide line, never dropped.
    const gifsyOtpFailed = await section('otp-gifsy-wide', 'gifsy', async () => ({
      preLogin: await this.prisma.otpCode.count({ where: otpWindow({ userId: null }) }),
      gifsyStaff: await this.prisma.otpCode.count({ where: otpWindow({ user: { clientId: REPORTS_CLIENT_ID } }) }),
    }));

    const voucherDispersal = await section('voucher-dispersal', 'gifsy', () => this.voucherDispersal(window, nowMs));

    // Gifsy-wide sign-in security (auth refresh, 2026-11-20) — never tenant-scoped, never dropped.
    const authWindow = { gte: new Date(window.startMs), lt: new Date(window.endMs) };
    const authCount = (entityType: string, event: string) =>
      this.prisma.auditLog.count({
        where: { entityType, createdAt: authWindow, metadata: { path: ['event'], equals: event } },
      });
    const authEvents = await section('auth-events', 'gifsy', async () => ({
      reuseKills: await authCount('SECURITY_EVENT', 'refresh_token_reuse'),
      repeatedHandbacks: await authCount('SECURITY_EVENT', 'repeated_unused_successor_handoff'),
      firstUseMarkFailures: await authCount('AUTH_EVENT', 'first_use_mark_failed'),
      handbackAuditFailures: await authCount('AUTH_EVENT', 'handback_audit_failed'),
      deviceUnknownRefusals: await authCount('AUTH_EVENT', 'handback_refused_device_unknown'),
      internalSecretConfigured: internalSecretConfigured(),
    }));

    return { window, dateLabel, tenants: out, gifsyOtpFailed, voucherDispersal, authEvents, runNotices, sharedFailures };
  }

  /**
   * Run one section loader, isolating any failure to that section. A section not STARTED before the run's
   * deadline is not run at all — it is `{ ok:false, error: TIME_BUDGET_SKIP }` (the run is then degraded, so
   * its window is re-covered next time) — keeping the whole run inside Cloud Run's 300 s request limit.
   */
  private async section<T>(label: string, clientId: string, load: () => Promise<T>, deadlineMs = Infinity): Promise<SectionResult<T>> {
    if (this.clock() >= deadlineMs) {
      this.logger.error(`Digest section "${label}" for ${clientId} skipped: run time budget used up`);
      return { ok: false, error: TIME_BUDGET_SKIP };
    }
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

  /**
   * Window figures by submission, and the live pending SLA from the admin KYC dashboard's OWN population
   * and rule (dashboards/kyc-pending-sla.ts): the latest submission per ADDRESSABLE outlet (not deleted /
   * deactivated / NOT_INTERESTED / PARKED), aged in unrounded business hours — so the breach counts here
   * equal the dashboard's for the same moment.
   */
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
    const outlets = await this.prisma.outlet.findMany({
      where: kycAddressableOutletWhere(clientId),
      select: { partner: { select: KYC_LATEST_SUBMISSION_SELECT } },
    });
    const pendingRows = outlets
      .map((o) => o.partner?.kycSubmissions?.[0])
      .filter((s): s is NonNullable<typeof s> => !!s);
    const rollup = kycPendingBuckets(pendingRows as never, targets, holidays, nowMs);
    return { submitted, approved, rejected, ...rollup };
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
    // Owner D1 (rounds 4-5): how many wallets are below zero AND what they owe, in ONE query (one consistent figure pair).
    const neg = await this.prisma.wallet.aggregate({
      where: { redeemablePoints: { lt: 0 }, partner: { clientId } },
      _count: { _all: true },
      _sum: { redeemablePoints: true },
    });
    const negativeWallets = (neg?._count as { _all?: number } | undefined)?._all ?? 0;
    // Reversal readiness (engine retired 2026-11-21 — never silent): wallets whose history the backfill has not
    // sequenced / BLOCKED. Two counts; each figure appears only when > 0 (the section is otherwise unchanged).
    const [notSequenced, blocked] = await Promise.all([
      this.prisma.wallet.count({ where: unsequencedWithHistoryWhere(clientId) }),
      this.prisma.wallet.count({ where: blockedWalletsWhere(clientId) }),
    ]);
    return {
      credited: sum('EARN'),
      redeemed: Math.abs(sum('REDEEM')),
      expired: Math.abs(sum('EXPIRE')),
      negativeWallets,
      ...(negativeWallets > 0 ? { owedPoints: Math.max(0, -(neg._sum.redeemablePoints ?? 0)) } : {}),
      ...((notSequenced ?? 0) > 0 ? { walletsNotSequenced: notSequenced } : {}),
      ...((blocked ?? 0) > 0 ? { walletsBlocked: blocked } : {}),
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
    // STILL OPEN: every refund path zeroes pointsDeducted when it flips the order FAILED — a FAILED order
    // still holding points was never refunded.
    const failedNotRefunded = await this.prisma.redemptionOrder.count({
      where: { partner: { clientId }, status: 'FAILED', pointsDeducted: { gt: 0 } },
    });
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
      failedNotRefunded,
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
    // Hubble-ROUTED failures: the provider stamp, OR the no-Hubble-order refund (rewards.service
    // refundAndFailNoHubbleOrder deliberately leaves voucherProvider empty — no Hubble order exists — but
    // the order was Hubble-routed; it is identified by its fixed cancelReason).
    const failed = await this.prisma.redemptionStatusHistory.count({
      where: {
        toStatus: 'FAILED',
        createdAt: inWindow,
        order: {
          partner: { clientId },
          OR: [{ voucherProvider: HUBBLE_PROVIDER }, { cancelReason: HUBBLE_NO_ORDER_REFUND_REASON }],
        },
      },
    });
    // Stuck: measured from the order's latest PROCESSING status-history entry (updatedAt moves on any
    // later write, e.g. a reconcile flag). An order with no PROCESSING entry at all falls back to updatedAt.
    const cutoff = new Date(nowMs - HUBBLE_STUCK_MS);
    const stuckProcessing = await this.prisma.redemptionOrder.count({
      where: {
        ...hubbleOrder,
        status: 'PROCESSING',
        statusHistory: { none: { toStatus: 'PROCESSING', createdAt: { gte: cutoff } } },
        OR: [
          { statusHistory: { some: { toStatus: 'PROCESSING', createdAt: { lt: cutoff } } } },
          { statusHistory: { none: { toStatus: 'PROCESSING' } }, updatedAt: { lt: cutoff } },
        ],
      },
    });
    const needsReconcile = await this.prisma.redemptionOrder.count({
      where: { partner: { clientId }, metadata: { path: ['hubbleNeedsReconcile'], equals: true } },
    });
    return { issued, failed, stuckProcessing, needsReconcile };
  }

  /** Owner 2026-11-18: 194R retailers with TDS taken in excess this FY (flag only — no refund). */
  private async tdsExcess(clientId: string, nowMs: number): Promise<TdsExcessSection> {
    const fyLabel = financialYear(new Date(nowMs)).fyLabel;
    // Cost: excess needs TDS deducted from a retailer, and every deduction is a 194R ledger row — so a tenant
    // with NO 194R ledger row this FY cannot have any excess. Skip the full 194R report for it (cheap pre-check).
    const anyLedger = await this.prisma.tdsDeductionEntry.findFirst({
      where: { clientId, section: 'SEC_194R', fyLabel },
      select: { id: true },
    });
    if (!anyLedger) return { fyLabel, excessRetailerCount: 0, totalExcessPaise: 0n, sample: [] };
    const report = await this.tds.report194R(clientId, fyLabel);
    const over = report.rows
      .filter((r) => (r.excessDeductedPaise ?? 0n) > 0n)
      .sort((a, b) => (b.excessDeductedPaise > a.excessDeductedPaise ? 1 : b.excessDeductedPaise < a.excessDeductedPaise ? -1 : 0));
    return {
      fyLabel,
      excessRetailerCount: over.length,
      totalExcessPaise: over.reduce((s, r) => s + r.excessDeductedPaise, 0n),
      sample: over.slice(0, 10).map((r) => ({
        retailer: r.noPanDeductee ? `NO PAN — ${r.noPanDeductee.name}` : r.panNumber,
        excessPaise: r.excessDeductedPaise,
      })),
    };
  }

  private async payouts(clientId: string, w: DigestWindow): Promise<PayoutsSection> {
    const inWindow = this.range(w);
    const batches = await this.prisma.creditBatch.aggregate({
      where: { clientId, status: { in: ['CONFIRMED', 'PARTIALLY_REVERSED'] }, confirmedAt: inWindow },
      _count: { _all: true },
      _sum: { totalPoints: true, totalPayoutPaise: true, totalOutlets: true },
    });
    // Credit payouts are counted when the payment was RECORDED, not by paidAt: paidAt is the operator's
    // Payment Date (IST midnight), almost always inside an already-sent window. No app path rewrites a
    // PAID entry that stays PAID (the write sites are pinned by digest-recorded-time-guard.spec): an entry
    // becomes PAID either by the UTR apply (PROCESSING → PAID/FAILED) or — when its WHOLE amount was
    // withheld as TDS — by the download itself (PROCESSING → PAID, utr `TDS-WITHHELD-…`); a reversal of
    // a fully withheld entry moves it PAID → REVERSED. So for a PAID or FAILED entry updatedAt IS the
    // moment it was recorded. Money actually PAID = gross − TDS withheld; a payout settled entirely by TDS
    // withholding is NOT paid money and is reported separately ("settled by TDS withholding").
    const creditPaid = await this.prisma.creditPayoutEntry.aggregate({
      // B-L2: OR-wrapped — a bare NOT(utr LIKE …) is NULL (= excluded) for a PAID entry with no UTR.
      where: { clientId, status: 'PAID', updatedAt: inWindow, OR: [{ utr: null }, { NOT: { utr: { startsWith: 'TDS-WITHHELD-' } } }] },
      _count: { _all: true },
      _sum: { amountPaise: true, tdsDeductedPaise: true },
    });
    const creditSettledByTds = await this.prisma.creditPayoutEntry.aggregate({
      where: { clientId, status: 'PAID', updatedAt: inWindow, utr: { startsWith: 'TDS-WITHHELD-' } },
      _count: { _all: true },
      _sum: { amountPaise: true, tdsDeductedPaise: true },
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
    // B-L3: awaiting UTR = what the bank will actually pay = gross − TDS withheld at the bank file.
    const awaiting = await this.prisma.creditPayoutEntry.aggregate({
      where: { clientId, status: 'PROCESSING' },
      _count: { _all: true },
      _sum: { amountPaise: true, tdsDeductedPaise: true },
    });
    // STILL OPEN (not windowed): a FAILED credit entry waits for a re-bank download or a reversal (both move it).
    const openCredit = await this.prisma.creditPayoutEntry.aggregate({
      where: { clientId, status: 'FAILED' },
      _count: { _all: true },
      _sum: { amountPaise: true },
    });
    // A FAILED redemption payout normally fails + refunds its order in the same transaction (resolved). It is
    // still open when the order was NOT failed/refunded (e.g. the issued-voucher refund block) or it has no order.
    const failedTxns = await this.prisma.payoutTransaction.findMany({
      where: { partner: { clientId }, status: 'FAILED' },
      select: { redemptionOrderId: true },
    });
    const orderIds = failedTxns.map((t) => t.redemptionOrderId).filter((id): id is string => !!id);
    const closed =
      orderIds.length === 0
        ? 0
        : await this.prisma.redemptionOrder.count({
            where: { id: { in: orderIds }, status: { in: [...REFUNDED_OR_CLOSED_ORDER] } },
          });
    return {
      batchesConfirmed: num(batches._count?._all),
      batchPoints: num(batches._sum?.totalPoints),
      batchOutlets: num(batches._sum?.totalOutlets),
      batchPayoutPaise: big(batches._sum?.totalPayoutPaise),
      creditPaid: num(creditPaid._count?._all),
      // NET actually paid to retailers (gross − any TDS withheld from those bank lines).
      creditPaidPaise: big(creditPaid._sum?.amountPaise) - big(creditPaid._sum?.tdsDeductedPaise),
      creditSettledByTds: num(creditSettledByTds._count?._all),
      creditSettledByTdsPaise: big(creditSettledByTds._sum?.tdsDeductedPaise),
      redemptionPaid: num(redemptionPaid._count?._all),
      redemptionPaidPaise: big(redemptionPaid._sum?.amountPaise),
      failedOrReturned: creditFailed + txnFailed,
      awaitingUtr: num(awaiting._count?._all),
      awaitingUtrPaise: big(awaiting._sum?.amountPaise) - big(awaiting._sum?.tdsDeductedPaise),
      openFailedCredit: num(openCredit._count?._all),
      openFailedCreditPaise: big(openCredit._sum?.amountPaise),
      openFailedRedemption: failedTxns.length - closed,
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

  /**
   * PHOTO_APPROVAL tenants (VISIBILITY-POSM-DESIGN.md §17): reviews done = ONE per capture per IST day by that
   * day's final outcome (a rejection followed by a same-day resubmit still counts — visibility-metrics
   * countReviewActions); waiting for review = EVERY in-scope capture still waiting, any month (with the current
   * month's share and the earlier-months remainder); waiting on reps = re-takes / rejections in a window still open
   * (a closed window can't be resubmitted → "not approved — window closed", reported apart). AMOUNT_UPLOAD tenants keep the exact previous lines (visibilityLegacy).
   */
  private async visibility(clientId: string, w: DigestWindow, photo: boolean, nowMs: number): Promise<VisibilitySection> {
    if (!photo) return this.visibilityLegacy(clientId, w);
    const inWindow = this.range(w);
    const submitted = await this.prisma.visibilityCaptureSubmission.count({ where: { clientId, createdAt: inWindow } });
    const reviews = await loadReviewActions(this.prisma, clientId, new Date(w.startMs), new Date(w.endMs));
    const cfg = (await this.tenantSettings.getEffectiveSettings(clientId)).visibilityConfig;
    const month = istMonthKey(new Date(nowMs));
    const counts = await loadMonthStatusCounts(this.prisma, clientId, cfg, month, {
      now: new Date(nowMs),
      freq: cfg.frequencyPerMonth,
    });
    return {
      submitted,
      approved: reviews.approved,
      rejected: reviews.rejected,
      // Everything still open: Gifsy's WHOLE queue (any month) + what waits on reps (open windows). Drives "hide the
      // section when all zero" → the section never disappears while anything is waiting.
      pending: counts.waitingAllMonths + counts.waitingOnReps,
      month,
      reviewActions: reviews.actions,
      waiting: counts.waiting,
      waitingAllMonths: counts.waitingAllMonths,
      waitingEarlierMonths: counts.waitingEarlierMonths,
      needsRetake: counts.needsRetake,
      waitingOnReps: counts.waitingOnReps,
      closedNotApproved: counts.closedNotApproved,
    };
  }

  /** The pre-month lines — AMOUNT_UPLOAD tenants only (byte-identical to before). */
  private async visibilityLegacy(clientId: string, w: DigestWindow): Promise<VisibilitySection> {
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
   * Location compliance in the window (LOCATION-GATE.md): sales-rep KYCs by submittedAt (board-photo fix) and
   * visibility capture submissions by createdAt — how many had no GPS / a fix worse than ±50 m — plus the recorded
   * "outside the fence" refusals. Same definitions as the location-compliance report.
   */
  private async location(clientId: string, w: DigestWindow, requireLocation: boolean): Promise<LocationSection> {
    const inWindow = this.range(w);
    const kycWhere = { submittedAt: inWindow, user: { clientId, role: { in: [...SALES_ROLES] } } };
    const kycs = await this.prisma.kycSubmission.count({ where: kycWhere });
    const kycNoGps = await this.prisma.kycSubmission.count({
      where: { ...kycWhere, OR: [{ boardPhotoLat: null }, { boardPhotoLng: null }] },
    });
    const kycPoor = await this.prisma.kycSubmission.count({
      where: { ...kycWhere, boardPhotoLat: { not: null }, boardPhotoLng: { not: null }, boardPhotoGeoAccuracy: { gt: POOR_ACCURACY_M } },
    });
    // Sales-rep submissions only (matches the KYC counts and the Location Report's rep join).
    const visWhere = { clientId, createdAt: inWindow, submittedBy: { is: { clientId } } };
    const captures = await this.prisma.visibilityCaptureSubmission.count({ where: visWhere });
    const visNoGps = await this.prisma.visibilityCaptureSubmission.count({
      where: { ...visWhere, OR: [{ captureLat: null }, { captureLng: null }] },
    });
    const visPoor = await this.prisma.visibilityCaptureSubmission.count({
      where: { ...visWhere, captureLat: { not: null }, captureLng: { not: null }, captureAccuracy: { gt: POOR_ACCURACY_M } },
    });
    const blockedOutside = await this.prisma.auditLog.count({
      // Same tenant key as the Location Report: the clientId recorded on the refusal.
      where: { entityType: FENCE_BLOCK_ENTITY, createdAt: inWindow, metadata: { path: ['clientId'], equals: clientId } },
    });
    return {
      requireLocation,
      kycs,
      captures,
      noGps: kycNoGps + visNoGps,
      poorAccuracy: kycPoor + visPoor,
      blockedOutside,
    };
  }

  /**
   * Imports processed/failed in the window (both by finishedAt — the processor stamps it on READY and
   * FAILED; the retention purge bumps updatedAt, so updatedAt would re-count old failures) + FAILED imports
   * not superseded by a later READY one + every OPEN month (last 6, not future) with its last apply and the
   * "targets changed since apply" flag — the SAME rule SalesMonthsService.list uses.
   */
  private async salesImport(clientId: string, w: DigestWindow, nowMs: number): Promise<SalesImportSection> {
    const inWindow = this.range(w);
    const processed = await this.prisma.salesImport.count({ where: { clientId, status: 'READY', finishedAt: inWindow } });
    const failed = await this.prisma.salesImport.count({ where: { clientId, status: 'FAILED', finishedAt: inWindow } });
    const lastReady = await this.prisma.salesImport.findFirst({
      where: { clientId, status: 'READY' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const failedOpen = await this.prisma.salesImport.count({
      where: { clientId, status: 'FAILED', ...(lastReady ? { createdAt: { gt: lastReady.createdAt } } : {}) },
    });

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
      failedOpen,
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

  /**
   * Current-month billing progress — the admin dashboard's own loader + summary (unfiltered), so the digest and
   * the "Billing progress" card can never disagree. ≈9 parallel queries per Sales-Import tenant, none per outlet.
   */
  private async billing(clientId: string, nowMs: number): Promise<BillingSection> {
    const now = new Date(nowMs);
    const data = await loadBillingProgress(
      this.prisma,
      clientId,
      { month: null, program: null, outletType: null, managerId: null },
      now,
    );
    const s = summarizeBillingProgress(data);
    return {
      month: s.month,
      kpiLabel: s.kpi ? s.kpi.label : null,
      asOf: s.asOf,
      withTarget: s.outletsInScope,
      notStarted: s.buckets.find((b) => b.key === 'NOT_STARTED')?.count ?? 0,
      noTarget: s.outletsWithoutTarget,
      notCovered: s.outletsNotCovered,
      targetsOutsideRoster: s.targetsOutsideRoster,
    };
  }

  /**
   * Gifsy-wide Voucher Dispersal (GIFSY-run campaigns, not a tenant). Same definitions as the campaign screen
   * (VoucherDispersalService.campaign summary): pending = QUEUED + BUYING + PENDING_RECONCILE; a WhatsApp is
   * failed when the row's mirrored status is FAILED / UNKNOWN (or the send itself errored with no status);
   * a PENDING_RECONCILE row is retryable 2 h after its last place attempt / flag (DISPERSAL_RETRY_MIN_AGE_MS) — except one
   * whose last Hubble answer was undocumented (counted apart: needs Gifsy tech). Rows marked "not bought" are CLOSED:
   * excluded from "purchase failed" / "still failed" and counted as `markedClosed`.
   * Window figures use the row timestamps the engine stamps (boughtAt; updatedAt for failures). STILL OPEN:
   * rows in BUY_FAILED now (a Retry moves the row out of it) and BOUGHT rows whose WhatsApp is failed now (a
   * Resend clears the status). Every count rides the (status, updatedAt) index; only PENDING_RECONCILE rows
   * are read (two timestamps each).
   */
  private async voucherDispersal(w: DigestWindow, nowMs: number): Promise<VoucherDispersalSection> {
    const inWindow = this.range(w);
    const rows = this.prisma.voucherDispersalRow;
    const messageFailedWhere = {
      status: 'BOUGHT' as const,
      OR: [{ messageStatus: { in: ['FAILED', 'UNKNOWN'] } }, { messageStatus: null, messageError: { not: null } }],
    };
    const bought = await rows.count({ where: { status: 'BOUGHT', boughtAt: inWindow } });
    // A row an admin marked "not bought" is CLOSED — reported apart, never as "purchase failed" / "still failed".
    const notMarked = { OR: [{ buyFailureSource: null }, { buyFailureSource: { not: 'MARKED_NOT_BOUGHT' } }] };
    const buyFailed = await rows.count({ where: { status: 'BUY_FAILED', updatedAt: inWindow, ...notMarked } });
    const messageFailed = await rows.count({ where: { ...messageFailedWhere, updatedAt: inWindow } });
    const pending = await rows.count({ where: { status: { in: ['QUEUED', 'BUYING', 'PENDING_RECONCILE'] } } });
    const buyFailedOpen = await rows.count({ where: { status: 'BUY_FAILED', ...notMarked } });
    const markedClosed = await rows.count({ where: { status: 'BUY_FAILED', buyFailureSource: 'MARKED_NOT_BOUGHT' } });
    const messageFailedOpen = await rows.count({ where: messageFailedWhere });
    const reconcile = await rows.findMany({
      where: { status: 'PENDING_RECONCILE' },
      select: { placeAttemptAt: true, pendingSince: true, pendingReason: true },
    });
    // A pending row whose last Hubble answer was undocumented needs Gifsy tech — not "Retry available" (review L4).
    const unrecognised = (r: { pendingReason?: string | null }) => (r.pendingReason ?? '').startsWith('HUBBLE_UNKNOWN_STATUS');
    const pendingUnrecognised = reconcile.filter(unrecognised).length;
    const pendingRetryable = reconcile.filter((r) => !unrecognised(r)).filter((r) => {
      const anchors = [r.placeAttemptAt, r.pendingSince].filter((d): d is Date => !!d).map((d) => d.getTime());
      return anchors.length > 0 && Math.max(...anchors) + DISPERSAL_RETRY_MIN_AGE_MS <= nowMs;
    }).length;
    // Never silent (owner rule): campaigns over budget — spent + with Hubble + failed-may-complete (the SAME
    // rule as the campaign page; QUEUED is not spending) beyond the budget — failing status updates, and FAILED
    // purchases Hubble completed later in the window.
    const spend = await rows.groupBy({
      by: ['campaignId'],
      where: { OR: [{ status: { in: ['BUYING', 'PENDING_RECONCILE', 'BOUGHT'] } }, failedMayStillCompleteWhere] },
      _sum: { amountPaise: true },
    });
    const spentBy = new Map<string, bigint>();
    for (const g of spend) spentBy.set(g.campaignId, BigInt(g._sum.amountPaise ?? 0n));
    const budgets = spentBy.size
      ? await this.prisma.voucherDispersalCampaign.findMany({
          where: { id: { in: [...spentBy.keys()] } },
          select: { id: true, budgetPaise: true },
        })
      : [];
    const budgetOf = new Map(budgets.map((c) => [c.id, BigInt(c.budgetPaise)]));
    const overBudgetCampaigns = [...spentBy.entries()].filter(([id, paise]) => {
      const b = budgetOf.get(id);
      return b !== undefined && paise > b;
    }).length;
    // Earlier-order alerts (one per reference; never counted against any budget): OPEN ones created OR worsened in the
    // window (statusChangedAt moves only when the alert gets worse — review of 4d8454ad, M1), by what happened; the
    // RESOLVED ones (Hubble confirmed FAILED / no order) are listed apart.
    type AlertGroup = { kind: string; hubbleStatus: string; _count: { _all: number } };
    const split = (groups: AlertGroup[]) => {
      const by = { superseded: 0, marked: 0, notApplied: 0, couldNotCheck: 0, noOrderUnverified: 0 };
      for (const g of groups) {
        const n = g._count._all;
        // Our `__` labels — a raw Hubble status (even "LOOKUP_FAILED") is activity, by kind (M2).
        if (g.hubbleStatus === ALERT_LOOKUP_FAILED) by.couldNotCheck += n;
        else if (g.hubbleStatus === ALERT_NO_ORDER_UNVERIFIED) by.noOrderUnverified += n;
        else if (g.kind === 'MARKED_NOT_BOUGHT') by.marked += n;
        else if (g.kind === 'NOT_APPLIED') by.notApplied += n;
        else by.superseded += n;
      }
      return { by, total: groups.reduce((a, g) => a + g._count._all, 0) };
    };
    const alertGroups = await this.prisma.voucherDispersalOrderAlert.groupBy({
      by: ['kind', 'hubbleStatus'],
      where: { resolvedAt: null, OR: [{ createdAt: inWindow }, { statusChangedAt: inWindow }] },
      _count: { _all: true },
    });
    const { by: earlierOrderAlertsBy, total: earlierOrderAlerts } = split(alertGroups);
    // …and every alert still OPEN now, of any age (release-gate review): an open SUCCESS alert stays visible daily.
    const openGroups = await this.prisma.voucherDispersalOrderAlert.groupBy({
      by: ['kind', 'hubbleStatus'],
      where: { resolvedAt: null },
      _count: { _all: true },
    });
    const { by: earlierOrderAlertsOpenBy, total: earlierOrderAlertsOpen } = split(openGroups);
    const earlierOrderAlertsResolved = await this.prisma.voucherDispersalOrderAlert.count({ where: { resolvedAt: inWindow } });
    // L8 (review of 4d8454ad): a FAILED row (not marked) whose LATEST lookup was an undocumented Hubble status needs
    // Gifsy tech too — the same rule as the campaign page (lastLookupUnrecognised).
    const failedUnrecognised = await rows.count({
      where: {
        status: 'BUY_FAILED',
        ...notMarked,
        lastReconcileResult: { startsWith: 'HUBBLE_', notIn: [...HUBBLE_KNOWN_STATUSES].map((s) => `HUBBLE_${s}`) },
      },
    });
    const settleErrorCampaigns = await this.prisma.voucherDispersalCampaign.count({ where: { settleFailures: { gte: SETTLE_FAILURES_BEFORE_ALERT } } });
    const lateCompleted = await rows.count({ where: { lateCompletedAt: inWindow } });
    return {
      bought,
      buyFailed,
      messageFailed,
      pending,
      pendingRetryable,
      buyFailedOpen,
      messageFailedOpen,
      overBudgetCampaigns,
      settleErrorCampaigns,
      lateCompleted,
      earlierOrderAlerts,
      earlierOrderAlertsBy,
      earlierOrderAlertsResolved,
      earlierOrderAlertsOpen,
      earlierOrderAlertsOpenBy,
      markedClosed,
      unrecognisedStatus: pendingUnrecognised + failedUnrecognised,
    };
  }

  // ── Shared inputs ─────────────────────────────────────────────────────────────────────────

  /**
   * Every tenant (minus the Gifsy operator row) with display name, status and the gates for the optional
   * sections: features.hubbleVoucherEnabled, features.salesImport, and the per-tenant `visibilityEnabled`
   * program setting (=== true, the same rule as TenantSettingsService). ONBOARDING / INACTIVE tenants are
   * loaded too — the builder shows them (marked) when they have activity or open items, and names the rest.
   */
  private async loadTenants(): Promise<TenantMeta[]> {
    const clients = await this.prisma.client.findMany({
      where: { id: { not: REPORTS_CLIENT_ID } },
      select: { id: true, internalName: true, status: true, branding: true, features: true },
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
        status: (c.status ?? 'ACTIVE') as TenantStatus,
        hubble: features.hubbleVoucherEnabled === true,
        salesImport: features.salesImport === true,
        visibility: visibilityOn.has(c.id),
        // TenantService.resolveVisibilityCaptureMode's rule: absent = PHOTO_APPROVAL.
        visibilityPhoto: (features.visibilityCaptureMode ?? 'PHOTO_APPROVAL') === 'PHOTO_APPROVAL',
        requireLocation: isLocationRequired(features),
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
