import { buildCreditsPayoutsReport } from './credits-payouts-report';
import type { ReportContext } from './report.types';

/**
 * Deterministic unit tests for the Credits & Payouts builder. All time comes from `ctx`
 * (fixed plain numbers) — never Date.now() — so these never rot. Money is Prisma BigInt.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const IST = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;

function makeCtx(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    startIst: IST(2026, 8, 11, 0, 0),
    endIst: IST(2026, 8, 12, 0, 0),
    dateLabel: '11 Aug 2026',
    nowMs: IST(2026, 8, 11, 12, 0),
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

describe('buildCreditsPayoutsReport', () => {
  it('is empty (empty=true) but still returns valid html when both queries are empty', async () => {
    const prisma = makePrisma();
    prisma.creditBatch.findMany.mockResolvedValue([]);
    prisma.payoutTransaction.findMany.mockResolvedValue([]);

    const res = await buildCreditsPayoutsReport(prisma as any, makeCtx());

    expect(res.key).toBe('creditsPayouts');
    expect(res.empty).toBe(true);
    expect(res.subject).toBe('[Gifsy] Credits & Payouts — 11 Aug 2026');
    expect(res.html).toContain('No credit or payout activity today.');
    expect(res.html.length).toBeGreaterThan(0);
  });

  it('rolls up batches + payouts, resolves tenant name, shows totals (empty=false)', async () => {
    const prisma = makePrisma();
    prisma.creditBatch.findMany.mockResolvedValue([
      { clientId: 'deoleo', batchCode: 'CB-1', period: '2026-08', totalOutlets: 3, totalPoints: 1500, totalPayoutPaise: 250000n },
      { clientId: 'deoleo', batchCode: 'CB-2', period: '2026-08', totalOutlets: 2, totalPoints: 500, totalPayoutPaise: 100000n },
    ]);
    prisma.payoutTransaction.findMany.mockResolvedValue([
      { amountPaise: 120000n, partner: { clientId: 'deoleo' } },
      { amountPaise: 80000n, partner: { clientId: 'deoleo' } },
    ]);

    const res = await buildCreditsPayoutsReport(prisma as any, makeCtx());

    expect(res.empty).toBe(false);
    expect(res.subject).toBe('[Gifsy] Credits & Payouts — 11 Aug 2026');
    expect(res.html).toContain('Deoleo India');
    // 2 batches, points 2,000, committed ₹3,500 (350000 paise), 2 payouts, ₹2,000 processed.
    expect(res.html).toContain('2,000'); // total points (Indian grouping)
    expect(res.html).toContain('₹3,500'); // total committed
    expect(res.html).toContain('₹2,000'); // total processed
    // Per-tenant aggregated outlets = 5.
    expect(res.html).toContain('5');
  });

  it('HTML-escapes a malicious tenant display name (no raw <script>)', async () => {
    const prisma = makePrisma();
    prisma.creditBatch.findMany.mockResolvedValue([
      { clientId: 'evil', batchCode: 'CB-9', period: '2026-08', totalOutlets: 1, totalPoints: 10, totalPayoutPaise: 1000n },
    ]);
    prisma.payoutTransaction.findMany.mockResolvedValue([]);

    const ctx = makeCtx({ tenantNames: new Map([['evil', '<script>alert(1)</script>']]) });
    const res = await buildCreditsPayoutsReport(prisma as any, ctx);

    expect(res.empty).toBe(false);
    expect(res.html).not.toContain('<script>alert(1)</script>');
    expect(res.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not throw on unexpected row shapes (defensive)', async () => {
    const prisma = makePrisma();
    prisma.creditBatch.findMany.mockResolvedValue([
      null,
      { clientId: null, totalOutlets: 'oops', totalPoints: undefined, totalPayoutPaise: 'not-a-number' },
    ]);
    prisma.payoutTransaction.findMany.mockResolvedValue([{ amountPaise: undefined, partner: null }]);

    const res = await buildCreditsPayoutsReport(prisma as any, makeCtx());
    expect(res.empty).toBe(false);
    expect(res.html.length).toBeGreaterThan(0);
  });
});
