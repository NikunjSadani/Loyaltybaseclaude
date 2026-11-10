/// <reference types="vitest/globals" />
/**
 * Product set builder — "Stored month(s)" source (SALES-IMPORT-PIPELINE-PLAN §10c): the picker can list product
 * combinations from the stored month history instead of the latest file.
 * Run: npx vitest run src/app/admin/sales-import/__tests__/product-set-history.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  SalesColumnMapping, SalesHistoryCombos, SalesImportCombos, SalesKpiDefinitionDto,
} from '@/lib/sales-import/types';

const apiMock = vi.hoisted(() => ({ testKpi: vi.fn(), createKpi: vi.fn(), patchKpi: vi.fn(), historyCombos: vi.fn() }));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock }));

import { KpiEditor } from '../settings/_components/kpi-editor';
import { HISTORY_REFRESH_POLL_MS, HISTORY_SELECT_DEBOUNCE_MS } from '../settings/_components/product-set-builder';

const MAPPING: SalesColumnMapping = {
  sheetName: null, headerRow: 'auto', outletCode: 'CUST', outletName: null, invoiceDate: 'DATE', amount: 'AMT',
  quantity: 'QTY', dateOrder: 'DMY',
  dimensions: [{ key: 'dimA', label: 'Brand', header: 'A' }, { key: 'dimB', label: 'SKU group', header: 'B' }],
};
const LATEST: SalesImportCombos = {
  importId: 'imp1',
  dimensionValues: { dimA: [{ value: 'P', lines: 4, amountRupees: 100 }] },
  dimensionCombos: [{ dims: { dimA: 'P', dimB: '500' }, lines: 4, amountRupees: 100, quantity: 1 }],
};
const HISTORY: SalesHistoryCombos = {
  months: ['2026-10'],
  availableMonths: ['2026-10', '2026-09', '2026-08'],
  dimensionKeys: ['dimA', 'dimB'],
  dimensionKeysDiffer: false,
  dimensionValues: { dimA: [{ value: 'R', lines: 7, amountRupees: 900 }] },
  dimensionCombos: [
    { dims: { dimA: 'R', dimB: '1L' }, lines: 7, amountRupees: 900, quantity: 3 },
    { dims: { dimA: 'S', dimB: '' }, lines: 2, amountRupees: 15, quantity: 0.5 },
  ],
  totalCombos: 2,
  refreshingMonths: [],
};
const NEW: SalesKpiDefinitionDto = { kpiCode: 'KPI_X', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 };
const KPIS = [{ code: 'KPI_X', label: 'KPI X', unit: '₹', enabled: true }];
const ok = <T,>(data: T) => ({ success: true as const, data });

function renderEditor(over: Partial<React.ComponentProps<typeof KpiEditor>> = {}) {
  const props = {
    initial: NEW, tenantKpis: KPIS, ownedCodes: [], mapping: MAPPING, combos: LATEST,
    onSaved: vi.fn(), onCancel: vi.fn(), onDuplicateAsCases: vi.fn(), ...over,
  };
  render(<KpiEditor {...props} />);
  return props;
}

async function useStored() {
  await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Stored month(s)' })); });
}

beforeEach(() => Object.values(apiMock).forEach((f) => f.mockReset()));
afterEach(() => vi.restoreAllMocks());

describe('product set builder — stored month history source', () => {
  it('defaults to the latest file and does not call the history route until asked', () => {
    renderEditor();
    const group = screen.getByRole('radiogroup', { name: 'Pick products from' });
    expect(within(group).getByRole('radio', { name: 'Latest file' })).toBeChecked();
    expect(screen.getByText('Pick combinations from the latest file')).toBeInTheDocument();
    expect(apiMock.historyCombos).not.toHaveBeenCalled();
  });

  it('Stored month(s) → the most recent stored month; picks pin the stored keys and save', async () => {
    apiMock.historyCombos.mockResolvedValue(ok(HISTORY));
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok(d));
    renderEditor();
    await useStored();
    expect(apiMock.historyCombos).toHaveBeenCalledWith({ lastMonths: 1 }, expect.any(AbortSignal));
    expect(screen.getByText('Pick combinations from October 2026')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Pick P 500' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick R 1L' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick S (blank sku group)' }));
    expect(screen.getByRole('button', { name: 'Add all of R' })).toBeInTheDocument(); // whole-value chips from history
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi.mock.calls[0][0].filter).toEqual({ anyOf: [{ dimA: 'R', dimB: '1L' }, { dimA: 'S', dimB: '' }] });
  });

  it('choose "last N stored months" or one month from the picker', async () => {
    apiMock.historyCombos.mockResolvedValue(ok(HISTORY));
    renderEditor();
    await useStored();
    const sel = screen.getByRole('combobox', { name: 'Stored months to pick from' });
    const opts = within(sel).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual([
      'Most recent stored month', 'Last 3 stored months', 'Last 6 stored months', 'Last 12 stored months',
      'October 2026', 'September 2026', 'August 2026',
    ]);
    apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, months: ['2026-08', '2026-09', '2026-10'] }));
    await act(async () => { fireEvent.change(sel, { target: { value: 'last:3' } }); });
    expect(await screen.findByText('Pick combinations from August 2026 – October 2026 (3 stored months)')).toBeInTheDocument();
    expect(apiMock.historyCombos).toHaveBeenLastCalledWith({ lastMonths: 3 }, expect.any(AbortSignal));
    apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, months: ['2026-09'] }));
    await act(async () => { fireEvent.change(sel, { target: { value: 'month:2026-09' } }); });
    expect(await screen.findByText('Pick combinations from September 2026')).toBeInTheDocument();
    expect(apiMock.historyCombos).toHaveBeenLastCalledWith({ month: '2026-09' }, expect.any(AbortSignal));
  });

  it('audit M1: quick select changes are debounced into ONE request, and a superseded request is aborted', async () => {
    apiMock.historyCombos.mockResolvedValue(ok(HISTORY));
    renderEditor();
    await useStored();
    expect(apiMock.historyCombos).toHaveBeenCalledTimes(1);
    // the next request hangs until we resolve it, so it is still in flight when the choice changes again
    let resolveSlow: (v: unknown) => void = () => undefined;
    apiMock.historyCombos.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }));
    const sel = screen.getByRole('combobox', { name: 'Stored months to pick from' });
    act(() => {
      fireEvent.change(sel, { target: { value: 'last:3' } });
      fireEvent.change(sel, { target: { value: 'last:6' } });
    });
    await waitFor(() => expect(apiMock.historyCombos).toHaveBeenCalledTimes(2)); // last:3 never sent
    expect(apiMock.historyCombos).toHaveBeenLastCalledWith({ lastMonths: 6 }, expect.any(AbortSignal));
    const slowSignal = apiMock.historyCombos.mock.calls[1][1] as AbortSignal;
    apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, months: ['2026-09'] }));
    act(() => { fireEvent.change(sel, { target: { value: 'month:2026-09' } }); });
    expect(slowSignal.aborted).toBe(true); // superseded → aborted at once
    await act(async () => { resolveSlow(ok({ ...HISTORY, months: ['2026-01'] })); }); // its late answer is ignored
    expect(await screen.findByText('Pick combinations from September 2026')).toBeInTheDocument();
    expect(screen.queryByText('Pick combinations from January 2026')).not.toBeInTheDocument();
    expect(apiMock.historyCombos).toHaveBeenCalledTimes(3);
  });

  it('warns when the stored lines were read with different product columns', async () => {
    apiMock.historyCombos.mockResolvedValue(ok({
      ...HISTORY, dimensionKeys: ['dimA'], dimensionKeysDiffer: true,
      dimensionCombos: [{ dims: { dimA: 'R' }, lines: 1, amountRupees: 1, quantity: 1 }],
    }));
    renderEditor();
    await useStored();
    const w = screen.getByTestId('product-set-mapping-drift');
    expect(w).toHaveTextContent('stored lines of October 2026 were read with a different column mapping');
    expect(w).toHaveTextContent('no SKU group column');
    expect(w).toHaveTextContent('different product columns in different months');
  });

  it('a stored set without declared keys falls back to the combos\' own keys for the drift warning', async () => {
    apiMock.historyCombos.mockResolvedValue(ok({
      ...HISTORY, dimensionKeys: [], dimensionCombos: [{ dims: { dimA: 'R' }, lines: 1, amountRupees: 1, quantity: 1 }],
    }));
    renderEditor();
    await useStored();
    expect(screen.getByTestId('product-set-mapping-drift')).toHaveTextContent('no SKU group column');
  });

  it('months whose product summary is being refreshed get an honest notice', async () => {
    apiMock.historyCombos.mockResolvedValue(ok(HISTORY));
    renderEditor();
    await useStored();
    expect(screen.queryByTestId('product-set-refreshing')).not.toBeInTheDocument();
    apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, months: ['2026-08', '2026-09', '2026-10'], refreshingMonths: ['2026-09'] }));
    const sel = screen.getByRole('combobox', { name: 'Stored months to pick from' });
    await act(async () => { fireEvent.change(sel, { target: { value: 'last:3' } }); });
    const note = await screen.findByTestId('product-set-refreshing');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveTextContent('The product list for September 2026 is being refreshed in the background — reload in a few minutes.');
    // Reload fetches the same selection again; the list stays on screen meanwhile, and the notice goes once it is current
    apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, months: ['2026-08', '2026-09', '2026-10'], refreshingMonths: [] }));
    await act(async () => { fireEvent.click(within(note).getByRole('button', { name: 'Reload' })); });
    expect(apiMock.historyCombos).toHaveBeenLastCalledWith({ lastMonths: 3 }, expect.any(AbortSignal));
    await waitFor(() => expect(screen.queryByTestId('product-set-refreshing')).not.toBeInTheDocument());
    expect(screen.getByText('Pick combinations from August 2026 – October 2026 (3 stored months)')).toBeInTheDocument();
  });

  it('L3: while a month is refreshing the list is polled every ~60 s (quietly), and polling stops once it is current', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, refreshingMonths: ['2026-10'] }));
      renderEditor();
      await useStored();
      await screen.findByTestId('product-set-refreshing');
      expect(apiMock.historyCombos).toHaveBeenCalledTimes(1);
      // a failing poll keeps the list (no error box)
      apiMock.historyCombos.mockResolvedValueOnce({ success: false, error: 'boom', status: 500 });
      await act(async () => { vi.advanceTimersByTime(HISTORY_REFRESH_POLL_MS); });
      await waitFor(() => expect(apiMock.historyCombos).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('Pick combinations from October 2026')).toBeInTheDocument();
      await waitFor(() => expect(within(screen.getByTestId('product-set-refreshing')).getByRole('button', { name: 'Reload' })).toBeEnabled());
      // the next poll gets a current list → notice gone, no further polls
      apiMock.historyCombos.mockResolvedValue(ok(HISTORY));
      await act(async () => { vi.advanceTimersByTime(HISTORY_REFRESH_POLL_MS); });
      await waitFor(() => expect(screen.queryByTestId('product-set-refreshing')).not.toBeInTheDocument());
      const calls = apiMock.historyCombos.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(HISTORY_REFRESH_POLL_MS * 3); });
      expect(apiMock.historyCombos).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('L3: the quiet poll is armed for ITS selection only — a different selection\'s failing first load shows the error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, refreshingMonths: ['2026-10'] }));
      renderEditor();
      await useStored();
      await screen.findByTestId('product-set-refreshing');
      // The poll for "most recent" fires (arming a quiet reload) in the SAME batch as the user switching to another
      // selection: the effect then runs once, for the new selection — its first load must NOT be quiet.
      apiMock.historyCombos.mockResolvedValue({ success: false, error: 'boom', status: 500 });
      const sel = screen.getByRole('combobox', { name: 'Stored months to pick from' });
      act(() => {
        vi.advanceTimersByTime(HISTORY_REFRESH_POLL_MS);
        fireEvent.change(sel, { target: { value: 'last:3' } });
      });
      await act(async () => { vi.advanceTimersByTime(HISTORY_SELECT_DEBOUNCE_MS + 10); });
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the stored months: boom");
      expect(apiMock.historyCombos).toHaveBeenLastCalledWith({ lastMonths: 3 }, expect.any(AbortSignal));
    } finally {
      vi.useRealTimers();
    }
  });

  it('L3: polling stops on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, refreshingMonths: ['2026-10'] }));
      const { unmount } = render(<KpiEditor initial={NEW} tenantKpis={KPIS} ownedCodes={[]} mapping={MAPPING} combos={LATEST}
        onSaved={vi.fn()} onCancel={vi.fn()} onDuplicateAsCases={vi.fn()} />);
      await useStored();
      await screen.findByTestId('product-set-refreshing');
      unmount();
      await act(async () => { vi.advanceTimersByTime(HISTORY_REFRESH_POLL_MS * 2); });
      expect(apiMock.historyCombos).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the live "never appears" check follows the selected source', async () => {
    apiMock.historyCombos.mockResolvedValue(ok(HISTORY));
    renderEditor({ initial: { ...NEW, filter: { anyOf: [{ dimA: 'P' }] } } });
    expect(screen.queryByTestId('product-set-chip-warning')).not.toBeInTheDocument(); // P is in the latest file
    await useStored();
    expect(screen.getByTestId('product-set-chip-warning')).toHaveTextContent('P (all sku groups) never appears in October 2026');
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Latest file' })); });
    expect(screen.queryByTestId('product-set-chip-warning')).not.toBeInTheDocument();
  });

  it('a capped history list switches the live check off and says so', async () => {
    apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, totalCombos: 5000 }));
    renderEditor({ initial: { ...NEW, filter: { anyOf: [{ dimA: 'ZZ' }] } } });
    await useStored();
    expect(screen.queryByTestId('product-set-chip-warning')).not.toBeInTheDocument();
    expect(screen.getByTestId('product-set-capped-note')).toHaveTextContent(
      'October 2026 has 5,000 product combinations; only the 2 largest by ₹ are listed',
    );
  });

  it('no stored history yet → honest message; a failed load → alert with Retry', async () => {
    apiMock.historyCombos.mockResolvedValue(ok({ ...HISTORY, months: [], availableMonths: [], dimensionKeys: [], dimensionCombos: [], dimensionValues: {}, totalCombos: 0 }));
    renderEditor();
    await useStored();
    expect(screen.getByText(/No month has stored sales lines yet/)).toBeInTheDocument();

    apiMock.historyCombos.mockReset();
    apiMock.historyCombos.mockResolvedValueOnce({ success: false, error: 'boom', status: 500 }).mockResolvedValueOnce(ok(HISTORY));
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Latest file' })); });
    await useStored();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the stored months: boom");
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByText('Pick combinations from October 2026')).toBeInTheDocument();
  });

  it('read-only viewers cannot switch the source (the editor fieldset is disabled)', () => {
    renderEditor({ canEdit: false, initial: { ...NEW, id: 'k1' } });
    expect(screen.getByRole('radio', { name: 'Stored month(s)' })).toBeDisabled();
  });
});
