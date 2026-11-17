/**
 * Daily Operations Digest — the ONE internal Gifsy email (owner-approved 2026-11-13; replaces the
 * separate Credits/Payouts summary + KYC actionables digest). An all-tenant summary on top, then one
 * section per tenant. Design: platform/docs/plans/DAILY-OPS-DIGEST.md.
 *
 * PURE: no DB, no clock. The runner (scheduled-reports.service.ts) does all the Prisma and passes
 * plain structs (report.types.ts). Every dynamic value is HTML-escaped (`esc`). Also exports the
 * other pure pieces the runner needs: the reporting window (`digestWindow`) and the KYC pending-SLA
 * roll-up (`kycPendingBuckets`, which reuses the shared two-stage `kycStageSla`).
 */

import { kycStageSla, latestGifsyEntryMs, KycSlaTargets } from '../../common/kyc-sla-stage';
import { formatDateIST } from '../../common/ist-date';
import { isFastTrackRow, type KycFastTrackHistoryRow } from '../../kyc/kyc-fast-track.helper';
import { monthLabel } from '../../sales-import/months/month-state';
import { emailShell, esc, intIN, rupees, sectionHeading, statRow, table } from './email-html';
import type {
  BillingSection,
  DigestInput,
  DigestResult,
  DigestWindow,
  KycSection,
  SectionResult,
  SlaBucket,
  TenantDigest,
  VoucherDispersalSection,
} from './report.types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 330 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A KYC row nearing breach: at or above this share of its stage target (but not over it). */
export const KYC_NEARING_RATIO = 0.75;
/** At most this many failed redemptions are listed per tenant. */
export const MAX_FAILED_REDEMPTION_ROWS = 10;

// ── Window ────────────────────────────────────────────────────────────────────────────────────

/** "Sat 08 Nov, 09:30" — the IST wall-clock of an instant. */
function istStamp(ms: number): string {
  const s = new Date(ms + IST_OFFSET_MS);
  const hh = String(s.getUTCHours()).padStart(2, '0');
  const mm = String(s.getUTCMinutes()).padStart(2, '0');
  const date = formatDateIST(new Date(ms)).slice(0, 6); // "08 Nov"
  return `${WEEKDAYS[s.getUTCDay()]} ${date}, ${hh}:${mm}`;
}

/**
 * The digest window, ending at `nowMs`: since the same time on the previous WORKING day. The digest
 * runs Mon–Sat, so on a Monday (IST) the window reaches back to Saturday at the same time (48 h,
 * covering Sunday); any other day it is the last 24 h.
 */
export function digestWindow(nowMs: number): DigestWindow {
  const istWeekday = new Date(nowMs + IST_OFFSET_MS).getUTCDay();
  const span = istWeekday === 1 ? 2 * DAY_MS : DAY_MS;
  const startMs = nowMs - span;
  return { startMs, endMs: nowMs, label: `${istStamp(startMs)} → ${istStamp(nowMs)} IST` };
}

// ── KYC pending roll-up (reuses the shared two-stage business-hours SLA) ─────────────────────

export interface KycPendingRow {
  status: string;
  submittedAt: Date | string | number | null;
  createdAt?: Date | string | number | null;
  /**
   * The submission's PENDING_GIFSY history entries (for the latest Gifsy entry). fromStatus + metadata let the
   * fast-track routing row (DRAFT→PENDING_GIFSY + marker) be recognised with the shared `isFastTrackRow`.
   */
  statusHistory?: Array<KycFastTrackHistoryRow & { createdAt?: Date | string | number | null }> | null;
}

const emptyBucket = (): SlaBucket => ({ pending: 0, within: 0, nearing: 0, breached: 0 });

export interface KycPendingRollup {
  field: SlaBucket;
  gifsy: SlaBucket;
  /** Of gifsy.pending: fast-tracked (no field stage). */
  gifsyFastTracked: number;
  /** Fast-tracked rows at a field status — excluded from the field SLA, reported instead. */
  fieldFastTrackedExcluded: number;
}

/**
 * Bucket one tenant's pending KYC rows by stage (field / Gifsy) and SLA state. Field rows age from
 * submission, Gifsy rows from the LATEST PENDING_GIFSY entry — each against its own target, in
 * business hours (weekends + the holiday set excluded) — exactly as the KYC dashboards do.
 *
 * GIFSY-reject fast-track: a fast-tracked KYC skipped the field chain, so it is NEVER a field-SLA item — the same
 * rule as the admin dashboard's field-chain exclusion (`isFastTrackRow` on the history; proven only by the marker,
 * never by the bare DRAFT→PENDING_GIFSY edge). At Gifsy it ages on the Gifsy clock as normal and is counted in
 * `gifsyFastTracked`; at a field status (no such path today) it is excluded from the field bucket and counted in
 * `fieldFastTrackedExcluded` so it is shown, never silently dropped.
 */
export function kycPendingBuckets(
  rows: KycPendingRow[],
  targets: KycSlaTargets,
  holidays: Set<string>,
  nowMs: number,
): KycPendingRollup {
  const field = emptyBucket();
  const gifsy = emptyBucket();
  let gifsyFastTracked = 0;
  let fieldFastTrackedExcluded = 0;
  for (const r of rows) {
    if (!r || typeof r.status !== 'string') continue;
    const fastTracked = Array.isArray(r.statusHistory) && r.statusHistory.some((h) => isFastTrackRow(h));
    const sla = kycStageSla(
      {
        status: r.status,
        submittedAt: r.submittedAt ?? r.createdAt ?? null,
        gifsyEnteredAt: latestGifsyEntryMs(r.statusHistory as never),
        nowMs,
      },
      targets,
      holidays,
    );
    if (sla.clock === 'none' || sla.frozen) continue;
    if (fastTracked && sla.clock === 'field') {
      fieldFastTrackedExcluded += 1;
      continue;
    }
    if (fastTracked) gifsyFastTracked += 1;
    const b = sla.clock === 'gifsy' ? gifsy : field;
    b.pending += 1;
    if (sla.breached) b.breached += 1;
    else if (sla.targetHrs !== null && sla.ageHrs >= sla.targetHrs * KYC_NEARING_RATIO) b.nearing += 1;
    else b.within += 1;
  }
  return { field, gifsy, gifsyFastTracked, fieldFastTrackedExcluded };
}

// ── Needs attention ───────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${intIN(n)} ${n === 1 ? one : many}`;

/** Every abnormal item for one tenant, as plain-text bullets (escaped at render time). */
export function needsAttention(t: TenantDigest): string[] {
  const out: string[] = [];
  const failed = (label: string, r: SectionResult<unknown> | undefined) => {
    if (r && !r.ok) out.push(`Couldn't load the ${label} section`);
  };

  failed('KYC', t.kyc);
  if (t.kyc.ok) {
    const { gifsy, field } = t.kyc.data;
    if (gifsy.breached > 0) out.push(`${plural(gifsy.breached, 'KYC', 'KYCs')} breaching the Gifsy SLA`);
    if (field.breached > 0) out.push(`${plural(field.breached, 'KYC', 'KYCs')} breaching the field SLA`);
    const ftField = t.kyc.data.fieldFastTrackedExcluded;
    if (ftField > 0) {
      out.push(`${plural(ftField, 'fast-tracked KYC', 'fast-tracked KYCs')} at a field stage — not on the field SLA, check by hand`);
    }
  }

  failed('Points', t.points);
  if (t.points.ok && t.points.data.negativeWallets > 0) {
    out.push(plural(t.points.data.negativeWallets, 'negative wallet', 'negative wallets'));
  }

  failed('Redemptions', t.redemptions);
  if (t.redemptions.ok && t.redemptions.data.failed > 0) {
    out.push(`${plural(t.redemptions.data.failed, 'redemption', 'redemptions')} failed`);
  }

  failed('Vouchers (Hubble)', t.vouchers);
  if (t.vouchers?.ok) {
    const v = t.vouchers.data;
    if (v.failed > 0) out.push(`Hubble: ${plural(v.failed, 'voucher', 'vouchers')} failed`);
    if (v.stuckProcessing > 0) out.push(`Hubble: ${plural(v.stuckProcessing, 'voucher', 'vouchers')} stuck in processing > 30 min`);
    if (v.needsReconcile > 0) out.push(`Hubble: ${plural(v.needsReconcile, 'order needs', 'orders need')} reconcile`);
  }

  failed('Payouts', t.payouts);
  if (t.payouts.ok && t.payouts.data.failedOrReturned > 0) {
    out.push(`${plural(t.payouts.data.failedOrReturned, 'payout', 'payouts')} failed or returned`);
  }

  failed('Messages', t.messages);
  if (t.messages.ok) {
    const m = t.messages.data;
    const total = m.otpFailed + m.smsFailed + m.whatsappFailed + m.broadcastFailed;
    if (total > 0) out.push(`${plural(total, 'message', 'messages')} failed delivery`);
  }

  failed('Visibility', t.visibility);

  failed('Sales Import', t.salesImport);
  if (t.salesImport?.ok) {
    const s = t.salesImport.data;
    if (s.failed > 0) out.push(`Sales Import: ${plural(s.failed, 'import', 'imports')} failed`);
    for (const m of s.openMonths) {
      if (m.targetsChangedSinceApply) out.push(`Targets changed — recalculate ${monthLabel(m.month)}`);
    }
  }

  failed('Billing progress', t.billing);
  return out;
}

/** Gifsy-wide (not tenant) attention items — today: Voucher Dispersal. */
export function gifsyWideAttention(input: Pick<DigestInput, 'voucherDispersal'>): string[] {
  const out: string[] = [];
  const vd = input.voucherDispersal;
  if (!vd) return out;
  if (!vd.ok) {
    out.push(`Couldn't load the Voucher dispersal section`);
    return out;
  }
  const d = vd.data;
  if (d.buyFailed > 0) out.push(`Voucher dispersal: ${plural(d.buyFailed, 'purchase', 'purchases')} failed`);
  if (d.messageFailed > 0) out.push(`Voucher dispersal: ${plural(d.messageFailed, 'WhatsApp message', 'WhatsApp messages')} failed`);
  if (d.pendingRetryable > 0) {
    out.push(`Voucher dispersal: ${plural(d.pendingRetryable, 'purchase', 'purchases')} unconfirmed by Hubble for over 2 h (Retry available)`);
  }
  return out;
}

// ── Rendering helpers ─────────────────────────────────────────────────────────────────────────

const MUTED = '#6b7280';

/** "Label  a · b · c" — one compact metric line; every part escaped. */
function metricLine(label: string, parts: Array<[string, string, ('red' | 'amber')?]>): string {
  const body = parts
    .map(([k, v, accent]) => {
      const color = accent === 'red' ? '#b91c1c' : accent === 'amber' ? '#b45309' : '#111827';
      return `${esc(k)} <strong style="color:${color};">${esc(v)}</strong>`;
    })
    .join(' <span style="color:#d1d5db;">·</span> ');
  return `<div style="font-size:13px;color:#374151;margin:0 0 6px;line-height:1.6;"><span style="display:inline-block;min-width:110px;color:${MUTED};font-weight:600;">${esc(label)}</span>${body}</div>`;
}

function subHeading(text: string): string {
  return `<div data-section="${esc(text)}" style="font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.04em;margin:14px 0 6px;">${esc(text)}</div>`;
}

function sectionError(label: string, error: string): string {
  return (
    subHeading(label) +
    `<div style="font-size:13px;color:#b91c1c;margin:0 0 6px;">Couldn't load this section${error ? ` (${esc(error)})` : ''}.</div>`
  );
}

const accentIf = (n: number, accent: 'red' | 'amber'): 'red' | 'amber' | undefined => (n > 0 ? accent : undefined);

function bucketParts(b: SlaBucket): Array<[string, string, ('red' | 'amber')?]> {
  return [
    ['pending', intIN(b.pending)],
    ['within SLA', intIN(b.within)],
    ['nearing', intIN(b.nearing), accentIf(b.nearing, 'amber')],
    ['breached', intIN(b.breached), accentIf(b.breached, 'red')],
  ];
}

/** Render one section: error → error line; empty → '' (hidden); else the body. */
function renderSection<T>(
  label: string,
  r: SectionResult<T> | undefined,
  isEmpty: (d: T) => boolean,
  body: (d: T) => string,
): string {
  if (!r) return '';
  if (!r.ok) return sectionError(label, r.error);
  if (isEmpty(r.data)) return '';
  return subHeading(label) + body(r.data);
}

const kycEmpty = (k: KycSection) =>
  k.submitted === 0 &&
  k.approved === 0 &&
  k.rejected === 0 &&
  k.field.pending === 0 &&
  k.gifsy.pending === 0 &&
  k.fieldFastTrackedExcluded === 0;

const note = (text: string, color = MUTED) => `<div style="font-size:12px;color:${color};margin:0 0 6px;">${esc(text)}</div>`;

/** Billing progress block (always rendered when present: an empty month is itself worth saying). */
function billingBody(b: BillingSection): string {
  const month = monthLabel(b.month);
  if (b.kpiLabel === null) {
    return note(`No enabled KPI for this tenant — billing progress for ${month} can't be shown.`, '#b45309');
  }
  const lines: string[] = [];
  if (b.withTarget === 0) {
    lines.push(note(`No outlet has a ${b.kpiLabel} target for ${month} — nothing to measure.`, '#b45309'));
  } else {
    lines.push(
      metricLine(month, [
        ['not started billing', `${intIN(b.notStarted)} of ${intIN(b.withTarget)} with a target`, accentIf(b.notStarted, 'amber')],
      ]),
    );
  }
  lines.push(note(b.asOf ? `KPI ${b.kpiLabel} · data up to ${formatDateIST(new Date(`${b.asOf}T00:00:00+05:30`))}` : `KPI ${b.kpiLabel} · no sales uploaded for ${month} yet`));
  const notCounted: string[] = [];
  if (b.noTarget > 0) notCounted.push(plural(b.noTarget, 'outlet has no target', 'outlets have no target'));
  if (b.notCovered > 0) notCounted.push(plural(b.notCovered, 'outlet is outside the KPI’s scope', 'outlets are outside the KPI’s scope'));
  if (b.targetsOutsideRoster > 0) {
    notCounted.push(plural(b.targetsOutsideRoster, 'target is for an outlet not in the live roster', 'targets are for outlets not in the live roster'));
  }
  if (notCounted.length > 0) lines.push(note(`Not counted above: ${notCounted.join('; ')}.`));
  return lines.join('');
}

const dispersalEmpty = (d: VoucherDispersalSection) =>
  d.bought === 0 && d.buyFailed === 0 && d.messageFailed === 0 && d.pending === 0;

/** Gifsy-wide Voucher Dispersal block for the summary ('' when every figure is zero). */
function dispersalBlock(r: SectionResult<VoucherDispersalSection> | undefined): string {
  return renderSection('Voucher dispersal (Gifsy-wide)', r, dispersalEmpty, (d) =>
    metricLine('In window', [
      ['bought', intIN(d.bought)],
      ['purchase failed', intIN(d.buyFailed), accentIf(d.buyFailed, 'red')],
      ['WhatsApp failed', intIN(d.messageFailed), accentIf(d.messageFailed, 'red')],
    ]) +
    metricLine('Right now', [
      ['pending', intIN(d.pending), accentIf(d.pending, 'amber')],
      ['unconfirmed > 2 h', intIN(d.pendingRetryable), accentIf(d.pendingRetryable, 'red')],
    ]),
  );
}

/** All the (non-empty / failed) section blocks of one tenant, concatenated. '' = nothing to show. */
function tenantSections(t: TenantDigest): string {
  return [
    renderSection('KYC', t.kyc, kycEmpty, (k) =>
      metricLine('In window', [
        ['submitted', intIN(k.submitted)],
        ['approved', intIN(k.approved)],
        ['rejected', intIN(k.rejected)],
      ]) +
      (k.field.pending > 0 ? metricLine('Field stage', bucketParts(k.field)) : '') +
      (k.gifsy.pending > 0
        ? metricLine('Gifsy stage', [
            ...bucketParts(k.gifsy),
            ...(k.gifsyFastTracked > 0
              ? ([['of which fast-tracked (skipped field)', intIN(k.gifsyFastTracked)]] as Array<[string, string]>)
              : []),
          ])
        : '') +
      (k.fieldFastTrackedExcluded > 0
        ? note(
            `${plural(k.fieldFastTrackedExcluded, 'fast-tracked KYC is', 'fast-tracked KYCs are')} at a field stage — left out of the field SLA (they skipped the field chain).`,
            '#b91c1c',
          )
        : ''),
    ),
    renderSection(
      'Points',
      t.points,
      (p) => p.credited === 0 && p.redeemed === 0 && p.expired === 0 && p.negativeWallets === 0,
      (p) =>
        metricLine('In window', [
          ['credited', intIN(p.credited)],
          ['redeemed', intIN(p.redeemed)],
          ['expired', intIN(p.expired)],
        ]) +
        (p.negativeWallets > 0
          ? metricLine('Wallets', [['negative', intIN(p.negativeWallets), 'red']])
          : ''),
    ),
    renderSection(
      'Redemptions',
      t.redemptions,
      (r) => r.requested === 0 && r.completed === 0 && r.failed === 0,
      (r) =>
        metricLine('In window', [
          ['requested', intIN(r.requested)],
          ['completed', intIN(r.completed)],
          ['failed', intIN(r.failed), accentIf(r.failed, 'red')],
        ]) +
        (r.failedRows.length > 0
          ? table(
              [{ label: 'Outlet' }, { label: 'Reward' }, { label: 'Reason' }],
              r.failedRows.slice(0, MAX_FAILED_REDEMPTION_ROWS).map((f) => [esc(f.outlet), esc(f.reward), esc(f.reason || '—')]),
            ) +
            (r.failed > Math.min(r.failedRows.length, MAX_FAILED_REDEMPTION_ROWS)
              ? `<div style="font-size:12px;color:${MUTED};margin:0 0 6px;">Showing the latest ${esc(intIN(Math.min(r.failedRows.length, MAX_FAILED_REDEMPTION_ROWS)))} of ${esc(intIN(r.failed))}.</div>`
              : '')
          : ''),
    ),
    renderSection(
      'Vouchers (Hubble)',
      t.vouchers,
      (v) => v.issued === 0 && v.failed === 0 && v.stuckProcessing === 0 && v.needsReconcile === 0,
      (v) =>
        metricLine('In window', [
          ['issued', intIN(v.issued)],
          ['failed', intIN(v.failed), accentIf(v.failed, 'red')],
        ]) +
        metricLine('Right now', [
          ['stuck > 30 min', intIN(v.stuckProcessing), accentIf(v.stuckProcessing, 'red')],
          ['needs reconcile', intIN(v.needsReconcile), accentIf(v.needsReconcile, 'red')],
        ]),
    ),
    renderSection(
      'Payouts',
      t.payouts,
      (p) =>
        p.batchesConfirmed === 0 && p.creditPaid === 0 && p.redemptionPaid === 0 && p.failedOrReturned === 0 && p.awaitingUtr === 0,
      (p) =>
        (p.batchesConfirmed > 0
          ? metricLine('Batches', [
              ['confirmed', intIN(p.batchesConfirmed)],
              ['points', intIN(p.batchPoints)],
              ['payout committed', rupees(p.batchPayoutPaise)],
            ])
          : '') +
        metricLine('Paid', [
          ['credit payouts', `${intIN(p.creditPaid)} (${rupees(p.creditPaidPaise)})`],
          ['redemption payouts', `${intIN(p.redemptionPaid)} (${rupees(p.redemptionPaidPaise)})`],
        ]) +
        metricLine('Issues', [
          ['failed / returned', intIN(p.failedOrReturned), accentIf(p.failedOrReturned, 'red')],
          ['awaiting UTR', `${intIN(p.awaitingUtr)} (${rupees(p.awaitingUtrPaise)})`, accentIf(p.awaitingUtr, 'amber')],
        ]),
    ),
    renderSection(
      'Messages — delivery failures',
      t.messages,
      (m) => m.otpFailed + m.smsFailed + m.whatsappFailed + m.broadcastFailed === 0,
      (m) =>
        metricLine('Failed', [
          ['OTP', intIN(m.otpFailed), accentIf(m.otpFailed, 'red')],
          ['SMS', intIN(m.smsFailed), accentIf(m.smsFailed, 'red')],
          ['WhatsApp', intIN(m.whatsappFailed), accentIf(m.whatsappFailed, 'red')],
          ['WhatsApp broadcasts', intIN(m.broadcastFailed), accentIf(m.broadcastFailed, 'red')],
        ]),
    ),
    renderSection(
      'Visibility',
      t.visibility,
      (v) => v.submitted === 0 && v.approved === 0 && v.rejected === 0 && v.pending === 0,
      (v) =>
        metricLine('In window', [
          ['submitted', intIN(v.submitted)],
          ['approved', intIN(v.approved)],
          ['rejected', intIN(v.rejected)],
        ]) + metricLine('Right now', [['pending review', intIN(v.pending), accentIf(v.pending, 'amber')]]),
    ),
    renderSection(
      'Sales Import',
      t.salesImport,
      (s) => s.processed === 0 && s.failed === 0 && !s.openMonths.some((m) => m.targetsChangedSinceApply),
      (s) =>
        metricLine('In window', [
          ['processed', intIN(s.processed)],
          ['failed', intIN(s.failed), accentIf(s.failed, 'red')],
        ]) +
        (s.openMonths.length > 0
          ? table(
              [{ label: 'Open month' }, { label: 'Last applied' }, { label: 'Targets changed since apply' }],
              s.openMonths.map((m) => [
                esc(monthLabel(m.month)),
                esc(m.lastAppliedAtMs === null ? 'Never' : formatDateIST(new Date(m.lastAppliedAtMs))),
                m.targetsChangedSinceApply
                  ? `<strong style="color:#b91c1c;">${esc('Yes — recalculate')}</strong>`
                  : esc('No'),
              ]),
            )
          : ''),
    ),
    renderSection('Billing progress', t.billing, () => false, billingBody),
  ].join('');
}

function tenantBlock(t: TenantDigest, attention: string[]): string {
  const badge =
    attention.length > 0
      ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#fef2f2;color:#b91c1c;font-size:12px;font-weight:700;">${esc(plural(attention.length, 'needs attention', 'need attention'))}</span>`
      : '';
  const head = `<div style="font-size:16px;font-weight:700;color:#111827;margin:0 0 8px;">${esc(t.name)}${badge}</div>`;
  const sections = tenantSections(t);
  const bullets =
    attention.length > 0
      ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin:0 0 8px;"><div style="font-size:12px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;">Needs attention</div><ul style="margin:0;padding-left:18px;font-size:13px;color:#7f1d1d;">${attention
          .map((a) => `<li style="margin:2px 0;">${esc(a)}</li>`)
          .join('')}</ul></div>`
      : '';
  const body = sections === '' && attention.length === 0 ? `<div style="font-size:13px;color:${MUTED};">All quiet — nothing to report.</div>` : bullets + sections;
  return `<div data-tenant="${esc(t.clientId)}" style="border-top:1px solid #eef0f2;padding:18px 0 6px;margin-top:8px;">${head}${body}</div>`;
}

// ── Builder ───────────────────────────────────────────────────────────────────────────────────

const headline = <T,>(r: SectionResult<T> | undefined, pick: (d: T) => string): string => (r ? (r.ok ? pick(r.data) : '—') : '—');

/** Render the digest. Always produces an email (an all-quiet day says so). */
export function buildDailyOpsDigest(input: DigestInput): DigestResult {
  const rows = input.tenants.map((t) => ({ t, attention: needsAttention(t) }));
  rows.sort((a, b) => b.attention.length - a.attention.length || a.t.name.localeCompare(b.t.name));

  const tenantsNeedingAttention = rows.filter((r) => r.attention.length > 0).length;
  const gifsyWide = gifsyWideAttention(input);
  const attentionItems = rows.reduce((s, r) => s + r.attention.length, 0) + gifsyWide.length;
  const otp = input.unattributedOtpFailed;
  const otpProblem = otp ? (!otp.ok || otp.data > 0) : false;

  const summaryTable = table(
    [
      { label: 'Tenant' },
      { label: 'Needs attention', align: 'right' },
      { label: 'KYC pending', align: 'right' },
      { label: 'Redemptions', align: 'right' },
      { label: 'Points credited', align: 'right' },
      { label: 'Payouts paid', align: 'right' },
    ],
    rows.map(({ t, attention }) => [
      esc(t.name),
      attention.length > 0 ? `<strong style="color:#b91c1c;">${esc(intIN(attention.length))}</strong>` : esc('0'),
      esc(headline(t.kyc, (k) => intIN(k.field.pending + k.gifsy.pending))),
      esc(headline(t.redemptions, (r) => intIN(r.requested))),
      esc(headline(t.points, (p) => intIN(p.credited))),
      esc(headline(t.payouts, (p) => intIN(p.creditPaid + p.redemptionPaid))),
    ]),
    'No active tenants.',
  );

  const allQuiet = tenantsNeedingAttention === 0 && !otpProblem && gifsyWide.length === 0;
  const gifsyWideBox =
    gifsyWide.length > 0
      ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin:8px 0;"><div style="font-size:12px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;">Needs attention — Gifsy-wide</div><ul style="margin:0;padding-left:18px;font-size:13px;color:#7f1d1d;">${gifsyWide
          .map((a) => `<li style="margin:2px 0;">${esc(a)}</li>`)
          .join('')}</ul></div>`
      : '';
  const summary =
    sectionHeading('All tenants') +
    statRow([
      { label: 'Tenants', value: intIN(rows.length) },
      { label: 'Need attention', value: intIN(tenantsNeedingAttention), accent: tenantsNeedingAttention > 0 ? 'red' : 'green' },
      { label: 'Attention items', value: intIN(attentionItems), accent: attentionItems > 0 ? 'red' : 'green' },
    ]) +
    (allQuiet
      ? `<div style="font-size:14px;font-weight:600;color:#047857;margin:6px 0 10px;">All quiet — no tenant needs attention.</div>`
      : '') +
    summaryTable +
    (otp && !otp.ok
      ? `<div style="font-size:13px;color:#b91c1c;margin:6px 0;">Couldn't load the pre-login OTP failures (${esc(otp.error)}).</div>`
      : otp && otp.ok && otp.data > 0
        ? `<div style="font-size:13px;color:#b91c1c;margin:6px 0;">${esc(plural(otp.data, 'OTP', 'OTPs'))} failed delivery before login (no tenant known).</div>`
        : '') +
    gifsyWideBox +
    dispersalBlock(input.voucherDispersal);

  const body = summary + sectionHeading('By tenant') + rows.map(({ t, attention }) => tenantBlock(t, attention)).join('');

  const html = emailShell({
    title: 'Daily operations digest',
    intro: `Window: ${input.window.label}`,
    body,
    dateLabel: input.dateLabel,
  });

  return {
    key: 'dailyDigest',
    // Gifsy-wide items are not a tenant, so they don't change N — but the subject must not read "0 need
    // attention" while a dispersal problem sits in the body.
    subject: `Gifsy daily operations — ${input.dateLabel} — ${tenantsNeedingAttention} need attention${gifsyWide.length > 0 ? ' + Gifsy-wide items' : ''}`,
    html,
    tenantsNeedingAttention,
    attentionItems,
    gifsyWideItems: gifsyWide.length,
  };
}
