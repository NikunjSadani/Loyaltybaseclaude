/// <reference types="vitest/globals" />
/**
 * Payout status breakdown (owner 2026-11-25): every bucket with amount + rows, a Total, Paid sub-notes (TDS withheld,
 * settled by TDS), pending held by a reversal, the failed re-bank note, points separately, the reconciliation + Fund
 * line, every server note (amber), a red warning when the figures don't reconcile, an error with Retry, and a
 * bucket click that filters the rows.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import PayoutStatusBreakdown from '../PayoutStatusBreakdown';
import type { Breakdown, PayoutStatusData } from '../payout-cancel-shared';

const m = (count: number, paise: number) => ({ count, paise });
const BD: Breakdown = {
  buckets: {
    PAID: m(2, 200000), PROCESSING: m(1, 50000), PENDING: m(3, 30000),
    FAILED: m(1, 10000), REVERSED: m(0, 0), CANCELLED: m(1, 5000),
  },
  other: m(0, 0),
  total: m(8, 295000),
  paidTdsWithheldPaise: 2000,
  paidSettledByTds: m(1, 1500),
  pendingHeldByReversal: m(1, 10000),
};
const DATA: PayoutStatusData = {
  batch: { id: 'b1', batchCode: 'CB-1', period: '2026-10', status: 'CONFIRMED', totalPayoutPaise: 295000, sourceKind: 'UPLOAD' },
  overall: BD,
  fields: [
    { fieldId: 'f1', fieldName: 'Volume', breakdown: BD },
    { fieldId: 'f2', fieldName: 'Visibility', breakdown: { ...BD, buckets: { ...BD.buckets, FAILED: m(4, 40000) } } },
  ],
  entriesTotalPaise: 295000,
  uploadTotalPaise: 295000,
  reconciles: true,
  notes: ['3 rows were imported from the earlier vendor.'],
  fund: { committed: m(4, 90000), paid: m(2, 200000), returned: m(1, 5000), excludedVendorImport: m(0, 0) },
  points: { creditedRows: 4, creditedPoints: 1200, notCreditedRows: 1, notCreditedPoints: 50, deductedRows: 0, deductedPoints: 0 },
};

function stub(payload: unknown, status = 200) {
  const fn = vi.fn(async () => ({ ok: status < 400, status, json: async () => payload }));
  vi.stubGlobal('fetch', fn);
  return fn;
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('PayoutStatusBreakdown', () => {
  it('renders every bucket with amount + rows, the total, sub-notes, points, reconciliation and notes', async () => {
    stub({ success: true, data: DATA });
    const onPick = vi.fn();
    render(<PayoutStatusBreakdown batchId="b1" refreshKey={0} onPick={onPick} />);
    const overall = await screen.findByTestId('breakdown-overall');
    expect(overall.textContent).toContain('This upload — all fields');

    const row = (k: string) => screen.getByTestId(`breakdown-overall-${k}`).textContent ?? '';
    expect(row('PAID')).toContain('Paid');
    expect(row('PAID')).toContain('₹2,000.00');
    expect(row('PAID')).toContain('2 rows');
    expect(row('PAID')).toContain('incl. TDS withheld ₹20.00');
    expect(row('PAID')).toContain('1 row (₹15.00) settled by TDS (no bank payment)');
    expect(row('PROCESSING')).toContain('In bank file (awaiting bank result)');
    expect(row('PENDING')).toContain('Pending (not yet in a bank file)');
    expect(row('PENDING')).toContain('1 row (₹100.00) held by a pending reversal');
    expect(row('FAILED')).toContain('will be re-banked in the next bank file');
    expect(row('REVERSED')).toContain('0 rows');
    expect(row('CANCELLED')).toContain('₹50.00');
    expect(row('TOTAL')).toContain('8 rows');
    expect(row('TOTAL')).toContain('₹2,950.00');

    // per field line too
    expect(screen.getByTestId('breakdown-field-f2-FAILED').textContent).toContain('₹400.00');

    expect(screen.getByTestId('payout-status-reconciliation').textContent).toContain(
      'Payout rows total ₹2,950.00 (8 rows) = sum of the statuses above.',
    );
    expect(screen.getByTestId('payout-status-reconciliation').textContent).toContain(
      'Fund Reconciliation for these rows: committed ₹900.00 / paid ₹2,000.00 / returned (incl. cancelled) ₹50.00',
    );
    expect(screen.getByTestId('payout-status-points').textContent).toContain('Points credited 1,200 pts to 4 outlets — points, not money.');
    expect(screen.getByTestId('payout-status-points').textContent).toContain('Points NOT credited: 50 pts (1 row).');
    expect(screen.getByTestId('payout-status-points').textContent).not.toContain('deducted');
    expect(screen.getByTestId('payout-status-notes').textContent).toBe('3 rows were imported from the earlier vendor.');
    expect(screen.queryByTestId('payout-status-not-reconciled')).toBeNull();

    // clicking a bucket filters the rows (with the field for a field line)
    const failedButtons = screen.getAllByRole('button', { name: 'Failed — show these rows' }); // overall, f1, f2
    expect(failedButtons).toHaveLength(3);
    fireEvent.click(failedButtons[0]);
    expect(onPick).toHaveBeenCalledWith('FAILED');
    fireEvent.click(failedButtons[2]);
    expect(onPick).toHaveBeenLastCalledWith('FAILED', 'f2');
  });

  it('shows a red warning when the figures do not reconcile', async () => {
    stub({ success: true, data: { ...DATA, reconciles: false, entriesTotalPaise: 295000, uploadTotalPaise: 300000, notes: [] } });
    render(<PayoutStatusBreakdown batchId="b1" refreshKey={0} onPick={vi.fn()} />);
    const warn = await screen.findByTestId('payout-status-not-reconciled');
    expect(warn).toHaveAttribute('role', 'alert');
    expect(warn.textContent).toContain('the payout rows total ₹2,950.00 but the upload total is ₹3,000.00');
  });

  it('a failed load shows the server error with Retry, and Retry reloads', async () => {
    const fn = stub({ success: false, error: 'Batch not found' }, 404);
    render(<PayoutStatusBreakdown batchId="b1" refreshKey={0} onPick={vi.fn()} />);
    expect((await screen.findByTestId('payout-status-error')).textContent).toContain('Batch not found');
    fn.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: DATA }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading the status breakdown' }));
    expect(await screen.findByTestId('breakdown-overall')).toBeInTheDocument();
  });
});
