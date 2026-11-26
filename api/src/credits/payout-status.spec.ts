/**
 * Payout Status breakdown (owner 2026-11-25) + the CANCELLED consumers that must keep a cancelled payout out of
 * bank files, the bank-result upload, the reversal picker and Fund Reconciliation's charge.
 */
import { buildPayoutStatus, type StatusEntryRow } from './payout-status';
import { creditItem } from '../fund/fund-sources.loader';
import { classifyPayoutCandidates } from './payout-reversal-v2';
import { groupUtrBatchRows } from './credits.helpers';

const T = new Date(Date.now() - 3 * 86_400_000);
let n = 0;
function row(status: string, paise: number, over: Partial<StatusEntryRow> = {}): StatusEntryRow {
  n += 1;
  return {
    id: `e${n}`, fieldId: 'f1', fieldName: 'Incentive', outletId: `O${n}`, outletName: `Outlet ${n}`, period: '2026-10',
    amountPaise: BigInt(paise), status, utr: status === 'PAID' ? `UTR${n}` : null, paidAt: status === 'PAID' ? T : null,
    createdAt: T, updatedAt: T, cancelledAt: status === 'CANCELLED' ? T : null, tdsDeductedPaise: 0n,
    batch: { batchCode: 'CB-1', sourceKind: null }, reversalAllocations: [], heldByReversal: false, ...over,
  };
}
const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b1', batchCode: 'CB-1', period: '2026-10', status: 'CONFIRMED', totalPayoutPaise: 0n, sourceKind: null,
  rows: [] as unknown, ...over,
});

describe('buildPayoutStatus', () => {
  it('every status has its own amount + count; buckets reconcile to the upload total and to Fund Reconciliation', () => {
    const entries = [
      row('PAID', 10000, { tdsDeductedPaise: 1000n }),
      row('PAID', 5000, { utr: 'TDS-WITHHELD-PD-1' }),
      row('PROCESSING', 7000),
      row('PENDING', 3000),
      row('PENDING', 2000, { heldByReversal: true }),
      row('FAILED', 4000, { fieldId: 'f2', fieldName: 'Visibility' }),
      row('REVERSED', 1500),
      row('CANCELLED', 2500, { fieldId: 'f2', fieldName: 'Visibility' }),
    ];
    const total = entries.reduce((s, e) => s + Number(e.amountPaise), 0);
    const s = buildPayoutStatus({ batch: batch({ totalPayoutPaise: BigInt(total) }), entries, visibilityFieldIds: new Set(['f2']), notApplied: [] });
    expect(s.overall.buckets).toEqual({
      PAID: { count: 2, paise: 15000 },
      PROCESSING: { count: 1, paise: 7000 },
      PENDING: { count: 2, paise: 5000 },
      FAILED: { count: 1, paise: 4000 },
      REVERSED: { count: 1, paise: 1500 },
      CANCELLED: { count: 1, paise: 2500 },
    });
    expect(s.overall.total).toEqual({ count: 8, paise: total });
    expect(s.overall.paidTdsWithheldPaise).toBe(1000);
    expect(s.overall.paidSettledByTds).toEqual({ count: 1, paise: 5000 });
    expect(s.overall.pendingHeldByReversal).toEqual({ count: 1, paise: 2000 });
    expect(s.entriesTotalPaise).toBe(s.uploadTotalPaise);
    expect(s.reconciles).toBe(true);
    expect(s.notes).toEqual([]);
    // Fund Reconciliation's own rule over the SAME rows: committed = in file + pending + failed; returned = reversed
    // before payment + cancelled; paid = paid.
    expect(s.fund).toEqual({
      committed: { count: 4, paise: 7000 + 5000 + 4000 },
      paid: { count: 2, paise: 15000 },
      returned: { count: 2, paise: 1500 + 2500 },
      excludedVendorImport: { count: 0, paise: 0 },
    });
    // Per field line.
    const vis = s.fields.find((f) => f.fieldId === 'f2')!;
    expect(vis.breakdown.buckets.FAILED).toEqual({ count: 1, paise: 4000 });
    expect(vis.breakdown.buckets.CANCELLED).toEqual({ count: 1, paise: 2500 });
    expect(s.fields.reduce((t, f) => t + f.breakdown.total.paise, 0)).toBe(total);
  });

  it('says out loud when the upload header total differs from the payout rows created', () => {
    const s = buildPayoutStatus({ batch: batch({ totalPayoutPaise: 20000n }), entries: [row('PENDING', 15000)], visibilityFieldIds: new Set(), notApplied: [] });
    expect(s.notes[0]).toMatch(/differs from the payout rows created/);
  });

  it('points are shown apart (credited points, not money), net of rows not credited at confirm', () => {
    const rows = [
      { status: 'OK', awardType: 'POINTS', amount: 100 },
      { status: 'OK', awardType: 'POINTS', amount: 50 },
      { status: 'OK', awardType: 'POINTS', amount: -20 },
      { status: 'ERROR', awardType: 'POINTS', amount: 999 },
    ];
    const s = buildPayoutStatus({ batch: batch({ rows }), entries: [], visibilityFieldIds: new Set(), notApplied: [{ points: 50 }] });
    expect(s.points).toEqual({ creditedRows: 1, creditedPoints: 100, notCreditedRows: 1, notCreditedPoints: 50, deductedRows: 1, deductedPoints: 20 });
    expect(s.overall.total.paise).toBe(0);
  });
});

describe('CANCELLED consumers', () => {
  it('Fund Reconciliation: a cancelled payout is not charged — listed returned on the cancel day, flagged Cancelled', () => {
    const e = row('CANCELLED', 2500);
    const it = creditItem(e, new Set());
    expect(it).toMatchObject({ status: 'RETURNED', returnedAt: e.cancelledAt, paidAt: null, utr: null });
    expect(it!.flags).toEqual(['PAYOUT_CANCELLED']);
  });

  it('reversal picker: a cancelled entry cannot be reversed (its own reason)', () => {
    const [c] = classifyPayoutCandidates(
      [{ id: 'c1', amountPaise: 100n, status: 'CANCELLED', period: '2026-10', createdAt: T, tdsDeductedPaise: 0n, tdsSection: null, outletId: 'O1' }],
      [],
      [],
    );
    expect(c).toMatchObject({ selectable: false, blockedBy: 'CANCELLED' });
  });

  it('bank-result upload: a failed-then-cancelled outlet is settled (never PENDING / payable)', () => {
    const g = groupUtrBatchRows([
      { outletId: 'O1', status: 'CANCELLED' },
      { outletId: 'O2', status: 'CANCELLED' },
      { outletId: 'O2', status: 'FAILED' },
    ]);
    expect(g.find((r) => r.outletId === 'O1')!.utrStatus).toBe('CANCELLED');
    expect(g.find((r) => r.outletId === 'O2')!.utrStatus).toBe('FAILED');
  });
});
