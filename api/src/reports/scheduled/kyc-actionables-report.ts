/**
 * Scheduled INTERNAL report #3 — KYC actionables digest (all tenants).
 *
 * Rolls up every pending KYC submission across all tenants and ages each on the TWO-STAGE
 * business-hours SLA (owner decision 2026-08-11), reusing the shared `kycStageSla`:
 *   • FIELD SLA  — submitted → reaching Gifsy (default 24 business hrs), owned by the sales chain.
 *   • GIFSY SLA  — the LATEST PENDING_GIFSY entry → now (default 96), owned by Gifsy. Restarts on re-entry.
 * A PENDING_GIFSY row is "Gifsy-actionable" — the number the Gifsy ops team acts on directly; its
 * breach is the headline. Field breaches are surfaced too (the field team's SLA). DRAFT is never
 * included (not in PENDING_STATUSES). Always sent; `empty` when nothing is pending.
 *
 * Deterministic ("now" is ctx.nowMs, never Date.now()); every dynamic value is HTML-escaped;
 * defensive — junk rows skipped, never thrown.
 */

import type { PrismaService } from '../../prisma/prisma.service';
import type { KycActionablesBuilder } from './report.types';
import { kycStageSla, latestGifsyEntryMs, KycSlaTargets, KYC_FIELD_SLA_DEFAULT, KYC_GIFSY_SLA_DEFAULT } from '../../common/kyc-sla-stage';
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

const DEFAULT_TARGETS: KycSlaTargets = { fieldHrs: KYC_FIELD_SLA_DEFAULT, gifsyHrs: KYC_GIFSY_SLA_DEFAULT };

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
  gifsyBreached: number;
  fieldBreached: number;
  oldestHrs: number;
}

const emptyAgg = (): TenantAgg => ({ pending: 0, awaitingGifsy: 0, gifsyBreached: 0, fieldBreached: 0, oldestHrs: 0 });

export const buildKycActionablesReport: KycActionablesBuilder = async (
  prisma: PrismaService,
  ctx,
  holidays,
  slaTargets,
) => {
  let subs: Array<{
    status?: unknown;
    submittedAt?: unknown;
    createdAt?: unknown;
    user?: { clientId?: unknown } | null;
    statusHistory?: Array<{ toStatus?: unknown; createdAt?: unknown }> | null;
  }> = [];
  try {
    const rows = await prisma.kycSubmission.findMany({
      where: { status: { in: [...PENDING_STATUSES] } },
      select: {
        status: true,
        submittedAt: true,
        createdAt: true,
        user: { select: { clientId: true } },
        statusHistory: { where: { toStatus: 'PENDING_GIFSY' }, select: { toStatus: true, createdAt: true } },
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
  let totalGifsyBreached = 0;
  let totalFieldBreached = 0;

  for (const s of subs) {
    if (!s || typeof s !== 'object') continue;
    const clientId =
      s.user && typeof s.user === 'object' && typeof s.user.clientId === 'string' && s.user.clientId
        ? s.user.clientId
        : 'unknown';
    const targets = slaTargets.get(clientId) ?? DEFAULT_TARGETS;

    // Two-stage SLA via the shared helper: field rows age from submission, Gifsy rows from the
    // LATEST PENDING_GIFSY entry, each vs its own target.
    const sla = kycStageSla(
      {
        status: typeof s.status === 'string' ? s.status : '',
        submittedAt: ms(s.submittedAt) ?? ms(s.createdAt),
        gifsyEnteredAt: latestGifsyEntryMs(s.statusHistory as never),
        nowMs: ctx.nowMs,
      },
      targets,
      holidays,
    );

    const a = get(clientId);
    a.pending += 1;
    totalPending += 1;
    if (sla.clock === 'gifsy') {
      a.awaitingGifsy += 1;
      totalAwaitingGifsy += 1;
      if (sla.breached) {
        a.gifsyBreached += 1;
        totalGifsyBreached += 1;
      }
    } else if (sla.clock === 'field' && sla.breached) {
      a.fieldBreached += 1;
      totalFieldBreached += 1;
    }
    if (sla.ageHrs > a.oldestHrs) a.oldestHrs = sla.ageHrs;
  }

  const stats = statRow([
    { label: 'Total pending', value: intIN(totalPending) },
    { label: 'Awaiting Gifsy', value: intIN(totalAwaitingGifsy), accent: 'amber' },
    { label: 'Gifsy SLA breached', value: intIN(totalGifsyBreached), accent: 'red' },
    { label: 'Field SLA breached', value: intIN(totalFieldBreached), accent: 'amber' },
  ]);

  const rows = [...byTenant.entries()]
    .map(([clientId, a]) => ({ name: ctx.tenantNames.get(clientId) ?? clientId, a }))
    .sort((x, y) => x.name.localeCompare(y.name))
    .map(({ name, a }) => [
      esc(name),
      esc(intIN(a.pending)),
      `<span style="font-weight:700;color:${a.awaitingGifsy > 0 ? '#b45309' : '#374151'};">${esc(intIN(a.awaitingGifsy))}</span>`,
      `<span style="font-weight:700;color:${a.gifsyBreached > 0 ? '#b91c1c' : '#374151'};">${esc(intIN(a.gifsyBreached))}</span>`,
      esc(intIN(a.fieldBreached)),
      esc(intIN(a.oldestHrs)),
    ]);

  const body =
    stats +
    table(
      [
        { label: 'Tenant' },
        { label: 'Pending', align: 'right' },
        { label: 'Awaiting Gifsy', align: 'right' },
        { label: 'Gifsy breached', align: 'right' },
        { label: 'Field breached', align: 'right' },
        { label: 'Oldest (business hrs)', align: 'right' },
      ],
      rows,
      'No per-tenant pending KYC.',
    );

  const html = emailShell({
    title: 'KYC actionables',
    intro: `All pending KYC across tenants — Field SLA (submission → Gifsy) and Gifsy SLA (Gifsy queue → decision), business hours.`,
    body,
    dateLabel: ctx.dateLabel,
  });

  return { key: 'kycActionables', subject, html, empty: false };
};
