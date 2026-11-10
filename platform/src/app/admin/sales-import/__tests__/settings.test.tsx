/// <reference types="vitest/globals" />
/**
 * Settings: KPI editor + Product set builder (§6.2a, §11 F-6) and the column-mapping form.
 * Run: npx vitest run src/app/admin/sales-import/__tests__/settings.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  SalesColumnMapping, SalesImportCombos, SalesKpiDefinitionDto,
} from '@/lib/sales-import/types';

const apiMock = vi.hoisted(() => ({
  testKpi: vi.fn(), createKpi: vi.fn(), patchKpi: vi.fn(), saveProfile: vi.fn(),
  getProfile: vi.fn(), list: vi.fn(), get: vi.fn(), listKpis: vi.fn(), combos: vi.fn(), disableKpi: vi.fn(), segmentOptions: vi.fn(),
}));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock }));
const clientApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', async (orig) => {
  const actual = await orig<typeof import('@/lib/api-client')>();
  return { ...actual, api: { ...actual.api, get: clientApi.get } };
});

import { KpiEditor } from '../settings/_components/kpi-editor';
import { ColumnMappingForm, validateMapping, suggestDimKey } from '../settings/_components/column-mapping-form';
import SettingsPage from '../settings/page';

const MAPPING: SalesColumnMapping = {
  sheetName: null, headerRow: 'auto', outletCode: 'CUST', outletName: null, invoiceDate: 'DATE', amount: 'AMT',
  quantity: 'QTY', dateOrder: 'DMY',
  dimensions: [{ key: 'dimA', label: 'Brand', header: 'A' }, { key: 'dimB', label: 'SKU group', header: 'B' }],
};
const COMBOS: SalesImportCombos = {
  importId: 'imp1',
  dimensionValues: { dimA: [{ value: 'P', lines: 10, amountRupees: 300 }, { value: 'Q', lines: 5, amountRupees: 70 }] },
  dimensionCombos: [
    { dims: { dimA: 'P', dimB: '500' }, lines: 4, amountRupees: 100, quantity: 1 },
    { dims: { dimA: 'P', dimB: '200' }, lines: 3, amountRupees: 40, quantity: 0.5 },
    { dims: { dimA: 'P', dimB: '150' }, lines: 2, amountRupees: 25, quantity: 0.25 },
    { dims: { dimA: 'Q', dimB: '500' }, lines: 5, amountRupees: 70, quantity: 0.7 },
  ],
};
const KPIS = [
  { code: 'KPI_X', label: 'KPI X', unit: '₹', enabled: true },
  { code: 'KPI_Y', label: 'KPI Y', unit: 'cases', enabled: true },
  { code: 'KPI_Z', label: 'KPI Z', unit: '₹', enabled: false },
];
const NEW: SalesKpiDefinitionDto = { kpiCode: '', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 };
const ok = <T,>(data: T) => ({ success: true as const, data });

function renderEditor(over: Partial<React.ComponentProps<typeof KpiEditor>> = {}) {
  const props = {
    initial: NEW, tenantKpis: KPIS, ownedCodes: [], mapping: MAPPING, combos: COMBOS,
    onSaved: vi.fn(), onCancel: vi.fn(), onDuplicateAsCases: vi.fn(), ...over,
  };
  render(<KpiEditor {...props} />);
  return props;
}

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset());
  clientApi.get.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('KPI editor — product set', () => {
  it('picking 3 combos produces the expected anyOf on save', async () => {
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k1' }));
    const p = renderEditor();
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'KPI_X' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick P 500' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick P 200' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pick P 150' }));
    expect(within(screen.getByTestId('product-set-chips')).getAllByTestId('product-set-chip')).toHaveLength(3);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi).toHaveBeenCalledWith(expect.objectContaining({
      kpiCode: 'KPI_X', measure: 'AMOUNT',
      filter: { anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'P', dimB: '200' }, { dimA: 'P', dimB: '150' }] },
    }));
    expect(p.onSaved).toHaveBeenCalled();
  });

  it('un-ticking a combo removes it', () => {
    renderEditor();
    const box = screen.getByRole('checkbox', { name: 'Pick P 500' });
    fireEvent.click(box);
    fireEvent.click(box);
    expect(screen.queryAllByTestId('product-set-chip')).toHaveLength(0);
  });

  it('"Select all" after a search adds every matching combo', () => {
    renderEditor();
    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: /Select all "q" \(1\)/ }));
    expect(screen.getByTestId('product-set-chips')).toHaveTextContent('Q 500');
  });

  it('a whole-brand chip adds {dimA:X} shown as "(all sku groups)"', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add all of P' }));
    expect(screen.getByTestId('product-set-chips')).toHaveTextContent('P (all sku groups)');
  });

  it('free entry normalizes values; Exclude tab adds to noneOf', async () => {
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok(d));
    renderEditor();
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'KPI_X' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Free entry Brand' }), { target: { value: '  new  brand ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Include' }));
    fireEvent.click(screen.getByRole('tab', { name: /Exclude/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Free entry Brand' }), { target: { value: 'p' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Free entry SKU group' }), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Exclude' }));
    expect(screen.getByTestId('product-set-chips')).toHaveTextContent('except P 50');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi.mock.calls[0][0].filter).toEqual({ anyOf: [{ dimA: 'NEW BRAND' }], noneOf: [{ dimA: 'P', dimB: '50' }] });
  });

  it('free entry with nothing typed is refused', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Include' }));
    expect(screen.getByText('Type at least one value.')).toBeInTheDocument();
  });

  it('Test shows monthly totals and warns on the right chip (never appears / already included)', async () => {
    apiMock.testKpi.mockResolvedValue(ok({
      months: [{ month: '2026-10', totalAmountRupees: 165, totalQuantity: 1.75, outletsNonZero: 3 }],
      unmatchedEntries: { anyOf: [2], noneOf: [] }, redundantEntries: { anyOf: [0] }, matchedLines: 9,
    }));
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X', filter: { anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'P' }, { dimA: 'P', dimB: '999' }] } } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Test against latest import/ })); });
    expect(apiMock.testKpi).toHaveBeenCalledWith(expect.objectContaining({ importId: 'latest' }));
    expect(screen.getByTestId('kpi-test-result')).toHaveTextContent('₹165');
    const chips = screen.getAllByTestId('product-set-chip');
    expect(chips[0]).toHaveTextContent('P 500 is already included by P (all sku groups)');
    expect(chips[1]).not.toHaveTextContent(/never appears|already included/);
    expect(chips[2]).toHaveTextContent('P 999 never appears in the latest file');
  });

  it('warnings disappear once the set changes (stale test)', async () => {
    apiMock.testKpi.mockResolvedValue(ok({ months: [], unmatchedEntries: { anyOf: [0], noneOf: [] }, redundantEntries: { anyOf: [] }, matchedLines: 0 }));
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X', filter: { anyOf: [{ dimA: 'ZZ' }] } } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Test against latest import/ })); });
    expect(screen.getByTestId('product-set-chip-warning')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add all of Q' }));
    expect(screen.queryByTestId('product-set-chip-warning')).not.toBeInTheDocument();
    expect(screen.getByText(/test again/)).toBeInTheDocument();
  });

  it('save is blocked on an empty entry', () => {
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X', filter: { anyOf: [{}] } } });
    expect(screen.getByTestId('kpi-editor-blockers')).toHaveTextContent('entry 1 is empty');
    expect(screen.getByRole('button', { name: 'Save KPI' })).toBeDisabled();
  });

  it('KPI choices exclude disabled KPIs and codes already owned by another definition', () => {
    renderEditor({ ownedCodes: ['KPI_Y'] });
    const opts = within(screen.getByRole('combobox', { name: 'KPI' })).getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(opts).toEqual(['', 'KPI_X']);
  });

  it('states the ownership consequence', () => {
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X' } });
    expect(screen.getByText(/will no longer be accepted from the manual achievement/)).toBeInTheDocument();
  });

  it('no processed file → explains instead of an empty picker', () => {
    renderEditor({ combos: null });
    expect(screen.getByText(/No processed file yet/)).toBeInTheDocument();
  });

  it('Duplicate as cases KPI copies the product set with QUANTITY', () => {
    const p = renderEditor({ initial: { ...NEW, id: 'k1', kpiCode: 'KPI_X', filter: { anyOf: [{ dimA: 'P' }] } } });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate as cases KPI' }));
    expect(p.onDuplicateAsCases).toHaveBeenCalledWith(expect.objectContaining({ kpiCode: '', measure: 'QUANTITY', filter: { anyOf: [{ dimA: 'P' }] } }));
  });
});

describe('KPI editor — outlet scope', () => {
  const SEG = {
    outletTypes: [{ code: 'RETAILER', name: 'Retailer' }, { code: 'WHOLESALER', name: 'Wholesaler' }],
    programs: ['Gold', 'Silver'],
  };

  it('outlet types and programmes are multi-selects fed by segment-options; save sends the picked codes', async () => {
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok(d));
    renderEditor({ segments: SEG });
    expect(screen.queryByRole('textbox', { name: /Only these outlet types/ })).not.toBeInTheDocument();
    const types = screen.getByRole('group', { name: /Only these outlet types/ });
    const progs = screen.getByRole('group', { name: /Only these programmes/ });
    expect(within(types).getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'KPI_X' } });
    fireEvent.click(within(types).getByRole('checkbox', { name: 'Wholesaler (WHOLESALER)' }));
    fireEvent.click(within(progs).getByRole('checkbox', { name: 'Gold' }));
    fireEvent.click(within(progs).getByRole('checkbox', { name: 'Silver' }));
    fireEvent.click(within(progs).getByRole('checkbox', { name: 'Silver' })); // untick
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi).toHaveBeenCalledWith(expect.objectContaining({ outletTypes: ['WHOLESALER'], programs: ['Gold'] }));
  });

  it('saved values match case-insensitively; a value no longer offered stays ticked and removable', () => {
    renderEditor({ segments: SEG, initial: { ...NEW, kpiCode: 'KPI_X', outletTypes: ['retailer', 'OLD_TYPE'] } });
    const types = screen.getByRole('group', { name: /Only these outlet types/ });
    expect(within(types).getByRole('checkbox', { name: 'Retailer (RETAILER)' })).toBeChecked();
    const stale = within(types).getByRole('checkbox', { name: /OLD_TYPE \(no outlets now\)/ });
    expect(stale).toBeChecked();
    fireEvent.click(stale);
    expect(within(types).queryByRole('checkbox', { name: /OLD_TYPE/ })).not.toBeInTheDocument();
  });

  it('falls back to free text when the list is empty or unavailable', () => {
    renderEditor({ segments: { outletTypes: [], programs: ['Gold'] } });
    expect(screen.getByRole('textbox', { name: /Only these outlet types/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Only these programmes/ })).toBeInTheDocument();
  });

  it('no segments prop → both free text', () => {
    renderEditor();
    expect(screen.getByRole('textbox', { name: /Only these outlet types/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Only these programmes/ })).toBeInTheDocument();
  });
});

describe('column mapping', () => {
  it('validateMapping: required fields, ≥1 measure, key shape, duplicate headings', () => {
    const base = { ...MAPPING };
    expect(validateMapping(base)).toEqual([]);
    expect(validateMapping({ ...base, amount: null, quantity: '' })[0]).toMatch(/amount column, a quantity column/);
    expect(validateMapping({ ...base, dimensions: [{ key: 'Bad Key', label: 'x', header: 'H' }] })[0]).toMatch(/key must start/);
    expect(validateMapping({ ...base, amount: ' cust ' })[0]).toMatch(/"CUST" is used for two/);
  });

  it('suggestDimKey', () => {
    expect(suggestDimKey('SKU group')).toBe('skuGroup');
    expect(suggestDimKey('Brand')).toBe('brand');
    expect(suggestDimKey('!!')).toBe('');
  });

  it('saves the trimmed mapping; detected headings are offered as suggestions', async () => {
    apiMock.saveProfile.mockImplementation(async (m: SalesColumnMapping) => ok(m));
    const onSaved = vi.fn();
    const { container } = render(<ColumnMappingForm initial={null} detectedHeaders={['CUSTOMER CODE', 'INVOICE DATE']} onSaved={onSaved} />);
    expect(container.querySelectorAll('datalist option')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(/Outlet \/ customer code/), { target: { value: ' CUSTOMER CODE ' } });
    fireEvent.change(screen.getByLabelText(/Invoice date/), { target: { value: 'INVOICE DATE' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: 'NET AMT' } });
    fireEvent.click(screen.getByRole('button', { name: /Add product column/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Product column 1 label' }), { target: { value: 'SKU group' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Product column 1 heading' }), { target: { value: 'CLUB SKU' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save column mapping' })); });
    expect(apiMock.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      outletCode: 'CUSTOMER CODE', invoiceDate: 'INVOICE DATE', amount: 'NET AMT', quantity: null,
      dimensions: [{ key: 'skuGroup', label: 'SKU group', header: 'CLUB SKU' }],
    }));
    expect(onSaved).toHaveBeenCalled();
  });
});

describe('settings page', () => {
  it('without a mapping, KPIs wait for it', async () => {
    apiMock.getProfile.mockResolvedValue(ok(null));
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    render(<SettingsPage />);
    expect(await screen.findByText(/Save the column mapping first/)).toBeInTheDocument();
  });

  it('lists KPI definitions with a plain description; Stop importing releases ownership', async () => {
    apiMock.getProfile.mockResolvedValue(ok(MAPPING));
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.listKpis.mockResolvedValue(ok({ definitionsHash: 'h', definitions: [
      { id: 'k1', kpiCode: 'KPI_X', measure: 'AMOUNT', filter: { noneOf: [{ dimA: 'P' }] }, outletTypes: [], programs: [], enabled: true, order: 0 },
    ] }));
    clientApi.get.mockResolvedValue(ok(KPIS));
    apiMock.combos.mockResolvedValue({ success: false, error: 'No READY import', status: 404 });
    apiMock.disableKpi.mockResolvedValue(ok({}));
    apiMock.segmentOptions.mockResolvedValue(ok({ outletTypes: [], programs: [] }));
    render(<SettingsPage />);
    expect(await screen.findByText('All products except P (all sku groups)')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop importing KPI_X' })); });
    expect(apiMock.disableKpi).toHaveBeenCalledWith('k1');
  });

  it('loads segment-options and passes them to the KPI editor', async () => {
    apiMock.getProfile.mockResolvedValue(ok(MAPPING));
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.listKpis.mockResolvedValue(ok({ definitionsHash: 'h', definitions: [] }));
    clientApi.get.mockResolvedValue(ok(KPIS));
    apiMock.combos.mockResolvedValue({ success: false, error: 'No READY import', status: 404 });
    apiMock.segmentOptions.mockResolvedValue(ok({ outletTypes: [{ code: 'WHOLESALER', name: 'Wholesaler' }], programs: [] }));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Add KPI/ }));
    expect(apiMock.segmentOptions).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('checkbox', { name: 'Wholesaler (WHOLESALER)' })).toBeInTheDocument();
  });
});
