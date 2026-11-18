/// <reference types="vitest/globals" />
/**
 * /admin/sales-import/months (close / Gifsy-only reopen, §7.3, §11 F-5) + the salesImport feature gate (F-2).
 * Run: npx vitest run src/app/admin/sales-import/__tests__/months-and-gate.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_MONTH_RECONCILIATION, type SalesApplyJobDto, type SalesMonthRecalcPreview, type SalesMonthRow } from '@/lib/sales-import/types';

const roleRef = { current: 'CLIENT_ADMIN' };
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: roleRef.current }) }));

const apiMock = vi.hoisted(() => ({
  months: vi.fn(), closeMonth: vi.fn(), reopenMonth: vi.fn(), recalcPreview: vi.fn(), recalculate: vi.fn(), rebuildProductList: vi.fn(),
  getApplyJob: vi.fn(), findApplyJob: vi.fn(),
}));
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
    hasHistory: false, historySourceImportId: null, historyAppliedAt: null, productListCurrent: true, targetsChangedSinceApply: false, activeJob: null, lastJob: null, ...over,
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
  window.sessionStorage.clear();
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
    expect(await screen.findByText(/Ask Gifsy to reopen it/)).toBeInTheDocument();
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
    expect(await screen.findByTestId('recalc-panel-2026-10')).toHaveTextContent('nothing is re-uploaded');
    const callsBefore = apiMock.months.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    expect((window.confirm as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/Nothing is re-uploaded/);
    expect(apiMock.recalculate).toHaveBeenCalledWith('2026-10', { expectedDefinitionsHash: 'dh1', expectedHistoryAppliedAt: '2026-11-02T05:00:00.000Z', requestId: expect.any(String) });
    expect(await screen.findByTestId('recalc-result')).toHaveTextContent('October 2026 recalculated: 5 outlets updated, 2 set to 0');
    expect(apiMock.months.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('S4: a recalculation that cannot rebuild the day-by-day figures says so in the preview AND the result; the copy says history keeps programme outlets only', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    const reason = "This month's stored sales lines were applied before day-by-day sales were stored, so this month has no day-by-day data. Apply the sales file to the month again to store it.";
    apiMock.recalcPreview.mockResolvedValue(ok(recalc({ dayData: { available: false, reason } })));
    apiMock.recalculate.mockResolvedValue(ok({ month: '2026-10', ok: true, outletsWritten: 5, outletsZeroFilled: 2, dayData: { written: false, outlets: 0, rows: 0, lastDay: null, reason } }));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    const panel = await screen.findByTestId('recalc-preview');
    const pre = screen.getByTestId('day-data-missing-2026-10');
    expect(pre).toHaveAttribute('role', 'alert');
    expect(pre).toHaveTextContent(`Daily figures not stored for October 2026: ${reason}`);
    expect(panel).toHaveTextContent('Stored history keeps programme outlets only');
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    const result = await screen.findByTestId('recalc-result');
    expect(result).toHaveTextContent('October 2026 recalculated: 5 outlets updated, 2 set to 0');
    expect(result).toHaveTextContent(`Daily figures not stored for October 2026: ${reason}`);
  });

  it('S4: when the preview says the day figures CAN be rebuilt, no warning is shown', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc({ dayData: { available: true } })));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    await screen.findByTestId('recalc-preview');
    expect(screen.queryByTestId('day-data-missing-2026-10')).not.toBeInTheDocument();
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
    expect(await screen.findByText('Gifsy must reopen this month first')).toBeInTheDocument();
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
    expect(await screen.findByTestId('recalc-blocked')).toHaveTextContent('October 2026 is closed.');
  });

  it('MAPPING_CHANGED is explained in full without hover; recalculation stays possible', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc({ warnings: ['MAPPING_CHANGED'] })));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    expect(await screen.findByTestId('recalc-warnings')).toHaveTextContent(
      /column settings changed after this month was saved\. Every KPI can still be calculated from the stored lines.*check the totals before you recalculate/,
    );
    expect(await screen.findByTestId('recalc-apply')).toBeEnabled();
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
    expect(await screen.findByTestId('recalc-apply')).toBeDisabled();
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

// ── No reply (proxy / Worker timeout, 5xx, network): never claim "not closed" / "nothing changed" without looking ──
describe('months page — an action whose reply never arrives', () => {
  it('close: no reply, re-read shows CLOSED → reported as closed (slow reply noted), never "was not closed"', async () => {
    apiMock.months
      .mockResolvedValueOnce(ok([row({ month: '2026-10' })]))
      .mockResolvedValue(ok([row({ month: '2026-10', state: 'CLOSED', canClose: false, canReopen: true })]));
    apiMock.closeMonth.mockResolvedValue({ success: false, error: '', status: 500 });
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Close October 2026' });
    await act(async () => { fireEvent.click(btn); });
    const msg = await screen.findByRole('status');
    expect(msg).toHaveTextContent('October 2026 is closed');
    expect(msg).toHaveTextContent(/No clear answer came from the server; checking again confirmed it/);
    expect(screen.queryByText(/was not closed/)).not.toBeInTheDocument();
  });

  it('close: no reply, re-read shows it still OPEN → "was not closed: the server didn’t reply in time", no ": ."', async () => {
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-10' })]));
    apiMock.closeMonth.mockResolvedValue({ success: false, error: 'Failed to fetch' });
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Close October 2026' });
    await act(async () => { fireEvent.click(btn); });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/October 2026 was not closed: the server could not be reached/);
    expect(alert.textContent).not.toMatch(/: \./);
  });

  it('close: no reply AND the re-read fails → "We couldn’t confirm whether October 2026 was closed"', async () => {
    apiMock.months.mockResolvedValueOnce(ok([row({ month: '2026-10' })])).mockResolvedValue({ success: false, error: '', status: 502 });
    apiMock.closeMonth.mockResolvedValue({ success: false, error: '', status: 504 });
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Close October 2026' });
    await act(async () => { fireEvent.click(btn); });
    const alert = await screen.findByText(/couldn.t confirm whether October 2026 was closed/);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(/before trying again/);
  });

  it('a refusal with an EMPTY message never renders "was not closed: ."', async () => {
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-10' })]));
    apiMock.closeMonth.mockResolvedValue({ success: false, error: '', status: 409 });
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Close October 2026' });
    await act(async () => { fireEvent.click(btn); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/: \./);
    expect(alert).toHaveTextContent(/was not closed: \S/);
  });

  it('reopen (GIFSY_ADMIN): no reply, re-read shows OPEN → reported as open again', async () => {
    roleRef.current = 'GIFSY_ADMIN';
    apiMock.months
      .mockResolvedValueOnce(ok([row({ month: '2026-09', state: 'CLOSED', canClose: false, canReopen: true })]))
      .mockResolvedValue(ok([row({ month: '2026-09', state: 'OPEN' })]));
    apiMock.reopenMonth.mockResolvedValue({ success: false, error: '', status: 524 });
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Reopen September 2026' });
    await act(async () => { fireEvent.click(btn); });
    const msg = await screen.findByRole('status');
    expect(msg).toHaveTextContent('September 2026 is open again');
    expect(msg).toHaveTextContent(/No clear answer came from the server; checking again confirmed it/);
  });

  it('rebuild product list: no reply, re-read shows the list current → reported as rebuilt', async () => {
    apiMock.months
      .mockResolvedValueOnce(ok([row({ month: '2026-09', hasHistory: true, productListCurrent: false })]))
      .mockResolvedValue(ok([row({ month: '2026-09', hasHistory: true, productListCurrent: true })]));
    apiMock.rebuildProductList.mockResolvedValue({ success: false, error: '', status: 500 });
    await act(async () => { render(<MonthsPage />); });
    await act(async () => { fireEvent.click(screen.getByTestId('rebuild-product-list-2026-09')); });
    const msg = await screen.findByRole('status');
    expect(msg).toHaveTextContent('The product list for September 2026 is rebuilt');
    expect(msg).toHaveTextContent(/No clear answer came from the server; checking again confirmed it/);
  });
});

describe('recalculate — a background job (owner 2026-11-18)', () => {
  const histRow = (over: Partial<SalesMonthRow> = {}) => row({
    month: '2026-10', hasHistory: true, historySourceImportId: 'i1', historyAppliedAt: '2026-11-02T05:00:00.000Z', ...over,
  });
  const job = (over: Partial<SalesApplyJobDto> = {}, m: Partial<SalesApplyJobDto['months'][number]> = {}): SalesApplyJobDto => ({
    id: 'rj1', kind: 'RECALC', importId: null, requestId: 'rq', status: 'QUEUED', requestedBy: 'Asha', createdAt: new Date().toISOString(),
    startedAt: null, finishedAt: null, error: null, attempts: 0,
    months: [{ month: '2026-10', status: 'QUEUED', startedAt: null, finishedAt: null, result: null, lastError: null, ...m }], ...over,
  });
  const DONE = { status: 'DONE' as const, result: { month: '2026-10', ok: true, applyId: 'a9', outletsWritten: 5, outletsZeroFilled: 2 } };

  async function openAndRecalc() {
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    await screen.findByTestId('recalc-preview');
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
  }

  it('202 job: sends a requestId, shows the job running (Recalculate held), then the result card', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.months.mockResolvedValue(ok([histRow()]));
      apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
      apiMock.recalculate.mockResolvedValue(ok({ job: job(), results: [] }));
      apiMock.getApplyJob.mockResolvedValue(ok(job({ status: 'DONE' }, DONE)));
      await openAndRecalc();
      expect(apiMock.recalculate).toHaveBeenCalledWith('2026-10', expect.objectContaining({ requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) }));
      expect(await screen.findByTestId('recalc-job')).toHaveTextContent('Queued — waiting its turn for the processor');
      expect(screen.getByTestId('recalc-apply')).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(await screen.findByTestId('recalc-result')).toHaveTextContent('October 2026 recalculated: 5 outlets updated, 2 set to 0');
    } finally {
      vi.useRealTimers();
    }
  });

  it('no clear answer → the click is looked up by requestId; found → that job is followed (never a second recalculation)', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    apiMock.recalculate.mockResolvedValue({ success: false, error: '', status: 500 });
    apiMock.findApplyJob.mockResolvedValue(ok(job({ status: 'DONE' }, DONE)));
    await openAndRecalc();
    expect(await screen.findByTestId('recalc-result')).toHaveTextContent('October 2026 recalculated');
    expect(screen.queryByText(/Nothing was changed/)).not.toBeInTheDocument();
    expect(apiMock.recalculate).toHaveBeenCalledTimes(1);
  });

  it('no clear answer, nothing recorded (404) → "Nothing was changed: …" with Try again (same requestId)', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    apiMock.recalculate.mockResolvedValueOnce({ success: false, error: 'Failed to fetch' }).mockResolvedValue(ok({ job: job({ status: 'DONE' }, DONE), results: [] }));
    apiMock.findApplyJob.mockResolvedValue({ success: false, error: 'No apply was recorded for this request.', status: 404 });
    await openAndRecalc();
    const notice = await screen.findByTestId('recalc-notice');
    expect(notice).toHaveTextContent('Nothing was changed: the server could not be reached, and nothing was recorded for this click. Try again.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(apiMock.recalculate.mock.calls[1][1].requestId).toBe(apiMock.recalculate.mock.calls[0][1].requestId);
    expect(await screen.findByTestId('recalc-result')).toHaveTextContent('5 outlets updated');
  });

  it('no clear answer and the lookup fails → unknown: Recalculate disabled, "Don’t recalculate again yet", Check again settles it', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    apiMock.recalculate.mockResolvedValue({ success: false, error: '', status: 504 });
    apiMock.findApplyJob.mockResolvedValueOnce({ success: false, error: '', status: 503 }).mockResolvedValue(ok(job({ status: 'DONE' }, DONE)));
    await openAndRecalc();
    const unknown = await screen.findByTestId('recalc-unknown');
    expect(unknown).toHaveTextContent(/couldn.t confirm whether the recalculation of October 2026 was recorded: the server didn.t reply in time/);
    expect(unknown).toHaveTextContent(/Don.t recalculate again yet/);
    expect(screen.getByTestId('recalc-apply')).toBeDisabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    expect(await screen.findByTestId('recalc-result')).toHaveTextContent('October 2026 recalculated');
    expect(apiMock.recalculate).toHaveBeenCalledTimes(1);
  });

  it('a month with an active job: the Months list says who and since when; the panel follows it with Recalculate held', async () => {
    const active = { jobId: 'job7', kind: 'APPLY' as const, status: 'RUNNING' as const, importId: 'imp3', requestedBy: 'Ravi', createdAt: '2026-11-18T05:02:00.000Z' };
    apiMock.months.mockResolvedValue(ok([histRow({ activeJob: active })]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    apiMock.getApplyJob.mockResolvedValue(ok(job({ id: 'job7', kind: 'APPLY', importId: 'imp3', status: 'RUNNING', requestedBy: 'Ravi', createdAt: '2026-11-18T05:02:00.000Z' }, { status: 'RUNNING', startedAt: '2026-11-18T05:03:00.000Z' })));
    render(<MonthsPage />);
    expect(await screen.findByTestId('active-job-2026-10')).toHaveTextContent('Being applied by Ravi since 10:32');
    fireEvent.click(screen.getByTestId('recalc-open-2026-10'));
    await screen.findByTestId('recalc-preview');
    expect(await screen.findByTestId('recalc-job')).toHaveTextContent('October 2026 is being applied from a sales file');
    expect(screen.getByTestId('recalc-apply')).toBeDisabled();
    expect(screen.getByTestId('recalc-apply')).toHaveAttribute('aria-describedby', 'recalc-apply-why');
  });

  it('Close while a job runs → the server’s 409 is shown as is ("… is being applied by X since 10:32 — try again when it finishes.")', async () => {
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-10' })]));
    apiMock.closeMonth.mockResolvedValue({ success: false, error: 'October 2026 is being applied by Ravi since 10:32 — try again when it finishes.', status: 409 });
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Close October 2026' });
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByRole('alert')).toHaveTextContent('October 2026 was not closed: October 2026 is being applied by Ravi since 10:32 — try again when it finishes.');
  });
});

describe('months — dual-audit fixes (background jobs)', () => {
  const active = { jobId: 'job7', kind: 'APPLY' as const, status: 'RUNNING' as const, importId: 'imp3', requestedBy: 'Ravi', createdAt: new Date().toISOString() };
  const histRow = (over: Partial<SalesMonthRow> = {}) => row({
    month: '2026-10', hasHistory: true, historySourceImportId: 'i1', historyAppliedAt: '2026-11-02T05:00:00.000Z', ...over,
  });

  it('B-M7: Close is disabled while an Apply of the month runs, with the reason', async () => {
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-10', activeJob: active })]));
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Close October 2026' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-describedby', 'job-hold-2026-10');
    expect(screen.getByTestId('job-hold-2026-10')).toHaveTextContent('Close waits until the apply finishes');
  });

  it('B-M7: Reopen (GIFSY_ADMIN) is disabled while a Recalculate of the month runs', async () => {
    roleRef.current = 'GIFSY_ADMIN';
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-09', state: 'CLOSED', canClose: false, canReopen: true, activeJob: { ...active, kind: 'RECALC' } })]));
    render(<MonthsPage />);
    expect(await screen.findByRole('button', { name: 'Reopen September 2026' })).toBeDisabled();
    expect(screen.getByTestId('job-hold-2026-09')).toHaveTextContent('Reopen waits until the recalculation finishes');
  });

  it('B-H1: each month shows its last finished apply / recalculation (who, when, failure reason)', async () => {
    apiMock.months.mockResolvedValue(ok([row({ month: '2026-10', lastJob: { jobId: 'j0', kind: 'RECALC', status: 'FAILED', importId: null,
      requestedBy: 'Asha', createdAt: '2026-11-17T05:00:00.000Z', finishedAt: '2026-11-17T05:02:00.000Z',
      result: { month: '2026-10', ok: false, error: 'A newer file was applied to this month since the preview.' } } })]));
    render(<MonthsPage />);
    expect(await screen.findByTestId('last-job-2026-10')).toHaveTextContent(
      'Last recalculation by Asha, 17 Nov, 10:32: not done — A newer file was applied to this month since the preview.');
  });

  it('B-M4: a failed re-read while a job runs keeps polling and says the list is stale ("Updates paused — retrying")', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.months
        .mockResolvedValueOnce(ok([row({ month: '2026-10', activeJob: active })]))
        .mockResolvedValueOnce({ success: false, error: '', status: 502 })
        .mockResolvedValue(ok([row({ month: '2026-10' })]));
      render(<MonthsPage />);
      await screen.findByTestId('active-job-2026-10');
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(await screen.findByTestId('months-stale')).toHaveTextContent(/Updates paused — couldn.t refresh the months \(the server didn.t give a clear answer \(error 502\)\)\. The list below may be out of date; retrying/);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      await waitFor(() => expect(screen.queryByTestId('active-job-2026-10')).not.toBeInTheDocument());
      expect(screen.queryByTestId('months-stale')).not.toBeInTheDocument();
      expect(apiMock.months).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('B-M1: a Close whose success reply carries no row re-reads the list (never puts "undefined" in the table)', async () => {
    apiMock.months
      .mockResolvedValueOnce(ok([row({ month: '2026-10' })]))
      .mockResolvedValue(ok([row({ month: '2026-10', state: 'CLOSED', canClose: false, canReopen: true })]));
    apiMock.closeMonth.mockResolvedValue({ success: true, data: undefined });
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Close October 2026' });
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByRole('status')).toHaveTextContent('October 2026 is closed');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close October 2026' })).not.toBeInTheDocument());
    expect(apiMock.months).toHaveBeenCalledTimes(2);
  });

  it('B-L7: a list read that started BEFORE a Close is not allowed to put the old row back', async () => {
    let releaseStale: (v: unknown) => void = () => {};
    apiMock.months
      .mockResolvedValueOnce(ok([row({ month: '2026-10' })]))
      .mockImplementationOnce(() => new Promise((res) => { releaseStale = res; }))
      .mockResolvedValue(ok([row({ month: '2026-10', state: 'CLOSED', canClose: false, canReopen: true })]));
    apiMock.closeMonth.mockResolvedValue(ok(row({ month: '2026-10', state: 'CLOSED', canClose: false, canReopen: true })));
    render(<MonthsPage />);
    const btn = await screen.findByRole('button', { name: 'Close October 2026' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh months' })); }); // a read starts…
    await act(async () => { fireEvent.click(btn); }); // …the Close lands first
    await act(async () => { releaseStale(ok([row({ month: '2026-10' })])); }); // the stale read (still OPEN) arrives
    await waitFor(() => expect(apiMock.months).toHaveBeenCalledTimes(3)); // ignored and read again
    expect(screen.queryByRole('button', { name: 'Close October 2026' })).not.toBeInTheDocument();
  });

  it('B-L12: Recalculate refused with 401 says the session expired', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    apiMock.recalculate.mockResolvedValue({ success: false, error: 'Unauthorized', status: 401 });
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    await screen.findByTestId('recalc-preview');
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    expect(await screen.findByTestId('recalc-notice')).toHaveTextContent('Nothing was changed: your session has expired. Sign in again, then recalculate.');
  });

  it('B-M6: the recalculation result is announced in the always-present live region', async () => {
    apiMock.months.mockResolvedValue(ok([histRow()]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    apiMock.recalculate.mockResolvedValue(ok({ job: { id: 'r1', kind: 'RECALC', importId: null, requestId: 'rq', status: 'DONE', requestedBy: 'Asha',
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, attempts: 1,
      months: [{ month: '2026-10', status: 'DONE', startedAt: null, finishedAt: null, lastError: null, result: { month: '2026-10', ok: true, outletsWritten: 5, outletsZeroFilled: 2 } }] }, results: [] }));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-10'));
    expect(screen.getByTestId('recalc-live')).toBeInTheDocument();
    await screen.findByTestId('recalc-preview');
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    await screen.findByTestId('recalc-result');
    expect(screen.getByTestId('recalc-live')).toHaveTextContent('October 2026: recalculated');
  });
});
