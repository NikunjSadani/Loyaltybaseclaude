/// <reference types="vitest/globals" />
/**
 * /admin/sales-import/months (close / Gifsy-only reopen, §7.3, §11 F-5) + the salesImport feature gate (F-2).
 * Run: npx vitest run src/app/admin/sales-import/__tests__/months-and-gate.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SalesMonthRow } from '@/lib/sales-import/types';

const roleRef = { current: 'CLIENT_ADMIN' };
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: roleRef.current }) }));

const apiMock = vi.hoisted(() => ({ months: vi.fn(), closeMonth: vi.fn(), reopenMonth: vi.fn() }));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock }));

import MonthsPage from '../months/page';
import { SalesImportFeatureGate } from '../_components/sales-import-feature-gate';

function row(over: Partial<SalesMonthRow>): SalesMonthRow {
  return {
    month: '2026-10', state: 'OPEN', implicit: true, closedAt: null, closedBy: null, lastAppliedAt: '2026-11-02T05:00:00.000Z',
    lastAppliedImportId: 'i1', canClose: true, canReopen: false, ...over,
  };
}
const ok = <T,>(data: T) => ({ success: true as const, data });

beforeEach(() => {
  roleRef.current = 'CLIENT_ADMIN';
  Object.values(apiMock).forEach((f) => f.mockReset());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('months page', () => {
  const rows = [
    row({ month: '2026-11', canClose: false }),
    row({ month: '2026-10' }),
    row({ month: '2026-09', state: 'CLOSED', implicit: false, closedAt: '2026-10-03T05:00:00.000Z', closedBy: 'Asha', canClose: false, canReopen: true }),
  ];

  it('closes a month after a confirm that says only Gifsy can reopen', async () => {
    apiMock.months.mockResolvedValue(ok(rows));
    apiMock.closeMonth.mockResolvedValue(ok(row({ month: '2026-10', state: 'CLOSED', canClose: false, canReopen: true })));
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Close October 2026' });
    expect(screen.queryByRole('button', { name: 'Close November 2026' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(btn); });
    expect((window.confirm as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/Only Gifsy can reopen it/);
    expect(apiMock.closeMonth).toHaveBeenCalledWith('2026-10');
    expect(await screen.findByRole('status')).toHaveTextContent('October 2026 is closed');
  });

  it('warns when closing a month that never had a file applied', async () => {
    apiMock.months.mockResolvedValue(ok([row({ lastAppliedAt: null, lastAppliedImportId: null })]));
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    render(<MonthsPage />);
    const target = await screen.findByRole('button', { name: 'Close October 2026' });
    await act(async () => { fireEvent.click(target); });
    expect((window.confirm as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/No sales file has ever been applied/);
    expect(apiMock.closeMonth).not.toHaveBeenCalled();
  });

  it('CLIENT_ADMIN never sees Reopen', async () => {
    apiMock.months.mockResolvedValue(ok(rows));
    render(<MonthsPage />);
    await screen.findByText('September 2026');
    expect(screen.queryByRole('button', { name: /Reopen/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Ask Gifsy to reopen it/)).toBeInTheDocument();
  });

  it('GIFSY_ADMIN can reopen a closed month', async () => {
    roleRef.current = 'GIFSY_ADMIN';
    apiMock.months.mockResolvedValue(ok(rows));
    apiMock.reopenMonth.mockResolvedValue(ok(row({ month: '2026-09' })));
    render(<MonthsPage />);
    const target = await screen.findByRole('button', { name: 'Reopen September 2026' });
    await act(async () => { fireEvent.click(target); });
    expect(apiMock.reopenMonth).toHaveBeenCalledWith('2026-09');
  });

  it('a refused close shows the server reason', async () => {
    apiMock.months.mockResolvedValue(ok(rows));
    apiMock.closeMonth.mockResolvedValue({ success: false, error: 'The current month cannot be closed.', status: 409 });
    render(<MonthsPage />);
    const target = await screen.findByRole('button', { name: 'Close October 2026' });
    await act(async () => { fireEvent.click(target); });
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot be closed');
  });
});

describe('SalesImportFeatureGate', () => {
  function stubConfig(res: Response | Error) {
    vi.stubGlobal('fetch', vi.fn(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res))));
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('flag OFF → not-enabled message, children hidden', async () => {
    stubConfig(json({ success: true, data: { features: {} } }));
    render(<SalesImportFeatureGate><p>inner</p></SalesImportFeatureGate>);
    expect(await screen.findByTestId('sales-import-disabled')).toBeInTheDocument();
    expect(screen.queryByText('inner')).not.toBeInTheDocument();
  });

  it('flag ON → children', async () => {
    stubConfig(json({ success: true, data: { features: { salesImport: true } } }));
    render(<SalesImportFeatureGate><p>inner</p></SalesImportFeatureGate>);
    expect(await screen.findByText('inner')).toBeInTheDocument();
  });

  it('fetch failure is not "disabled" — it offers Retry', async () => {
    stubConfig(json({}, 500));
    render(<SalesImportFeatureGate><p>inner</p></SalesImportFeatureGate>);
    expect(await screen.findByTestId('sales-import-gate-error')).toBeInTheDocument();
  });
});
