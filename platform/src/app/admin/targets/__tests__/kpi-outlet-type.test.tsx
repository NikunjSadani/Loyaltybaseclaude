/// <reference types="vitest/globals" />
/**
 * /admin/targets KPI form — APPLIES-TO scope (outlet types × programs × sub-programs) + clean upsert body.
 * (Replaces the single outletType select of E1; a legacy outletType-only KPI reads as a one-type scope.)
 *
 * KO1: list chips — "All outlets", legacy outletType → tenant label, full scope → "RLP · Unnati · Lite"
 * KO2: Add KPI with a scope POSTs the three arrays; Add with no scope omits them
 * KO3: Edit that does not touch the scope sends ONLY the whitelisted fields (no arrays, no legacy outletType)
 * KO4: Edit that changes the scope sends all three arrays (legacy typed → cleared sends [] for each)
 * KO5: scope-options badge "(not in settings list)"; live matching-outlet count; options error + retry
 * Run: npx vitest run src/app/admin/targets/__tests__/kpi-outlet-type.test.tsx
 */

import React, { act } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    del: vi.fn(),
  },
}));
vi.mock('@/lib/platform/use-outlet-type-labels', () => ({
  useOutletTypeLabels: () => ({
    types: [
      { code: 'SSS', label: 'RLP', name: 'SSS', displayName: 'RLP' },
      { code: 'WHOLESALER', label: 'BSC', name: 'Wholesaler', displayName: 'BSC' },
    ],
    overrides: new Map(), label: (_c: string, f: string) => f, loading: false,
  }),
}));

import AdminTargetsPage from '../page';

const ROW = {
  id: 'k1', clientId: 'bajaj', code: 'MONTH_TGT', label: 'Month Target', unit: '₹', isPrimary: true,
  hasNameOverride: false, nameOverrideLabel: null, order: 1, rollup: 'SUM', enabled: true,
  outletType: null, outletTypes: [], programs: [], subPrograms: [],
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};
/** An older payload: legacy single outletType, no arrays. */
const LEGACY = {
  ...ROW, id: 'k2', code: 'RLP_LINES', label: 'RLP Lines', isPrimary: false, order: 2, outletType: 'SSS',
  outletTypes: undefined, programs: undefined, subPrograms: undefined,
};
const SCOPED = {
  ...ROW, id: 'k3', code: 'UNNATI_VOL', label: 'Unnati Volume', isPrimary: false, order: 3, outletType: null,
  outletTypes: ['SSS'], programs: ['Unnati'], subPrograms: ['Lite'],
};
const OPTIONS = {
  outletTypes: [{ code: 'SSS', label: 'RLP' }, { code: 'WHOLESALER', label: 'BSC' }],
  programs: [{ value: 'Unnati', inSettings: true }, { value: 'Pragati', inSettings: false }],
  subPrograms: [{ value: 'Lite', inSettings: true }],
};

let optionsResponse: unknown = { success: true, data: OPTIONS };

async function renderPage() {
  getMock.mockImplementation(async (url: string) => {
    if (url === '/api/admin/kpis') return { success: true, data: [ROW, LEGACY, SCOPED] };
    if (url === '/api/admin/kpis/scope-options') return optionsResponse;
    if (url.startsWith('/api/admin/kpis/scope-count')) return { success: true, data: { count: url.includes('programs=') ? 12 : 340 } };
    return { success: false, error: 'unexpected' };
  });
  postMock.mockResolvedValue({ success: true, data: ROW });
  await act(async () => { render(<AdminTargetsPage />); });
  await screen.findByTestId('kpi-scope-MONTH_TGT');
}

const lastBody = () => postMock.mock.calls[postMock.mock.calls.length - 1][1] as Record<string, unknown>;

describe('KPI applies-to scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    optionsResponse = { success: true, data: OPTIONS };
  });

  it('KO1: chips — All outlets / legacy type label / full scope', async () => {
    await renderPage();
    expect(await screen.findByTestId('kpi-scope-MONTH_TGT')).toHaveTextContent('All outlets');
    expect(await screen.findByTestId('kpi-scope-RLP_LINES')).toHaveTextContent(/^RLP$/);
    const chip = await screen.findByTestId('kpi-scope-UNNATI_VOL');
    expect(chip).toHaveTextContent('RLP · Unnati · Lite');
    expect(chip).toHaveAttribute('title', 'Outlet types: RLP; Programs: Unnati; Sub-Programs: Lite');
  });

  it('KO2: Add KPI with a scope POSTs the three arrays', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Add KPI/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. MONTH_TGT'), { target: { value: 'BSC_LINES' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Month Target'), { target: { value: 'BSC Lines' } });
    const types = await screen.findByRole('group', { name: 'Outlet types' });
    fireEvent.click(within(types).getByRole('checkbox', { name: 'BSC (WHOLESALER)' }));
    const progs = screen.getByRole('group', { name: 'Programs' });
    fireEvent.click(await within(progs).findByRole('checkbox', { name: 'Unnati' }));
    const addButtons = screen.getAllByRole('button', { name: /Add KPI/ });
    fireEvent.click(addButtons[addButtons.length - 1]);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0][0]).toBe('/api/admin/kpis');
    expect(lastBody()).toMatchObject({
      code: 'BSC_LINES', outletTypes: ['WHOLESALER'], programs: ['Unnati'], subPrograms: [],
    });
    expect(lastBody()).not.toHaveProperty('outletType');
  });

  it('KO2b: Add KPI with no scope omits the arrays (backend default = every outlet)', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Add KPI/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. MONTH_TGT'), { target: { value: 'NEW' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Month Target'), { target: { value: 'New' } });
    const addButtons = screen.getAllByRole('button', { name: /Add KPI/ });
    fireEvent.click(addButtons[addButtons.length - 1]);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).not.toHaveProperty('outletTypes');
    expect(lastBody()).not.toHaveProperty('programs');
    expect(lastBody()).not.toHaveProperty('subPrograms');
  });

  it('KO3: Edit without touching the scope sends only the whitelisted fields (scoped + legacy KPIs)', async () => {
    await renderPage();
    const WHITELIST = ['code', 'enabled', 'hasNameOverride', 'isPrimary', 'label', 'nameOverrideLabel', 'order', 'rollup', 'unit'];
    for (const idx of [0, 1, 2]) {
      postMock.mockClear();
      fireEvent.click(screen.getAllByTitle('Edit')[idx]);
      await screen.findByRole('group', { name: 'Outlet types' });
      fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
      await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
      expect(Object.keys(lastBody()).sort()).toEqual(WHITELIST);
      await waitFor(() => expect(screen.queryByRole('button', { name: /Save Changes/ })).not.toBeInTheDocument());
    }
  });

  it('KO3b: the legacy KPI opens with its single type ticked; the scoped KPI with all three facets ticked', async () => {
    await renderPage();
    fireEvent.click(screen.getAllByTitle('Edit')[1]); // RLP_LINES (legacy SSS)
    const types = await screen.findByRole('group', { name: 'Outlet types' });
    expect(await within(types).findByRole('checkbox', { name: 'RLP (SSS)' })).toBeChecked();
    expect(await within(types).findByRole('checkbox', { name: 'BSC (WHOLESALER)' })).not.toBeChecked();
  });

  it('KO4: changing the scope sends all three arrays; clearing a legacy type sends [] for each', async () => {
    await renderPage();
    fireEvent.click(screen.getAllByTitle('Edit')[1]); // RLP_LINES (legacy SSS)
    const types = await screen.findByRole('group', { name: 'Outlet types' });
    fireEvent.click(within(types).getByRole('checkbox', { name: 'RLP (SSS)' })); // untick → every outlet
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toMatchObject({ code: 'RLP_LINES', outletTypes: [], programs: [], subPrograms: [] });
    expect(lastBody()).not.toHaveProperty('outletType');
  });

  it('KO4b: re-ticking back to the original scope counts as unchanged (order/case-insensitive)', async () => {
    await renderPage();
    fireEvent.click(screen.getAllByTitle('Edit')[2]); // UNNATI_VOL
    const progs = await screen.findByRole('group', { name: 'Programs' });
    const unnati = await within(progs).findByRole('checkbox', { name: 'Unnati' });
    fireEvent.click(unnati);
    fireEvent.click(unnati);
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).not.toHaveProperty('programs');
  });

  it('KO5: settings badge, hint, and the live matching-outlet count follows the draft scope', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Add KPI/ }));
    expect(await screen.findByRole('checkbox', { name: /Pragati.*not in settings list/ })).toBeInTheDocument();
    expect(await screen.findByText(/Leave all empty = applies to every outlet/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('kpi-scope-count')).toHaveTextContent('340 matching outlets right now (every outlet)'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unnati' }));
    await waitFor(() => expect(screen.getByTestId('kpi-scope-count')).toHaveTextContent('12 matching outlets right now.'));
    expect(getMock).toHaveBeenCalledWith('/api/admin/kpis/scope-count?programs=Unnati');
  });

  it('KO5b: scope-options failure is shown with Retry; outlet types fall back to the tenant list', async () => {
    optionsResponse = { success: false, error: 'Boom' };
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Add KPI/ }));
    expect(await screen.findByTestId('scope-options-error')).toHaveTextContent('Boom');
    const types = await screen.findByRole('group', { name: 'Outlet types' });
    expect(await within(types).findByRole('checkbox', { name: 'RLP (SSS)' })).toBeInTheDocument();
    optionsResponse = { success: true, data: OPTIONS };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('scope-options-error')).not.toBeInTheDocument());
    expect(await screen.findByRole('checkbox', { name: 'Unnati' })).toBeInTheDocument();
  });
});
