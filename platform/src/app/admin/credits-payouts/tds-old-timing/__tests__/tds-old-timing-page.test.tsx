/// <reference types="vitest/globals" />
/**
 * 194C TDS old-timing check page (Gifsy admin only, read-only): loading → rows, error → Retry, empty state,
 * non-Gifsy → "Gifsy admins only" (no fetch).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>();
  return { ...actual, useAdminSession: vi.fn() };
});

import { useAdminSession } from '@/lib/admin-session';
import TdsOldTimingCheckPage from '../page';

function asRole(role: 'GIFSY_ADMIN' | 'CLIENT_ADMIN') {
  vi.mocked(useAdminSession).mockReturnValue({
    role, name: 'Test', userId: '', canManageSchemes: role === 'GIFSY_ADMIN',
  } as ReturnType<typeof useAdminSession>);
}

const ROW = {
  recoveryId: 'r1',
  clientId: 'bajaj',
  payee: 'Sharma Traders',
  fyLabel: 'FY 2026-27',
  tenantSharePaise: 123450,
  tdsInvoiceNumber: 'TDS-0001',
  bankFileCode: 'PD-2026-10-001',
  recordedAt: '2026-10-05T06:30:00.000Z',
  payouts: { PAID: { count: 2, paise: 500000 }, FAILED: { count: 1, paise: 100000 } },
  notPaid: { count: 1, paise: 100000 },
};

function stub(impl: () => Promise<unknown>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}
const ok = (payload: unknown, status = 200) => async () => ({ ok: status < 400, status, json: async () => payload });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('TDS old-timing check page', () => {
  it('shows what the check cannot determine, and another client’s never-paid payouts inside a row', async () => {
    asRole('GIFSY_ADMIN');
    stub(ok({ success: true, data: { rows: [{ ...ROW, notPaidByClient: { deoleo: { count: 1, paise: 100000 } } }], limits: ['Rows before 24 Nov carry no bank-file link.'] } }));
    render(<TdsOldTimingCheckPage />);
    expect((await screen.findByTestId('tds-old-timing-limits')).textContent).toContain('no bank-file link');
    expect(screen.getByTestId('tds-old-timing-byclient-r1').textContent).toContain('deoleo: 1');
  });

  it('shows loading, then the rows', async () => {
    asRole('GIFSY_ADMIN');
    let resolve: (v: unknown) => void = () => {};
    const fn = stub(() => new Promise((r) => { resolve = r; }));
    render(<TdsOldTimingCheckPage />);
    expect(await screen.findByText('194C TDS raised at the bank file — check')).toBeInTheDocument();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { rows: [ROW], limits: [] } }) });
    const row = await screen.findByTestId('tds-old-timing-row-r1');
    expect(row.textContent).toContain('Sharma Traders');
    expect(row.textContent).toContain('₹1,234.50');
    expect(row.textContent).toContain('TDS-0001');
    expect(row.textContent).toContain('PD-2026-10-001');
    expect(row.textContent).toContain('FAILED: 1 (₹1,000.00)');
    expect(fn).toHaveBeenCalledWith('/api/admin/credits/tds-recovery/old-timing-check');
    expect(screen.getByRole('button', { name: 'Download (.xlsx)' })).not.toBeDisabled();
  });

  it('an error shows the server message with Retry, and Retry reloads', async () => {
    asRole('GIFSY_ADMIN');
    const fn = stub(ok({ success: false, error: 'Forbidden' }, 403));
    render(<TdsOldTimingCheckPage />);
    expect((await screen.findByTestId('tds-old-timing-error')).textContent).toContain('Forbidden');
    fn.mockImplementation(ok({ success: true, data: { rows: [ROW], limits: [] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('tds-old-timing-row-r1')).toBeInTheDocument();
  });

  it('empty list → "Nothing to check" and Download disabled', async () => {
    asRole('GIFSY_ADMIN');
    stub(ok({ success: true, data: { rows: [], limits: [] } }));
    render(<TdsOldTimingCheckPage />);
    expect((await screen.findByTestId('tds-old-timing-empty')).textContent).toBe('Nothing to check');
    expect(screen.getByRole('button', { name: 'Download (.xlsx)' })).toBeDisabled();
  });

  it('non-Gifsy admin → "Gifsy admins only", nothing fetched', async () => {
    asRole('CLIENT_ADMIN');
    const fn = stub(ok({ success: true, data: { rows: [ROW], limits: [] } }));
    render(<TdsOldTimingCheckPage />);
    expect(await screen.findByText('Gifsy admins only.')).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });
});
