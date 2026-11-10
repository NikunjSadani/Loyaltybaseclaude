/// <reference types="vitest/globals" />
/**
 * /admin/targets KPI form — outletType (E1) + clean upsert body.
 *
 * KO1: existing KPIs (outletType null) show "All"; a typed KPI shows the tenant's display label
 * KO2: Add KPI with an outlet type POSTs outletType = the code (from the tenant's enabled types)
 * KO3: Edit sends ONLY the whitelisted fields (no id/clientId/timestamps); an unchanged outletType is omitted
 * KO4: Edit that changes the outlet type sends it
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
  outletType: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};
const TYPED = { ...ROW, id: 'k2', code: 'RLP_LINES', label: 'RLP Lines', isPrimary: false, order: 2, outletType: 'SSS' };

async function renderPage() {
  getMock.mockResolvedValue({ success: true, data: [ROW, TYPED] });
  postMock.mockResolvedValue({ success: true, data: ROW });
  await act(async () => { render(<AdminTargetsPage />); });
  await screen.findByTestId('kpi-outlet-type-MONTH_TGT');
}

describe('KPI outlet type (E1)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('KO1: null shows "All"; a typed KPI shows the tenant display label', async () => {
    await renderPage();
    expect(screen.getByTestId('kpi-outlet-type-MONTH_TGT')).toHaveTextContent('All');
    expect(screen.getByTestId('kpi-outlet-type-RLP_LINES')).toHaveTextContent('RLP');
  });

  it('KO2: Add KPI with an outlet type POSTs the code', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Add KPI/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. MONTH_TGT'), { target: { value: 'BSC_LINES' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Month Target'), { target: { value: 'BSC Lines' } });
    const select = screen.getByTestId('kpi-outlet-type-select');
    expect(within(select).getByRole('option', { name: 'All outlet types' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'WHOLESALER' } });
    const addButtons = screen.getAllByRole('button', { name: /Add KPI/ });
    fireEvent.click(addButtons[addButtons.length - 1]);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [url, body] = postMock.mock.calls[0];
    expect(url).toBe('/api/admin/kpis');
    expect(body).toMatchObject({ code: 'BSC_LINES', label: 'BSC Lines', outletType: 'WHOLESALER' });
  });

  it('KO3: Edit sends only whitelisted fields and keeps a shared KPI shared', async () => {
    await renderPage();
    fireEvent.click(screen.getAllByTitle('Edit')[0]);
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    // Unchanged outletType is OMITTED (backend leaves the stored value alone, no re-validation).
    expect(Object.keys(body).sort()).toEqual([
      'code', 'enabled', 'hasNameOverride', 'isPrimary', 'label', 'nameOverrideLabel', 'order', 'rollup', 'unit',
    ]);
    expect(body.code).toBe('MONTH_TGT');
  });

  it('KO4: Edit that CHANGES the outlet type sends it (typed → All sends null)', async () => {
    await renderPage();
    fireEvent.click(screen.getAllByTitle('Edit')[1]); // RLP_LINES (SSS)
    fireEvent.change(screen.getByTestId('kpi-outlet-type-select'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body.code).toBe('RLP_LINES');
    expect(body.outletType).toBeNull();
  });
});
