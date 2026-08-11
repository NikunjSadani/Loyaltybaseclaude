/**
 * Scheduled INTERNAL report #3 — KYC actionables digest (all tenants).
 *
 * Rolls up every pending KYC submission across all tenants by stage, ages each on the
 * BUSINESS-hours SLA clock (weekends + the holiday set frozen), and flags SLA breaches per
 * tenant (`slaTargetHours.get(clientId) ?? 48`). A submission at stage PENDING_GIFSY is
 * "Gifsy-actionable" — the number the Gifsy ops team acts on directly. Always sent (the runner
 * does not suppress this), but `empty` is true when nothing is pending.
 *
 * SLA clock start: submittedAt ?? createdAt. For a PENDING_GIFSY row the clock instead starts at
 * the EARLIEST statusHistory entry whose toStatus is PENDING_GIFSY (when present) — the moment it
 * actually landed in the Gifsy queue — else it falls back to the submitted/created start.
 *
 * Pure-ish + deterministic: "now" is ctx.nowMs (never Date.now()); every dynamic value is
 * HTML-escaped. Defensive — junk rows are skipped, never thrown.
 */

import type { PrismaService } from '../../prisma/prisma.service';
import type { KycActionablesBuilder } from './report.types';
import { businessHoursBetween } from '../../common/business-hours';
import { emailShell, esc, intIN, statRow, table } from './email-html';

const PENDING_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'PENDING_PENNY_DROP',
  'PENDING_AGREEMENT',
  'PENDING_SO_APPROVAL',
  'PENDING_ASM_APPROVAL',
  'PENDING_RSM_APPROVAL',
  'PENDING_GIFSY',
] as const;

const DEFAULT_SLA_HOURS = 48;

/** Best-effort epoch-ms from a Date | string | number (NaN → null). */
function ms(v: unknown): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

interface TenantAgg {
  pending: number;
  awaitingGifsy: number;
  withinSla: number;
  breached: number;
  oldestHrs: number;
}

function emptyAgg(): TenantAgg {
  return { pending: 0, awaitingGifsy: 0, withinSla: 0, breached: 0, oldestHrs: 0 };
}

export const buildKycActionablesReport: KycActionablesBuilder = async (
  prisma: PrismaService,
  ctx,
  holidays,
  slaTargetHours,
) => {
  let subs: Array<{
    status?: unknown;
    submittedAt?: unknown;
    createdAt?: unknown;
    user?: { clientId?: unknown } | null;
    statusHistory?: Array<{ createdAt?: unknown }> | null;
  }> = [];
  try {
    const rows = await prisma.kycSubmission.findMany({
      where: { status: { in: [...PENDING_STATUSES] } },
      select: {
        status: true,
        submittedAt: true,
        createdAt: true,
        user: { select: { clientId: true } },
        statusHistory: { where: { toStatus: 'PENDING_GIFSY' }, select: { createdAt: true } },
      },
    });
    if (Array.isArray(rows)) subs = rows as typeof subs;
  } catch {
    subs = [];
  }

  const subject = `[Gifsy] KYC actionables — ${ctx.dateLabel}`;

  if (subs.length === 0) {
    const html = emailShell({
      title: 'KYC actionables',
      intro: 'No pending KYC — all clear.',
      body: `<p style="margin:0;font-size:13px;color:#9ca3af;">No pending KYC — all clear.</p>`,
      dateLabel: ctx.dateLabel,
    });
    return { key: 'kycActionables', subject, html, empty: true };
  }

  const byTenant = new Map<string, TenantAgg>();
  const get = (clientId: string): TenantAgg => {
    let a = byTenant.get(clientId);
    if (!a) {
      a = emptyAgg();
      byTenant.set(clientId, a);
    }
    return a;
  };

  let totalPending = 0;
  let totalAwaitingGifsy = 0;
  let totalBreached = 0;

  for (const s of subs) {
    if (!s || typeof s !== 'object') continue;
    const clientId =
      s.user && typeof s.user === 'object' && typeof s.user.clientId === 'string' && s.user.clientId
        ? s.user.clientId
        : 'unknown';
    const isGifsy = s.status === 'PENDING_GIFSY';

    // SLA clock start.
    let startTs = ms(s.submittedAt) ?? ms(s.createdAt) ?? ctx.nowMs;
    if (isGifsy && Array.isArray(s.statusHistory) && s.statusHistory.length > 0) {
      let earliest: number | null = null;
      for (const h of s.statusHistory) {
        const t = h && typeof h === 'object' ? ms(h.createdAt) : null;
        if (t !== null && (earliest === null || t < earliest)) earliest = t;
      }
      if (earliest !== null) startTs = earliest;
    }

    const ageHrs = businessHoursBetween(startTs, ctx.nowMs, holidays);
    const target = slaTargetHours.get(clientId) ?? DEFAULT_SLA_HOURS;
    const breached = ageHrs > target;

    const a = get(clientId);
    a.pending += 1;
    if (isGifsy) a.awaitingGifsy += 1;
    if (breached) a.breached += 1;
    else a.withinSla += 1;
    if (ageHrs > a.oldestHrs) a.oldestHrs = ageHrs;

    totalPending += 1;
    if (isGifsy) totalAwaitingGifsy += 1;
    if (breached) totalBreached += 1;
  }

  const stats = statRow([
    { label: 'Total pending', value: intIN(totalPending) },
    { label: 'Awaiting Gifsy', value: intIN(totalAwaitingGifsy), accent: 'amber' },
    { label: 'Breached SLA', value: intIN(totalBreached), accent: 'red' },
  ]);

  const rows = [...byTenant.entries()]
    .map(([clientId, a]) => ({ name: ctx.tenantNames.get(clientId) ?? clientId, a }))
    .sort((x, y) => x.name.localeCompare(y.name))
    .map(({ name, a }) => [
      esc(name),
      esc(intIN(a.pending)),
      // Emphasize awaiting-Gifsy (amber) + breached (red) numbers.
      `<span style="font-weight:700;color:${a.awaitingGifsy > 0 ? '#b45309' : '#374151'};">${esc(intIN(a.awaitingGifsy))}</span>`,
      esc(intIN(a.withinSla)),
      `<span style="font-weight:700;color:${a.breached > 0 ? '#b91c1c' : '#374151'};">${esc(intIN(a.breached))}</span>`,
      esc(intIN(a.oldestHrs)),
    ]);

  const body =
    stats +
    table(
      [
        { label: 'Tenant' },
        { label: 'Pending' },
        { label: 'Awaiting Gifsy', align: 'right' },
        { label: 'Within SLA', align: 'right' },
        { label: 'Breached', align: 'right' },
        { label: 'Oldest (business hrs)', align: 'right' },
      ],
      rows,
      'No per-tenant pending KYC.',
    );

  const html = emailShell({
    title: 'KYC actionables',
    intro: `All pending KYC across tenants, aged on the business-hours SLA clock.`,
    body,
    dateLabel: ctx.dateLabel,
  });

  return { key: 'kycActionables', subject, html, empty: false };
};
