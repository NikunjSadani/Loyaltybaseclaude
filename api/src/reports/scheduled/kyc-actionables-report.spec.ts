import { buildKycActionablesReport } from './kyc-actionables-report';
import type { ReportContext } from './report.types';
import type { KycSlaTargets } from '../../common/kyc-sla-stage';

/**
 * Deterministic unit tests for the two-stage KYC actionables builder.
 *
 * Fixtures speak IST (the business-hours clock's day/weekend boundaries are IST). Anchor week:
 * 2026-01-26 is a Monday → 2026-01-28 is a Wednesday, 2026-01-19 a Monday. "now" = fixed Wed noon.
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
const slaTargets = new Map<string, KycSlaTargets>([['deoleo', { fieldHrs: 24, gifsyHrs: 96 }]]);
const gifsyHist = (ms: number) => [{ toStatus: 'PENDING_GIFSY', createdAt: new Date(ms) }];

describe('buildKycActionablesReport (two-stage)', () => {
  it('is empty (empty=true) with all-clear html when nothing is pending', async () => {
    const prisma = makePrisma();
    prisma.kycSubmission.findMany.mockResolvedValue([]);

    const res = await buildKycActionablesReport(prisma as any, makeCtx(), holidays, slaTargets);

    expect(res.key).toBe('kycActionables');
    expect(res.empty).toBe(true);
    expect(res.subject).toBe('[Gifsy] KYC actionables — 11 Aug 2026');
    expect(res.html).toContain('No pending KYC — all clear.');
  });

  it('splits field vs Gifsy SLA: a field row within, a Gifsy row breached from its latest entry', async () => {
    const prisma = makePrisma();
    prisma.kycSubmission.findMany.mockResolvedValue([
      // FIELD stage: submitted Wed 09:00 IST → 3 business hours < 24 field target → within.
      { status: 'PENDING_SO_APPROVAL', submittedAt: new Date(IST(2026, 1, 28, 9, 0)), createdAt: new Date(IST(2026, 1, 28, 8, 0)), user: { clientId: 'deoleo' }, statusHistory: [] },
      // GIFSY stage: latest PENDING_GIFSY entry Mon 2026-01-19 09:00 IST → 171 business hours > 96 → breached.
      { status: 'PENDING_GIFSY', submittedAt: new Date(IST(2026, 1, 28, 11, 0)), createdAt: new Date(IST(2026, 1, 28, 10, 0)), user: { clientId: 'deoleo' }, statusHistory: gifsyHist(IST(2026, 1, 19, 9, 0)) },
    ]);

    const res = await buildKycActionablesReport(prisma as any, makeCtx(), holidays, slaTargets);

    expect(res.empty).toBe(false);
    expect(res.html).toContain('Deoleo India');
    expect(res.html).toContain('Awaiting Gifsy');
    expect(res.html).toContain('Gifsy SLA breached');
    expect(res.html).toContain('Field SLA breached');
    // Oldest business hours = 171 (Mon 19 09:00 → Wed 28 12:00, weekend frozen).
    expect(res.html).toContain('171');
  });

  it('uses the LATEST PENDING_GIFSY entry (restart on re-entry) for the Gifsy clock', async () => {
    const prisma = makePrisma();
    prisma.kycSubmission.findMany.mockResolvedValue([
      {
        status: 'PENDING_GIFSY',
        submittedAt: new Date(IST(2026, 1, 20, 0, 0)),
        createdAt: new Date(IST(2026, 1, 20, 0, 0)),
        user: { clientId: 'deoleo' },
        // Two entries: an old one (would breach) and a recent one (Wed 06:00 → 6h, within).
        statusHistory: [
          { toStatus: 'PENDING_GIFSY', createdAt: new Date(IST(2026, 1, 19, 9, 0)) },
          { toStatus: 'PENDING_GIFSY', createdAt: new Date(IST(2026, 1, 28, 6, 0)) },
        ],
      },
    ]);

    const res = await buildKycActionablesReport(prisma as any, makeCtx(), holidays, slaTargets);
    // Latest entry Wed 06:00 → 6 business hours < 96 → NOT breached; oldest shows 6, not 171.
    expect(res.html).toContain('6');
    expect(res.html).not.toContain('171');
  });

  it('HTML-escapes a malicious tenant display name (no raw <script>)', async () => {
    const prisma = makePrisma();
    prisma.kycSubmission.findMany.mockResolvedValue([
      { status: 'SUBMITTED', submittedAt: new Date(IST(2026, 1, 28, 9, 0)), createdAt: new Date(IST(2026, 1, 28, 8, 0)), user: { clientId: 'evil' }, statusHistory: [] },
    ]);

    const ctx = makeCtx({ tenantNames: new Map([['evil', '<script>alert(1)</script>']]) });
    const res = await buildKycActionablesReport(prisma as any, ctx, holidays, slaTargets);

    expect(res.empty).toBe(false);
    expect(res.html).not.toContain('<script>alert(1)</script>');
    expect(res.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('defaults to 24/96 for an unconfigured tenant and is defensive on junk rows', async () => {
    const prisma = makePrisma();
    prisma.kycSubmission.findMany.mockResolvedValue([
      null,
      // field row, submittedAt null → createdAt Mon 19 → 171 business hrs > 24 field default → breached.
      { status: 'UNDER_REVIEW', submittedAt: null, createdAt: new Date(IST(2026, 1, 19, 9, 0)), user: { clientId: 'other' }, statusHistory: null },
    ]);

    const res = await buildKycActionablesReport(prisma as any, makeCtx(), holidays, slaTargets);
    expect(res.empty).toBe(false);
    expect(res.html).toContain('other'); // clientId used as fallback name
    expect(res.html.length).toBeGreaterThan(0);
  });
});
