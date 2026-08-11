/**
 * Scheduled INTERNAL report #1 — Credits & Payouts (all tenants, today IST).
 *
 * Rolls up the day's CONFIRMED credit batches (CreditBatch.confirmedAt in the window) and the
 * day's SUCCESSFUL payout transactions (PayoutTransaction.completedAt in the window, tenant
 * resolved via partner.clientId). Suppress-if-empty: `empty` is true when there were neither
 * batches nor payouts today, so the runner can skip the send.
 *
 * Pure-ish + deterministic: all time/now comes from `ctx` (never Date.now()), and every dynamic
 * value is HTML-escaped via the email-html helpers. Defensive by contract — a query returning an
 * unexpected shape (null row, missing partner, non-array) must never throw into the runner.
 */

import type { PrismaService } from '../../prisma/prisma.service';
import type { CreditsPayoutsBuilder } from './report.types';
import { emailShell, esc, intIN, rupees, statRow, table } from './email-html';

/** Coerce an unknown into a finite number (0 on junk) — keeps counts/points defensive. */
function num(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Coerce an unknown into a BigInt of paise (0n on junk) — for money sums. */
function big(v: unknown): bigint {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  } catch {
    /* fall through */
  }
  return 0n;
}

interface TenantAgg {
  batches: number;
  outlets: number;
  points: number;
  payoutCommittedPaise: bigint;
  payoutsDone: number;
  processedPaise: bigint;
}

function emptyAgg(): TenantAgg {
  return { batches: 0, outlets: 0, points: 0, payoutCommittedPaise: 0n, payoutsDone: 0, processedPaise: 0n };
}

export const buildCreditsPayoutsReport: CreditsPayoutsBuilder = async (prisma: PrismaService, ctx) => {
  // ── Query A: credit batches CONFIRMED today (all tenants) ────────────────────
  let batches: Array<{
    clientId?: unknown;
    batchCode?: unknown;
    period?: unknown;
    totalOutlets?: unknown;
    totalPoints?: unknown;
    totalPayoutPaise?: unknown;
  }> = [];
  try {
    const rows = await prisma.creditBatch.findMany({
      where: { status: 'CONFIRMED', confirmedAt: { gte: new Date(ctx.startIst), lt: new Date(ctx.endIst) } },
      select: { clientId: true, batchCode: true, period: true, totalOutlets: true, totalPoints: true, totalPayoutPaise: true },
    });
    if (Array.isArray(rows)) batches = rows as typeof batches;
  } catch {
    batches = [];
  }

  // ── Query B: payouts SUCCESS today (all tenants; tenant via partner.clientId) ─
  let payouts: Array<{ amountPaise?: unknown; partner?: { clientId?: unknown } | null }> = [];
  try {
    const rows = await prisma.payoutTransaction.findMany({
      where: { status: 'SUCCESS', completedAt: { gte: new Date(ctx.startIst), lt: new Date(ctx.endIst) } },
      select: { amountPaise: true, partner: { select: { clientId: true } } },
    });
    if (Array.isArray(rows)) payouts = rows as typeof payouts;
  } catch {
    payouts = [];
  }

  const isEmpty = batches.length === 0 && payouts.length === 0;
  const subject = `[Gifsy] Credits & Payouts — ${ctx.dateLabel}`;

  if (isEmpty) {
    const html = emailShell({
      title: 'Credits & Payouts',
      intro: 'No credit or payout activity today.',
      body: `<p style="margin:0;font-size:13px;color:#9ca3af;">No credit batches were confirmed and no payouts were processed today.</p>`,
      dateLabel: ctx.dateLabel,
    });
    return { key: 'creditsPayouts', subject, html, empty: true };
  }

  // ── Group both by clientId ───────────────────────────────────────────────────
  const byTenant = new Map<string, TenantAgg>();
  const get = (clientId: string): TenantAgg => {
    let a = byTenant.get(clientId);
    if (!a) {
      a = emptyAgg();
      byTenant.set(clientId, a);
    }
    return a;
  };

  let totalBatches = 0;
  let totalPoints = 0;
  let totalCommittedPaise = 0n;
  for (const b of batches) {
    if (!b || typeof b !== 'object') continue;
    const clientId = typeof b.clientId === 'string' && b.clientId ? b.clientId : 'unknown';
    const a = get(clientId);
    a.batches += 1;
    a.outlets += num(b.totalOutlets);
    a.points += num(b.totalPoints);
    a.payoutCommittedPaise += big(b.totalPayoutPaise);
    totalBatches += 1;
    totalPoints += num(b.totalPoints);
    totalCommittedPaise += big(b.totalPayoutPaise);
  }

  let totalPayoutsDone = 0;
  let totalProcessedPaise = 0n;
  for (const p of payouts) {
    if (!p || typeof p !== 'object') continue;
    const clientId =
      p.partner && typeof p.partner === 'object' && typeof p.partner.clientId === 'string' && p.partner.clientId
        ? p.partner.clientId
        : 'unknown';
    const a = get(clientId);
    a.payoutsDone += 1;
    a.processedPaise += big(p.amountPaise);
    totalPayoutsDone += 1;
    totalProcessedPaise += big(p.amountPaise);
  }

  // ── Headline totals ──────────────────────────────────────────────────────────
  const stats = statRow([
    { label: 'Credit batches', value: intIN(totalBatches) },
    { label: 'Points credited', value: intIN(totalPoints) },
    { label: 'Payout committed', value: rupees(totalCommittedPaise) },
    { label: 'Payouts processed', value: intIN(totalPayoutsDone) },
    { label: '₹ processed', value: rupees(totalProcessedPaise) },
  ]);

  // ── Per-tenant table (sorted by tenant display name for stable output) ───────
  const rows = [...byTenant.entries()]
    .map(([clientId, a]) => ({ name: ctx.tenantNames.get(clientId) ?? clientId, a }))
    .sort((x, y) => x.name.localeCompare(y.name))
    .map(({ name, a }) => [
      esc(name),
      esc(intIN(a.batches)),
      esc(intIN(a.outlets)),
      esc(intIN(a.points)),
      esc(rupees(a.payoutCommittedPaise)),
      esc(intIN(a.payoutsDone)),
      esc(rupees(a.processedPaise)),
    ]);

  const body =
    stats +
    table(
      [
        { label: 'Tenant' },
        { label: 'Batches' },
        { label: 'Outlets' },
        { label: 'Points', align: 'right' },
        { label: 'Payout committed', align: 'right' },
        { label: 'Payouts done', align: 'right' },
        { label: '₹ processed', align: 'right' },
      ],
      rows,
      'No per-tenant activity.',
    );

  const html = emailShell({
    title: 'Credits & Payouts',
    intro: `Credit batches confirmed and payouts processed today, across all tenants.`,
    body,
    dateLabel: ctx.dateLabel,
  });

  return { key: 'creditsPayouts', subject, html, empty: false };
};
