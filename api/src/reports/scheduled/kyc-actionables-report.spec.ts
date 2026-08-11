import { buildKycActionablesReport } from './kyc-actionables-report';
import type { ReportContext } from './report.types';

/**
 * Deterministic unit tests for the KYC actionables builder.
 *
 * Fixtures speak IST (the business-hours clock's day/weekend boundaries are IST). Anchor week
 * (verified in business-hours.spec.ts): 2026-01-26 is a Monday, so 2026-01-28 is a Wednesday and
 * 2026-01-19 is a Monday. "now" is a fixed Wednesday noon IST; ages are pure functions of ctx.nowMs.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const IST = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;

const NOW = IST(2026, 1, 28, 12, 0); // Wednesday noon IST

function makeCtx(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    startIst: IST(2026, 1, 28, 0, 0),
    endIst: IST(2026, 1, 29, 0, 0),
    dateLabel: '11 Aug 2026',
    nowMs: NOW,
    tenantNames: new Map([['deoleo', 'Deoleo India']]),
    activeTenantIds: ['deoleo'],
    ...overrides,
  };
}

function makePrisma() {
  return {
    creditBatch: { findMany: jest.fn() },
    payoutTransaction: { findMany: jest.fn() },
    kycSubmission: { findMany: jest.fn() },
  };
}

const holidays = new Set<string>();
const slaTargetHours = new Map<string, number>([['deoleo', 48]]);

describe('buildKycActionablesReport', () => {
  it('is empty (empty=true) with all-clear html when nothing is pending', async () => {
    const prisma = makePrisma();
    prisma.kycSubmission.findMany.mockResolvedValue([]);

    const res = await buildKycActionablesReport(prisma as any, makeCtx(), holidays, slaTargetHours);

    expect(res.key).toBe('kycActionables');
    expect(res.empty).toBe(true);
    expect(res.subject).toBe('[Gifsy] KYC actionables — 11 Aug 2026');
    expect(res.html).toContain('No pending KYC — all clear.');
  });

  it('aggregates pending by tenant with business-hours SLA + Gifsy/breach counts', async () => {
    const prisma = makePrisma();
    prisma.kycSubmission.findMany.mockResolvedValue([
      // Within SLA: submitted Wed 09:00 IST → 3 business hours (< 48).
      { status: 'PENDING_SO_APPROVAL', submittedAt: new Date(IST(2026, 1, 28, 9, 0)), createdAt: new Date(IST(2026, 1, 28, 8, 0)), user: { clientId: 'deoleo' }, statusHistory: [] },
      // PENDING_GIFSY: recent submittedAt would be within SLA, but the statusHistory clock
      // starts Mon 2026-01-19 09:00 IST → ~171 business hours → BREACHED, and awaiting-Gifsy.
      { status: 'PENDING_GIFSY', submittedAt: new Date(IST(2026, 1, 28, 11, 0)), createdAt: new Date(IST(2026, 1, 28, 10, 0)), user: { clientId: 'deoleo' }, statusHistory: [{ createdAt: new Date(IST(2026, 1, 19, 9, 0)) }] },
    ]);

    const res = await buildKycActionablesReport(prisma as any, makeCtx(), holidays, slaTargetHours);

    expect(res.empty).toBe(false);
    expect(res.subject).toBe('[Gifsy] KYC actionables — 11 Aug 2026');
    expect(res.html).toContain('Deoleo India');
    // Totals: Total pending 2, Awaiting Gifsy 1, Breached 1.
    expect(res.html).toContain('Total pending');
    expect(res.html).toContain('Awaiting Gifsy');
    expect(res.html).toContain('Breached');
    // Oldest business hours = 171 (Mon 19 09:00 → Wed 28 12:00, weekend frozen).
    expect(res.html).toContain('171');
  });

  it('HTML-escapes a malicious tenant display name (no raw <script>)', async () => {
    const prisma = makePrisma();
    prisma.kycSubmission.findMany.mockResolvedValue([
      { status: 'SUBMITTED', submittedAt: new Date(IST(2026, 1, 28, 9, 0)), createdAt: new Date(IST(2026, 1, 28, 8, 0)), user: { clientId: 'evil' }, statusHistory: [] },
    ]);

    const ctx = makeCtx({ tenantNames: new Map([['evil', '<script>alert(1)</script>']]) });
    const res = await buildKycActionablesReport(prisma as any, ctx, holidays, slaTargetHours);

    expect(res.empty).toBe(false);
    expect(res.html).not.toContain('<script>alert(1)</script>');
    expect(res.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('uses the default 48h SLA when a tenant has no configured target, and is defensive on junk rows', async () => {
    const prisma = makePrisma();
    prisma.kycSubmission.findMany.mockResolvedValue([
      null,
      { status: 'UNDER_REVIEW', submittedAt: null, createdAt: new Date(IST(2026, 1, 19, 9, 0)), user: { clientId: 'other' }, statusHistory: null },
    ]);

    // slaTargetHours has no 'other' entry → default 48h; created Mon 19 → breached by Wed 28.
    const res = await buildKycActionablesReport(prisma as any, makeCtx(), holidays, slaTargetHours);
    expect(res.empty).toBe(false);
    expect(res.html).toContain('other'); // clientId used as fallback name
    expect(res.html.length).toBeGreaterThan(0);
  });
});
