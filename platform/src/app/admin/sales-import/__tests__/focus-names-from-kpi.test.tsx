/// <reference types="vitest/globals" />
/**
 * FOCUS-NAMES-FROM-KPI (owner-approved 2026-11-25): the KPI editor's "Focus names" choice — a cases KPI can use the
 * per-outlet focus names of another "from the target file" KPI. API mocked.
 * Run: npx vitest run src/app/admin/sales-import/__tests__/focus-names-from-kpi.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SalesKpiDefinitionDto } from '@/lib/sales-import/types';

const apiMock = vi.hoisted(() => ({ createKpi: vi.fn(), patchKpi: vi.fn(), testKpi: vi.fn() }));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock, fetchDownload: vi.fn() }));

import { KpiEditor } from '../settings/_components/kpi-editor';

const ok = <T,>(data: T) => ({ success: true as const, data });
const MAPPING = {
  sheetName: null, headerRow: 'auto' as const, outletCode: 'CUST', outletName: null, invoiceDate: 'DATE', amount: 'AMT',
  quantity: 'QTY', dateOrder: 'DMY' as const,
  dimensions: [{ key: 'brand', label: 'Brand', header: 'BRAND' }, { key: 'skuGroup', label: 'SKU group', header: 'SKU' }],
};
const KPIS = [
  { code: 'FOCUS BRAND', label: 'Focus Brand 1', unit: '₹', enabled: true, hasNameOverride: true, nameOverrideLabel: 'FOCUS BRAND NAME' },
  { code: 'FB1 CASES', label: 'Focus Brand 1 Cases', unit: 'cases', enabled: true, hasNameOverride: false, nameOverrideLabel: null },
];
const SOURCES = [{ kpiCode: 'FOCUS BRAND', label: 'Focus Brand 1' }];
const NEW: SalesKpiDefinitionDto = { kpiCode: '', measure: 'QUANTITY', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 };

function renderEditor(initial: SalesKpiDefinitionDto = NEW, sources = SOURCES) {
  const onSaved = vi.fn();
  const onDuplicateAsCases = vi.fn();
  render(<KpiEditor initial={initial} tenantKpis={KPIS} ownedCodes={[]} mapping={MAPPING} combos={null}
    focusNameSources={sources} onSaved={onSaved} onCancel={vi.fn()} onDuplicateAsCases={onDuplicateAsCases} />);
  return { onSaved, onDuplicateAsCases };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe('KPI editor — focus names from another KPI', () => {
  it('a cases KPI without its own name column can use FOCUS BRAND\'s names and saves focusNamesFromKpi', async () => {
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k9' }));
    const { onSaved } = renderEditor();
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'FB1 CASES' } });
    fireEvent.click(screen.getByRole('radio', { name: 'From the target file, per outlet' }));
    // own name column missing → blocked until a source is picked
    expect(screen.getByRole('button', { name: 'Save KPI' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Focus names' }), { target: { value: 'FOCUS BRAND' } });
    expect(screen.queryByTestId('product-source-no-name-column')).not.toBeInTheDocument();
    expect(screen.getByTestId('focus-names-from-note')).toHaveTextContent('the same products as FOCUS BRAND, counted in cases');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi).toHaveBeenCalledWith(expect.objectContaining({
      kpiCode: 'FB1 CASES', measure: 'QUANTITY', productSource: 'TARGET_NAMES', filter: {}, focusNamesFromKpi: 'FOCUS BRAND',
    }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('the KPI itself is never offered as its own source', () => {
    renderEditor({ ...NEW, id: 'k1', kpiCode: 'FOCUS BRAND', measure: 'AMOUNT', productSource: 'TARGET_NAMES' }, SOURCES);
    expect(screen.queryByRole('combobox', { name: 'Focus names' })).not.toBeInTheDocument();
  });

  it('a saved source that is no longer available blocks Save with a clear reason', () => {
    renderEditor({ ...NEW, id: 'k2', kpiCode: 'FB1 CASES', productSource: 'TARGET_NAMES', focusNamesFromKpi: 'FOCUS BRAND' }, []);
    expect(screen.getByTestId('kpi-editor-blockers')).toHaveTextContent("FOCUS BRAND is not a 'from the target file' KPI with its own names.");
    expect(screen.getByRole('button', { name: 'Save KPI' })).toBeDisabled();
  });

  it('clearing a saved source sends null; an untouched definition without one sends no key', async () => {
    apiMock.patchKpi.mockImplementation(async (_id: string, d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k2' }));
    renderEditor({ ...NEW, id: 'k2', kpiCode: 'FB1 CASES', productSource: 'TARGET_NAMES', focusNamesFromKpi: 'FOCUS BRAND', measure: 'QUANTITY' });
    fireEvent.click(screen.getByRole('radio', { name: 'Pick products here' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /This KPI counts ALL products/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.patchKpi).toHaveBeenCalledWith('k2', expect.objectContaining({ productSource: 'FILTER', focusNamesFromKpi: null }));
    cleanup();
    apiMock.patchKpi.mockClear();
    renderEditor({ ...NEW, id: 'k1', kpiCode: 'FOCUS BRAND', measure: 'AMOUNT', productSource: 'TARGET_NAMES' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.patchKpi.mock.calls[0][1]).not.toHaveProperty('focusNamesFromKpi');
  });

  it('"Duplicate as cases KPI" of a from-the-target-file ₹ KPI starts a cases KPI using ITS focus names', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onDuplicateAsCases } = renderEditor({ ...NEW, id: 'k1', kpiCode: 'FOCUS BRAND', measure: 'AMOUNT', productSource: 'TARGET_NAMES' });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate as cases KPI' }));
    expect(onDuplicateAsCases).toHaveBeenCalledWith(expect.objectContaining({
      kpiCode: '', measure: 'QUANTITY', productSource: 'TARGET_NAMES', focusNamesFromKpi: 'FOCUS BRAND', filter: {},
    }));
    confirm.mockRestore();
  });
});
