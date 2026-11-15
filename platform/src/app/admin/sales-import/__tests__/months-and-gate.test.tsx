/// <reference types="vitest/globals" />
/**
 * /admin/sales-import/months (close / Gifsy-only reopen, §7.3, §11 F-5) + the salesImport feature gate (F-2).
 * Run: npx vitest run src/app/admin/sales-import/__tests__/months-and-gate.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EMPTY_MONTH_RECONCILIATION, type SalesMonthRecalcPreview, type SalesMonthRow } from '@/lib/sales-import/types';

const roleRef = { current: 'CLIENT_ADMIN' };
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: roleRef.current }) }));

const apiMock = vi.hoisted(() => ({ months: vi.fn(), closeMonth: vi.fn(), reopenMonth: vi.fn(), recalcPreview: vi.fn(), recalculate: vi.fn(), rebuildProductList: vi.fn() }));
const perms = vi.hoisted(() => ({ granted: true }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ role: 'CLIENT_ADMIN', permissions: [], ready: true, error: false, retry: () => {}, has: () => perms.granted }),
}));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock }));

import MonthsPage from '../months/page';
import { SalesImportFeatureGate } from '../_components/sales-import-feature-gate';

function row(over: Partial<SalesMonthRow>): SalesMonthRow {
  return {
    month: '2026-10', state: 'OPEN', implicit: true, closedAt: null, closedBy: null, lastAppliedAt: '2026-11-02T05:00:00.000Z',
    lastAppliedImportId: 'i1', canClose: true, canReopen: false, downstream: { creditBatches: 0, exports: 0 },
    hasHistory: false, historySourceImportId: null, historyAppliedAt: null, productListCurrent: true, targetsChangedSinceApply: false, ...over,
  };
}
const ok = <T,>(data: T) => ({ success: true as const, data });

function recalc(over: Partial<SalesMonthRecalcPreview> = {}): SalesMonthRecalcPreview {
  return {
    month: '2026-10', monthState: 'OPEN', canApply: true, definitionsHash: 'dh1', historySourceImportId: 'i1',
    historyAppliedAt: '2026-11-02T05:00:00.000Z', matchedOutlets: 3, unmatchedCustomers: 1, matchedAmountRupees: 1200,
    matchedQuantity: 4, unmatchedAmountRupees: 30, unmatchedQuantity: 0, zeroFillOutlets: 2, outletsAffected: 5,
    warnings: [], kpis: [{ kpiCode: 'KPI_NEW', label: 'New KPI', measure: 'AMOUNT', newTotal: 900, currentTotal: 0, delta: 900, outletsNonZero: 3, outletsNegative: 0 }],
    reconciliation: EMPTY_MONTH_RECONCILIATION, ...over,
  };
}

beforeEach(() => {
  perms.granted = true;
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
    apiMock.reopenMonth.mockResolvedValue(ok({ ...row({ month: '2026-09' }), warnings: [] }));
    render(<MonthsPage />);
    const target = await screen.findByRole('button', { name: 'Reopen September 2026' });
    await act(async () => { fireEvent.click(target); });
    expect(apiMock.reopenMonth).toHaveBeenCalledWith('2026-09', {});
    expect(await screen.findByRole('status')).toHaveTextContent('September 2026 is open again');
  });

  it('reopening a month with credit batches / exports names them and sends the acknowledgement', async () => {
    roleRef.current = 'GIFSY_ADMIN';
    apiMock.months.mockResolvedValue(ok([row({
      month: '2026-09', state: 'CLOSED', canClose: false, canReopen: true, downstream: { creditBatches: 2, exports: 1 },
    })]));
    apiMock.reopenMonth.mockResolvedValue(ok({ ...row({ month: '2026-09' }), warnings: ['2 credit batches exist for 2026-09.'] }));
    render(<MonthsPage />);
    const reopenBtn = await screen.findByRole('button', { name: 'Reopen September 2026' });
    await act(async () => { fireEvent.click(reopenBtn); });
    expect((window.confirm as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/2 credit batches and 1 points export/);
    expect(apiMock.reopenMonth).toHaveBeenCalledWith('2026-09', { acknowledgeDownstream: true });
    const msg = await screen.findByRole('status');
    expect(msg).toHaveTextContent('Check: 2 credit batches exist for 2026-09.');
    expect(msg.textContent).not.toContain('..');
  });

  it('a 409 asking for the acknowledgement re-confirms, then retries with it', async () => {
    roleRef.current = 'GIFSY_ADMIN';
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-09', state: 'CLOSED', canClose: false, canReopen: true })]));
    apiMock.reopenMonth
      .mockResolvedValueOnce({ success: false, error: 'Reopening September 2026 needs confirmation: 2 credit batches exist for 2026-09.', status: 409 })
      .mockResolvedValueOnce(ok({ ...row({ month: '2026-09' }), warnings: [] }));
    render(<MonthsPage />);
    const reopenBtn = await screen.findByRole('button', { name: 'Reopen September 2026' });
    await act(async () => { fireEvent.click(reopenBtn); });
    expect(apiMock.reopenMonth).toHaveBeenNthCalledWith(2, '2026-09', { acknowledgeDownstream: true });
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

describe('months page — recalculate from stored history', () => {
  const histRow = (over: Partial<SalesMonthRow> = {}) => row({
    month: '2026-10', hasHistory: true, historySourceImportId: 'i1', historyAppliedAt: '2026-11-02T05:00:00.000Z', ...over,
  });

  it('an OPEN month with history: preview (totals, change, outlets affected) → confirm → apply with both tokens', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    apiMock.recalculate.mockResolvedValue(ok({ month: '2026-10', ok: true, outletsWritten: 5, outletsZeroFilled: 2 }));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    const panel = await screen.findByTestId('recalc-preview');
    expect(panel).toHaveTextContent('5 outlets would change');
    expect(panel).toHaveTextContent('New KPI');
    expect(panel).toHaveTextContent('+₹900');
    expect(screen.getByTestId('recalc-panel-2026-10')).toHaveTextContent('nothing is re-uploaded');
    const callsBefore = apiMock.months.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    expect((window.confirm as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/Nothing is re-uploaded/);
    expect(apiMock.recalculate).toHaveBeenCalledWith('2026-10', { expectedDefinitionsHash: 'dh1', expectedHistoryAppliedAt: '2026-11-02T05:00:00.000Z' });
    expect(await screen.findByTestId('recalc-result')).toHaveTextContent('October 2026 recalculated: 5 outlets updated, 2 set to 0');
    expect(apiMock.months.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('cancelling the confirm changes nothing', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    await screen.findByTestId('recalc-preview');
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    expect(apiMock.recalculate).not.toHaveBeenCalled();
  });

  it('a stale token (409) reloads the preview and says so', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    apiMock.recalculate.mockResolvedValue({ success: false, error: 'The KPI definitions changed.', status: 409 });
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    await screen.findByTestId('recalc-preview');
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    const n = await screen.findByTestId('recalc-notice');
    expect(n).toHaveTextContent('Nothing was changed: The KPI definitions changed. The preview has been refreshed');
    expect(n.textContent).not.toContain('..');
    expect(apiMock.recalcPreview).toHaveBeenCalledTimes(2);
  });

  it('a CLOSED month with history shows the action disabled with the reason', async () => {
    apiMock.months.mockResolvedValue(ok([histRow({ state: 'CLOSED', canClose: false, canReopen: true })]));
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Recalculate October 2026 from stored history' });
    expect(btn).toBeDisabled();
    expect(screen.getByText('Gifsy must reopen this month first')).toBeInTheDocument();
  });

  it('no action for a month without history, or without targets:upload', async () => {
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-10' })]));
    const view = render(<MonthsPage />);
    await screen.findByText('October 2026');
    expect(screen.queryByRole('button', { name: /Recalculate/ })).not.toBeInTheDocument();
    view.unmount();
    perms.granted = false;
    apiMock.months.mockResolvedValue(ok([histRow()]));
    render(<MonthsPage />);
    await screen.findByText('October 2026');
    expect(screen.queryByRole('button', { name: /Recalculate/ })).not.toBeInTheDocument();
  });

  it('a blocked preview (e.g. no KPIs / month closed meanwhile) disables Recalculate with the reason', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc({ canApply: false, blockedReason: 'October 2026 is closed.' })));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    expect(await screen.findByTestId('recalc-apply')).toBeDisabled();
    expect(screen.getByTestId('recalc-blocked')).toHaveTextContent('October 2026 is closed.');
  });

  it('MAPPING_CHANGED is explained in full without hover; recalculation stays possible', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc({ warnings: ['MAPPING_CHANGED'] })));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    expect(await screen.findByTestId('recalc-warnings')).toHaveTextContent(
      /column settings changed after this month was saved\. Every KPI can still be calculated from the stored lines.*check the totals before you recalculate/,
    );
    expect(screen.getByTestId('recalc-apply')).toBeEnabled();
  });

  it('a blocked recalculation shows the reason prominently (alert), not only beside the button', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc({
      canApply: false, blockedReason: 'KPI_X uses the "Pack size" column, which the stored lines for October 2026 do not have.',
    })));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    const b = await screen.findByTestId('recalc-blocked-banner');
    expect(b).toHaveAttribute('role', 'alert');
    expect(b).toHaveTextContent('October 2026 cannot be recalculated: KPI_X uses the "Pack size" column');
    expect(b.textContent).not.toContain('..');
    expect(screen.getByTestId('recalc-apply')).toBeDisabled();
  });

  it('404 (no stored history) is explained', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue({ success: false, error: 'Not found', status: 404 });
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    expect(await screen.findByTestId('recalc-error')).toHaveTextContent('has no stored history yet');
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

  it('a 409 that is NOT the downstream acknowledgement is shown, not re-asked', async () => {
    roleRef.current = 'GIFSY_ADMIN';
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-09', state: 'CLOSED', canClose: false, canReopen: true })]));
    apiMock.reopenMonth.mockResolvedValue({ success: false, error: 'September 2026 is already open.', status: 409 });
    render(<MonthsPage />);
    const reopenBtn = await screen.findByRole('button', { name: 'Reopen September 2026' });
    await act(async () => { fireEvent.click(reopenBtn); });
    expect(apiMock.reopenMonth).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent('September 2026 was not reopened: September 2026 is already open.');
    expect(apiMock.months).toHaveBeenCalledTimes(2); // re-fetched
  });
});

describe('months page — Rebuild product list (§10c)', () => {
  it('only a month with history whose product list is not current offers it (OPEN or CLOSED); confirm → rebuilt, row updated', async () => {
    apiMock.months.mockResolvedValue(ok([
      row({ month: '2026-10', hasHistory: true, productListCurrent: true }),
      row({ month: '2026-09', state: 'CLOSED', canClose: false, hasHistory: true, productListCurrent: false }),
      row({ month: '2026-08', hasHistory: false }),
    ]));
    apiMock.rebuildProductList.mockResolvedValue(ok(row({ month: '2026-09', state: 'CLOSED', canClose: false, hasHistory: true, productListCurrent: true })));
    await act(async () => { render(<MonthsPage />); });
    expect(screen.queryByTestId('rebuild-product-list-2026-10')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rebuild-product-list-2026-08')).not.toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Rebuild the product list for September 2026' });
    await act(async () => { fireEvent.click(btn); });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/doesn't change any figures/));
    expect(apiMock.rebuildProductList).toHaveBeenCalledWith('2026-09');
    expect(screen.getByRole('status')).toHaveTextContent('The product list for September 2026 is rebuilt. No figures changed.');
    expect(screen.queryByTestId('rebuild-product-list-2026-09')).not.toBeInTheDocument();
  });

  it('cancel changes nothing; a refused rebuild shows the server reason; no button without targets:upload', async () => {
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-09', hasHistory: true, productListCurrent: false })]));
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await act(async () => { render(<MonthsPage />); });
    await act(async () => { fireEvent.click(screen.getByTestId('rebuild-product-list-2026-09')); });
    expect(apiMock.rebuildProductList).not.toHaveBeenCalled();
    apiMock.rebuildProductList.mockResolvedValue({ success: false, error: 'September 2026 is busy (a sales file is being applied, or the list is very large). Try again in a few minutes.', status: 409 });
    await act(async () => { fireEvent.click(screen.getByTestId('rebuild-product-list-2026-09')); });
    expect(screen.getByRole('alert')).toHaveTextContent('The product list for September 2026 was not rebuilt: September 2026 is busy');
  });

  it('no Rebuild button without targets:upload', async () => {
    perms.granted = false;
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-09', hasHistory: true, productListCurrent: false })]));
    await act(async () => { render(<MonthsPage />); });
    expect(screen.queryByTestId('rebuild-product-list-2026-09')).not.toBeInTheDocument();
  });

  it('?from=&to= (link from the KPI picker) lists exactly that range so every named month is shown; to is clamped at now', async () => {
    window.history.pushState({}, '', '/admin/sales-import/months?from=2024-03&to=2025-12');
    try {
      apiMock.months.mockResolvedValue(ok([row({ month: '2025-12', hasHistory: true, productListCurrent: false }), row({ month: '2024-03', hasHistory: true, productListCurrent: false })]));
      await act(async () => { render(<MonthsPage />); });
      expect(apiMock.months).toHaveBeenCalledWith('2024-03', '2025-12');
      expect(screen.getByTestId('rebuild-product-list-2025-12')).toBeInTheDocument();
      expect(screen.getByTestId('rebuild-product-list-2024-03')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
    const nowIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
    window.history.pushState({}, '', '/admin/sales-import/months?from=2025-12&to=2999-01');
    try {
      apiMock.months.mockClear();
      await act(async () => { render(<MonthsPage />); });
      expect(apiMock.months).toHaveBeenCalledWith('2025-12', nowIst);
    } finally {
      window.history.pushState({}, '', '/');
    }
    window.history.pushState({}, '', '/admin/sales-import/months?from=2025-12'); // from only (span too long)
    try {
      apiMock.months.mockClear();
      await act(async () => { render(<MonthsPage />); });
      expect(apiMock.months).toHaveBeenCalledWith('2025-12');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});
