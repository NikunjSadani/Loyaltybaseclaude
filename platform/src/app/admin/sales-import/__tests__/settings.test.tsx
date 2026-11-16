/// <reference types="vitest/globals" />
/**
 * Settings: KPI editor + Product set builder (§6.2a, §11 F-6) and the column-mapping form.
 * Run: npx vitest run src/app/admin/sales-import/__tests__/settings.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  SalesColumnMapping, SalesImportCombos, SalesKpiDefinitionDto,
} from '@/lib/sales-import/types';

const apiMock = vi.hoisted(() => ({
  testKpi: vi.fn(), createKpi: vi.fn(), patchKpi: vi.fn(), saveProfile: vi.fn(),
  getProfile: vi.fn(), list: vi.fn(), get: vi.fn(), listKpis: vi.fn(), combos: vi.fn(), disableKpi: vi.fn(), segmentOptions: vi.fn(),
}));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
const clientApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', async (orig) => {
  const actual = await orig<typeof import('@/lib/api-client')>();
  return { ...actual, api: { ...actual.api, get: clientApi.get } };
});

import { KpiEditor, scopeConflictWarning } from '../settings/_components/kpi-editor';
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

  it('server warnings disappear once the set changes (stale test)', async () => {
    apiMock.testKpi.mockResolvedValue(ok({ months: [], unmatchedEntries: { anyOf: [0], noneOf: [] }, redundantEntries: { anyOf: [] }, matchedLines: 0 }));
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X', filter: { anyOf: [{ dimA: 'P' }] } } });
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

describe('KPI editor — product set (audit fixes)', () => {
  const BLANK_COMBOS: SalesImportCombos = {
    importId: 'imp1',
    dimensionValues: { dimA: [{ value: 'P', lines: 3, amountRupees: 50 }, { value: '', lines: 2, amountRupees: 20 }] },
    dimensionCombos: [
      { dims: { dimA: 'P', dimB: '' }, lines: 3, amountRupees: 50, quantity: 1 },
      { dims: { dimA: '', dimB: '500' }, lines: 2, amountRupees: 20, quantity: 1 },
    ],
  };

  it('ticking a combo with a blank value keeps the blank as an exact match (never widens to the whole brand)', async () => {
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok(d));
    renderEditor({ combos: BLANK_COMBOS, initial: { ...NEW, kpiCode: 'KPI_X' } });
    const box = screen.getByRole('checkbox', { name: 'Pick P (blank sku group)' });
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.getByTestId('product-set-chips')).toHaveTextContent('P (blank sku group)');
    expect(screen.getByTestId('product-set-chips')).not.toHaveTextContent('all sku groups');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi.mock.calls[0][0].filter).toEqual({ anyOf: [{ dimA: 'P', dimB: '' }] });
  });

  it('no "(blank)" whole-value chip is offered (an all-blank entry is refused by the backend)', () => {
    renderEditor({ combos: BLANK_COMBOS, initial: { ...NEW, kpiCode: 'KPI_X' } });
    expect(screen.getByRole('button', { name: 'Add all of P' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blank/i })).not.toBeInTheDocument();
  });

  it('a combo whose values are ALL blank cannot be picked, and Select all skips it', () => {
    const combos: SalesImportCombos = {
      ...BLANK_COMBOS,
      dimensionCombos: [...BLANK_COMBOS.dimensionCombos, { dims: { dimA: '', dimB: '' }, lines: 9, amountRupees: 5, quantity: 1 }],
    };
    renderEditor({ combos, initial: { ...NEW, kpiCode: 'KPI_X' } });
    expect(screen.getByRole('checkbox', { name: 'Cannot pick: every product column is blank' })).toBeDisabled();
    expect(screen.getByTestId('combo-all-blank-note')).toHaveTextContent('1 combination with every product column blank');
    fireEvent.click(screen.getByRole('button', { name: /Select all \(2\)/ }));
    expect(screen.getAllByTestId('product-set-chip')).toHaveLength(2);
    expect(screen.getByTestId('product-set-chips')).not.toHaveTextContent('(blank brand) (blank sku group)');
  });

  it('an all-blank entry already in the set blocks Save with a clear message', () => {
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X', filter: { anyOf: [{ dimA: '', dimB: '' }] } } });
    expect(screen.getByTestId('kpi-editor-blockers')).toHaveTextContent('entry 1 has only blank values');
    expect(screen.getByRole('button', { name: 'Save KPI' })).toBeDisabled();
  });

  it('a combo from a file processed with an older mapping pins only that file\'s columns, with a warning', async () => {
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok(d));
    const old: SalesImportCombos = {
      importId: 'old', dimensionValues: {},
      dimensionCombos: [{ dims: { dimA: 'P' }, lines: 1, amountRupees: 1, quantity: 1 }],
    };
    renderEditor({ combos: old, initial: { ...NEW, kpiCode: 'KPI_X' } });
    expect(screen.getByTestId('product-set-mapping-drift')).toHaveTextContent('has no SKU group column');
    fireEvent.click(screen.getByRole('checkbox', { name: /Pick P/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi.mock.calls[0][0].filter).toEqual({ anyOf: [{ dimA: 'P' }] });
  });

  it('read-only without manage permission: every control in the editor is disabled', () => {
    renderEditor({ canEdit: false, initial: { ...NEW, id: 'k1', kpiCode: 'KPI_X' } });
    expect(screen.getByTestId('kpi-editor-fields')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Pick P 500' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Duplicate as cases KPI' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });

  it('flags an entry both included and excluded, and an exclusion that cancels an inclusion', () => {
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X', filter: { anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'Q' }], noneOf: [{ dimA: 'P' }, { dimA: 'Q' }] } } });
    const chips = screen.getAllByTestId('product-set-chip');
    expect(chips[0]).toHaveTextContent('P 500 counts nothing: "except P (all sku groups)" removes all of it.');
    expect(chips[1]).toHaveTextContent('Q (all sku groups) is both included and excluded');
  });

  it('"never appears in the latest file" shows live, without pressing Test', () => {
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X', filter: { anyOf: [{ dimA: 'ZZ' }] } } });
    expect(screen.getByTestId('product-set-chip-warning')).toHaveTextContent('ZZ (all sku groups) never appears in the latest file');
    expect(apiMock.testKpi).not.toHaveBeenCalled();
  });

  it('"Select all" stops at the 200-entry cap and says so', () => {
    const many: SalesImportCombos = {
      importId: 'imp1', dimensionValues: {},
      dimensionCombos: Array.from({ length: 205 }, (_, i) => ({ dims: { dimA: `B${i}`, dimB: '1' }, lines: 1, amountRupees: 1, quantity: 1 })),
    };
    const existing = Array.from({ length: 10 }, (_, i) => ({ dimA: `X${i}` }));
    renderEditor({ combos: many, initial: { ...NEW, kpiCode: 'KPI_X', filter: { anyOf: existing } } });
    expect(screen.getByText(/Only 190 more fit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Select all \(190\)/ }));
    expect(screen.getByRole('tab', { name: /Include \(200\)/ })).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-editor-blockers')).not.toBeInTheDocument();
  });

  it('Include / Exclude tabs: aria-controls + arrow keys', () => {
    renderEditor();
    const inc = screen.getByRole('tab', { name: /Include/ });
    expect(inc).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id);
    fireEvent.keyDown(inc, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Exclude/ })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Exclude/ }));
  });

  it('sort headers expose aria-sort', () => {
    renderEditor();
    const amountHeader = screen.getByRole('button', { name: 'Sort by ₹' }).closest('th')!;
    expect(amountHeader).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Lines' }));
    expect(screen.getByRole('button', { name: 'Sort by Lines' }).closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(amountHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('a Test result goes stale when the outlet scope changes', async () => {
    apiMock.testKpi.mockResolvedValue(ok({ months: [], unmatchedEntries: { anyOf: [], noneOf: [] }, redundantEntries: { anyOf: [] }, matchedLines: 4 }));
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X' }, segments: { outletTypes: [{ code: 'RETAILER', name: 'Retailer' }], programs: [], subPrograms: [] } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Test against latest import/ })); });
    expect(screen.getByTestId('kpi-test-result')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Retailer (RETAILER)' }));
    expect(screen.queryByTestId('kpi-test-result')).not.toBeInTheDocument();
    expect(screen.getByText(/outlet scope changed since the last test/)).toBeInTheDocument();
  });
});

describe('KPI editor — KPI list states', () => {
  it('a failed KPI-list load shows an error + Retry, not "every KPI already comes from Sales Import"', () => {
    const onRetry = vi.fn();
    renderEditor({ tenantKpis: [], tenantKpisError: 'HTTP 500', onRetryTenantKpis: onRetry });
    expect(screen.getByTestId('kpi-list-error')).toHaveTextContent('HTTP 500');
    expect(screen.queryByText(/already comes from Sales Import/)).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('kpi-list-error')).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('a tenant with zero KPIs gets accurate copy', () => {
    renderEditor({ tenantKpis: [] });
    expect(screen.getByText(/This programme has no KPIs yet/)).toBeInTheDocument();
  });

  it('editing explains that already-applied months keep old values until re-applied', () => {
    renderEditor({ initial: { ...NEW, id: 'k1', kpiCode: 'KPI_X' } });
    expect(screen.getByText(/months already applied keep their old values until/)).toBeInTheDocument();
  });

  it('without manage permission Save is hidden', () => {
    renderEditor({ canEdit: false, initial: { ...NEW, kpiCode: 'KPI_X' } });
    expect(screen.queryByRole('button', { name: 'Save KPI' })).not.toBeInTheDocument();
  });
});

describe('KPI editor — outlet scope', () => {
  const SEG = {
    outletTypes: [{ code: 'RETAILER', name: 'Retailer' }, { code: 'WHOLESALER', name: 'Wholesaler' }],
    programs: ['Gold', 'Silver'],
    subPrograms: [] as string[],
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
    renderEditor({ segments: { outletTypes: [], programs: ['Gold'], subPrograms: [] } });
    expect(screen.getByRole('textbox', { name: /Only these outlet types/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Only these programmes/ })).toBeInTheDocument();
  });

  it('no segments prop → both free text', () => {
    renderEditor();
    expect(screen.getByRole('textbox', { name: /Only these outlet types/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Only these programmes/ })).toBeInTheDocument();
  });
});

describe('KPI editor — L4: the KPI\'s own outlet type (KpiDef.outletType) vs the definition scope', () => {
  const SEG = {
    outletTypes: [{ code: 'RETAILER', name: 'Retailer' }, { code: 'WHOLESALER', name: 'Wholesaler' }],
    programs: [] as string[],
    subPrograms: [] as string[],
  };
  const TYPED = [{ code: 'KPI_W', label: 'KPI W', unit: '₹', enabled: true, outletType: 'WHOLESALER' }, ...KPIS];

  it('scopeConflictWarning: agree / empty / shared → null; disjoint → "no outlet"; extra types → named', () => {
    expect(scopeConflictWarning({ code: 'K', outletType: null }, ['RETAILER'])).toBeNull();
    expect(scopeConflictWarning({ code: 'K', outletType: 'WHOLESALER' }, [])).toBeNull();
    expect(scopeConflictWarning({ code: 'K', outletType: 'WHOLESALER' }, ['wholesaler'])).toBeNull();
    expect(scopeConflictWarning({ code: 'K', outletType: 'WHOLESALER' }, ['RETAILER'])).toMatch(/No outlet will get a value/);
    expect(scopeConflictWarning({ code: 'K', outletType: 'WHOLESALER' }, ['WHOLESALER', 'RETAILER'])).toMatch(/RETAILER outlets will not get a value/);
    expect(scopeConflictWarning(undefined, ['RETAILER'])).toBeNull();
  });

  it('warns in the editor when the picked scope disagrees with the KPI\'s type; nothing for a shared KPI', () => {
    renderEditor({ segments: SEG, tenantKpis: TYPED, initial: { ...NEW, kpiCode: 'KPI_W' } });
    // no scope chosen: an informational note, not a warning
    expect(screen.getByTestId('kpi-scope-kpi-type')).toHaveTextContent('WHOLESALER outlets only');
    expect(screen.queryByTestId('kpi-scope-conflict')).not.toBeInTheDocument();
    const types = screen.getByRole('group', { name: /Only these outlet types/ });
    fireEvent.click(within(types).getByRole('checkbox', { name: 'Retailer (RETAILER)' }));
    expect(screen.getByTestId('kpi-scope-conflict')).toHaveTextContent(/No outlet will get a value/);
    fireEvent.click(within(types).getByRole('checkbox', { name: 'Wholesaler (WHOLESALER)' }));
    expect(screen.getByTestId('kpi-scope-conflict')).toHaveTextContent(/RETAILER outlets will not get a value/);
    fireEvent.click(within(types).getByRole('checkbox', { name: 'Retailer (RETAILER)' })); // untick → agree
    expect(screen.queryByTestId('kpi-scope-conflict')).not.toBeInTheDocument();
  });

  it('APPLIES-TO: the warning generalises to the KPI outletTypes[] and programs[] (arrays win over legacy)', () => {
    const k = { code: 'K', outletType: null, outletTypes: ['SSS', 'WHOLESALER'], programs: ['Unnati'], subPrograms: [] };
    expect(scopeConflictWarning(k, ['sss'])).toBeNull();
    expect(scopeConflictWarning(k, ['RETAILER'])).toMatch(/SSS, WHOLESALER outlets only.*No outlet will get a value. Add SSS or WHOLESALER/);
    expect(scopeConflictWarning(k, [], ['unnati'])).toBeNull();
    expect(scopeConflictWarning(k, [], ['Pragati'])).toMatch(/applies only to the programme Unnati.*No outlet will get a value/);
    expect(scopeConflictWarning(k, ['SSS', 'RETAILER'], ['Unnati', 'Pragati']))
      .toMatch(/RETAILER outlets will not get a value.*outlets in Pragati will not get a value/);
    // legacy single type still honoured when the arrays are absent
    expect(scopeConflictWarning({ code: 'K', outletType: 'WHOLESALER' }, ['RETAILER'])).toMatch(/No outlet will get a value/);
  });

  it('APPLIES-TO: a KPI scoped by sub-programme shows the informational note', () => {
    const SUB = [{ code: 'KPI_S', label: 'KPI S', unit: '₹', enabled: true, outletType: null, outletTypes: [], programs: ['Unnati'], subPrograms: ['Lite'] }, ...KPIS];
    renderEditor({ segments: SEG, tenantKpis: SUB, initial: { ...NEW, kpiCode: 'KPI_S', programs: ['Unnati'] } });
    expect(screen.queryByTestId('kpi-scope-conflict')).not.toBeInTheDocument();
    expect(screen.getByTestId('kpi-scope-kpi-type')).toHaveTextContent('outlets in programme Unnati with sub-programme Lite only');
  });

  it('a shared KPI (no outletType) never shows the warning', () => {
    renderEditor({ segments: SEG, initial: { ...NEW, kpiCode: 'KPI_X', outletTypes: ['RETAILER'] } });
    expect(screen.queryByTestId('kpi-scope-conflict')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-scope-kpi-type')).not.toBeInTheDocument();
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

describe('column mapping — keys', () => {
  it('a saved column keeps its key when the label changes; a new column gets a suggested key', () => {
    render(<ColumnMappingForm initial={MAPPING} detectedHeaders={[]} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Product column 1 label' }), { target: { value: 'Brand name' } });
    expect(screen.getByRole('textbox', { name: 'Product column 1 key' })).toHaveValue('dimA');
    fireEvent.click(screen.getByRole('button', { name: /Add product column/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Product column 3 label' }), { target: { value: 'Pack size' } });
    expect(screen.getByRole('textbox', { name: 'Product column 3 key' })).toHaveValue('packSize');
  });

  it('a saved column whose key happens to equal the suggestion still keeps it', () => {
    render(<ColumnMappingForm initial={{ ...MAPPING, dimensions: [{ key: 'brand', label: 'Brand', header: 'A' }] }} detectedHeaders={[]} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Product column 1 label' }), { target: { value: 'Make' } });
    expect(screen.getByRole('textbox', { name: 'Product column 1 key' })).toHaveValue('brand');
  });

  it('read-only without manage permission', () => {
    render(<ColumnMappingForm initial={MAPPING} detectedHeaders={[]} onSaved={vi.fn()} canEdit={false} />);
    expect(screen.queryByRole('button', { name: 'Save column mapping' })).not.toBeInTheDocument();
    expect(screen.getByTestId('mapping-read-only')).toBeInTheDocument();
    expect(screen.getByLabelText(/Outlet \/ customer code/)).toBeDisabled();
    expect(screen.getByRole('button', { name: /Add product column/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove product column 1' })).toBeDisabled();
  });
});

describe('settings page', () => {
  it('a failed tenant-KPI load is shown in the editor with Retry', async () => {
    apiMock.getProfile.mockResolvedValue(ok(MAPPING));
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.listKpis.mockResolvedValue(ok({ definitionsHash: 'h', definitions: [] }));
    clientApi.get.mockResolvedValueOnce({ success: false, error: 'HTTP 503', status: 503 }).mockResolvedValue(ok(KPIS));
    apiMock.combos.mockResolvedValue({ success: false, error: 'No READY import', status: 404 });
    apiMock.segmentOptions.mockResolvedValue(ok({ outletTypes: [], programs: [] }));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Add KPI/ }));
    const err = await screen.findByTestId('kpi-list-error');
    expect(err).toHaveTextContent('HTTP 503');
    await act(async () => { fireEvent.click(within(err).getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByRole('option', { name: /KPI X/ })).toBeInTheDocument();
  });

  it('heading suggestions come from the heading row only (never sample data rows)', async () => {
    apiMock.getProfile.mockResolvedValue(ok(null));
    apiMock.list.mockResolvedValue(ok({ items: [{ id: 'nm1', status: 'NEEDS_MAPPING', purgedAt: null, detectedHeaders: null }], nextCursor: null }));
    apiMock.get.mockResolvedValue(ok({ id: 'nm1', detectedHeaders: [['CUST CODE', 'INV DATE'], ['C001', '05-10-2026']] }));
    const { container } = render(<SettingsPage />);
    await screen.findByText(/Save the column mapping first/);
    await vi.waitFor(() => expect(container.querySelectorAll('datalist option')).toHaveLength(2));
    const values = [...container.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'));
    expect(values).toEqual(['CUST CODE', 'INV DATE']);
    expect(apiMock.get).toHaveBeenCalledWith('nm1');
  });

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

  it('the KPI list names each measure: ₹ / Cases / Products (lines)', async () => {
    apiMock.getProfile.mockResolvedValue(ok(MAPPING));
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.listKpis.mockResolvedValue(ok({ definitionsHash: 'h', definitions: [
      { id: 'k1', kpiCode: 'KPI_X', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0 },
      { id: 'k2', kpiCode: 'KPI_Y', measure: 'PRODUCT_COUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 1 },
    ] }));
    clientApi.get.mockResolvedValue(ok(KPIS));
    apiMock.combos.mockResolvedValue({ success: false, error: 'No READY import', status: 404 });
    apiMock.segmentOptions.mockResolvedValue(ok({ outletTypes: [], programs: [] }));
    render(<SettingsPage />);
    expect(await screen.findByText('Products (lines)')).toBeInTheDocument();
    expect(await screen.findByText('₹')).toBeInTheDocument();
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

  it('after saving a KPI, points to the Months page to fill past months from stored history', async () => {
    apiMock.getProfile.mockResolvedValue(ok(MAPPING));
    apiMock.list.mockResolvedValue(ok({ items: [], nextCursor: null }));
    apiMock.listKpis.mockResolvedValue(ok({ definitionsHash: 'h', definitions: [] }));
    clientApi.get.mockResolvedValue(ok(KPIS));
    apiMock.combos.mockResolvedValue({ success: false, error: 'No READY import', status: 404 });
    apiMock.segmentOptions.mockResolvedValue(ok({ outletTypes: [], programs: [] }));
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k9' }));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Add KPI/ }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'KPI' }), { target: { value: 'KPI_X' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    const note = await screen.findByTestId('kpi-saved-fill-past');
    expect(note).toHaveTextContent('KPI_X is saved');
    expect(await within(note).findByRole('link', { name: /Recalculate from stored history/ })).toHaveAttribute('href', '/admin/sales-import/months');
  });
});

describe('KPI editor — PRODUCT_COUNT ("Number of products bought (lines)")', () => {
  it('offers the option with help text and saves measure PRODUCT_COUNT', async () => {
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k1' }));
    const p = renderEditor();
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'KPI_X' } });
    const radio = screen.getByRole('radio', { name: 'Number of products bought (lines)' });
    expect(radio).toBeEnabled();
    expect(screen.queryByTestId('measure-product-count-help')).not.toBeInTheDocument();
    fireEvent.click(radio);
    expect(await screen.findByTestId('measure-product-count-help')).toHaveTextContent('Returns cancel purchases.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi).toHaveBeenCalledWith(expect.objectContaining({ kpiCode: 'KPI_X', measure: 'PRODUCT_COUNT' }));
    await waitFor(() => expect(p.onSaved).toHaveBeenCalled());
  });

  it('is disabled without an amount column (products are counted by net amount) or without product columns', () => {
    renderEditor({ mapping: { ...MAPPING, amount: null } });
    expect(screen.getByRole('radio', { name: 'Number of products bought (lines)' })).toBeDisabled();
  });

  it('blocks save on a PRODUCT_COUNT definition when the mapping has no product columns', () => {
    renderEditor({ mapping: { ...MAPPING, dimensions: [] }, initial: { ...NEW, kpiCode: 'KPI_X', measure: 'PRODUCT_COUNT' } });
    expect(screen.getByTestId('kpi-editor-blockers')).toHaveTextContent('no product columns');
    expect(screen.getByRole('button', { name: 'Save KPI' })).toBeDisabled();
  });

  it('Test shows the summed product count as a plain integer', async () => {
    apiMock.testKpi.mockResolvedValue(ok({
      months: [{ month: '2026-10', totalAmountRupees: 165, totalQuantity: 1.75, totalProducts: 1234, outletsNonZero: 3 }],
      unmatchedEntries: { anyOf: [], noneOf: [] }, redundantEntries: { anyOf: [] }, matchedLines: 9,
    }));
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X', measure: 'PRODUCT_COUNT' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Test against latest import/ })); });
    const result = await screen.findByTestId('kpi-test-result');
    // L3: plain words for operators (no Σ).
    expect(result).toHaveTextContent('Products (all outlets added up)');
    expect(result).not.toHaveTextContent('Σ');
    expect(result).toHaveTextContent('1,234');
    expect(result).not.toHaveTextContent('1,234.');
  });

  it('switching to PRODUCT_COUNT after a ₹ test marks the test stale (the count was not computed)', async () => {
    apiMock.testKpi.mockResolvedValue(ok({
      months: [{ month: '2026-10', totalAmountRupees: 165, totalQuantity: 1.75, outletsNonZero: 3 }],
      unmatchedEntries: { anyOf: [], noneOf: [] }, redundantEntries: { anyOf: [] }, matchedLines: 9,
    }));
    renderEditor({ initial: { ...NEW, kpiCode: 'KPI_X' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Test against latest import/ })); });
    expect(await screen.findByTestId('kpi-test-result')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Number of products bought (lines)' }));
    await waitFor(() => expect(screen.queryByTestId('kpi-test-result')).not.toBeInTheDocument());
    expect(await screen.findByText(/test again/)).toBeInTheDocument();
  });
});
