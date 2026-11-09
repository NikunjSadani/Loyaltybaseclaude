/// <reference types="vitest/globals" />
/**
 * /admin/offers — "This month's offers" admin (OFFER-TILES-PLAN F4). Fixtures are typed as the
 * §3 contract so a shape drift breaks the test. Months are DATE-RELATIVE (never hardcoded).
 * Run: npx vitest run src/app/admin/offers/__tests__/offers-admin.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (url: string) => get(url),
    post: (url: string, body: unknown) => post(url, body),
    patch: (url: string, body: unknown) => patch(url, body),
    del: (url: string) => del(url),
  },
  authHeader: () => ({}),
}));

import { ToastProvider } from '@/components/ui/toast';
import { istMonthKey } from '@/lib/ist-date';
import { previousMonth, monthBounds, type OfferTileAdmin } from '@/lib/offers';
import OffersAdminPage from '../page';

const CUR = istMonthKey(new Date());
const PREV = previousMonth(CUR);
const { first, last } = monthBounds(CUR);

function tile(over: Partial<OfferTileAdmin> = {}): OfferTileAdmin {
  return {
    id: 'o1', group: 'TARGET_REWARD', valueType: 'POINTS', valueNumber: 35, valueText: null,
    unitLabel: 'per case', product: 'ADHO 50 ml', label: 'Earn on every case', details: null,
    validFrom: first, validTo: last, sortOrder: 0, isActive: true,
    programNames: ['Gold'], outletTypeCodes: ['WHOLESALER'], zones: [], states: [],
    kpiCode: 'ADHO50', copiedFromId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

let listByMonth: Record<string, OfferTileAdmin[]> = {};

function mockGets() {
  get.mockImplementation((url: string) => {
    if (url.startsWith('/api/admin/offers/segment-options')) {
      return Promise.resolve({ success: true, data: { programNames: ['Gold', 'Silver'], zones: ['West'], states: ['Maharashtra'] } });
    }
    if (url.startsWith('/api/admin/offers?')) {
      const m = new URL(url, 'http://x').searchParams.get('month') ?? '';
      return Promise.resolve({ success: true, data: { month: m, tiles: listByMonth[m] ?? [] } });
    }
    if (url.startsWith('/api/settings/outlet-types')) {
      return Promise.resolve({ success: true, data: [{ code: 'WHOLESALER', label: 'Wholesaler', name: 'Wholesaler', displayName: 'BSC' }] });
    }
    if (url.startsWith('/api/admin/kpis')) {
      return Promise.resolve({ success: true, data: [{ code: 'ADHO50', label: 'ADHO 50 ml', unit: 'cases', enabled: true }] });
    }
    return Promise.resolve({ success: false, error: 'unexpected ' + url });
  });
}

const renderPage = () => render(<ToastProvider><OffersAdminPage /></ToastProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  listByMonth = { [CUR]: [tile()] };
  mockGets();
});

describe('OffersAdminPage', () => {
  it('lists tiles for the current IST month and never sends a clientId', async () => {
    renderPage();
    const row = await screen.findByTestId('offer-row');
    expect(within(row).getByText('+35 pts')).toBeInTheDocument();
    expect(within(row).getByText(/ADHO 50 ml · Earn on every case/)).toBeInTheDocument();
    // Targeting summary uses the tenant outlet-type label; KPI shown by its label.
    expect(within(row).getByText(/Gold · BSC/)).toBeInTheDocument();
    expect(within(row).getByText(/Progress: ADHO 50 ml/)).toBeInTheDocument();
    expect(screen.getByText('Earn on your targets')).toBeInTheDocument();

    expect(get).toHaveBeenCalledWith(`/api/admin/offers?month=${CUR}`);
    for (const [url] of get.mock.calls) expect(String(url)).not.toContain('clientId');
  });

  it('shows the empty state when the month has no tiles', async () => {
    listByMonth = {};
    renderPage();
    expect(await screen.findByText('No offers for this month yet.')).toBeInTheDocument();
  });

  it('creates a POINTS tile with the §3.3 body (valueText null)', async () => {
    post.mockResolvedValue({ success: true, data: { tile: tile({ id: 'new' }) } });
    renderPage();
    await screen.findByTestId('offer-row');
    fireEvent.click(screen.getByTestId('new-tile-btn'));
    const form = await screen.findByTestId('offer-form');

    fireEvent.change(within(form).getByLabelText(/^Value \(points\)/), { target: { value: '35' } });
    fireEvent.change(within(form).getByLabelText('Unit label'), { target: { value: 'per case' } });
    fireEvent.change(within(form).getByLabelText('Product'), { target: { value: ' ADHO 50 ml ' } });
    fireEvent.change(within(form).getByLabelText('Headline'), { target: { value: 'Earn on every case' } });
    fireEvent.change(within(form).getByLabelText(/progress on/), { target: { value: 'ADHO50' } });
    fireEvent.click(within(within(form).getByTestId('target-programs')).getByLabelText('Gold'));

    // Live preview reuses the partner tile.
    expect(within(screen.getByTestId('offer-preview')).getByText('+35 pts')).toBeInTheDocument();

    fireEvent.click(within(form).getByTestId('offer-save'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/admin/offers');
    expect(body).toEqual({
      group: 'TARGET_REWARD', valueType: 'POINTS', valueNumber: 35, valueText: null,
      unitLabel: 'per case', product: 'ADHO 50 ml', label: 'Earn on every case', details: null,
      validFrom: first, validTo: last, sortOrder: 0, isActive: true,
      programNames: ['Gold'], outletTypeCodes: [], zones: [], states: [], kpiCode: 'ADHO50',
    });
    expect(body).not.toHaveProperty('clientId');
    await waitFor(() => expect(screen.queryByTestId('offer-form')).not.toBeInTheDocument());
  });

  it('switching value type to TEXT swaps the input and nulls valueNumber', async () => {
    post.mockResolvedValue({ success: true, data: { tile: tile({ id: 'new' }) } });
    renderPage();
    await screen.findByTestId('offer-row');
    fireEvent.click(screen.getByTestId('new-tile-btn'));
    const form = await screen.findByTestId('offer-form');

    fireEvent.change(within(form).getByLabelText(/^Value \(points\)/), { target: { value: '10' } });
    fireEvent.change(within(form).getByLabelText('Value type'), { target: { value: 'TEXT' } });
    expect(within(form).queryByLabelText(/^Value \(points\)/)).not.toBeInTheDocument();
    const textInput = within(form).getByLabelText(/Value text/);
    expect(textInput).toHaveAttribute('maxLength', '12');
    fireEvent.change(textInput, { target: { value: 'Free kit' } });
    fireEvent.change(within(form).getByLabelText('Headline'), { target: { value: 'Get a kit' } });
    fireEvent.click(within(form).getByTestId('offer-save'));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.valueType).toBe('TEXT');
    expect(body.valueNumber).toBeNull();
    expect(body.valueText).toBe('Free kit');
  });

  it('delete asks for confirmation, then calls DELETE', async () => {
    del.mockResolvedValue({ success: true, data: { id: 'o1' } });
    renderPage();
    await screen.findByTestId('offer-row');
    fireEvent.click(screen.getByLabelText('Delete Earn on every case'));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('confirm-delete'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/admin/offers/o1'));
  });

  it('publish toggle PATCHes isActive', async () => {
    patch.mockResolvedValue({ success: true, data: { tile: tile({ isActive: false }) } });
    renderPage();
    await screen.findByTestId('offer-row');
    fireEvent.click(screen.getByTestId('publish-toggle'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/admin/offers/o1', { isActive: false }));
    expect(await screen.findByText('Draft')).toBeInTheDocument();
  });

  it('copy last month posts {fromMonth, toMonth} relative to the picker and toasts the result', async () => {
    listByMonth[PREV] = [tile({ id: 'p1', validFrom: `${PREV}-01`, validTo: monthBounds(PREV).last })];
    post.mockResolvedValue({ success: true, data: { created: 1, skipped: 0, tiles: [] } });
    renderPage();
    await screen.findByTestId('offer-row');
    fireEvent.click(screen.getByTestId('copy-month-btn'));
    const modal = await screen.findByTestId('copy-modal');
    expect(await within(modal).findByText(/Copy 1 tile from .* as drafts\?/)).toBeInTheDocument();
    fireEvent.click(within(modal).getByTestId('confirm-copy'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/admin/offers/copy-month', { fromMonth: PREV, toMonth: CUR }),
    );
    expect(await screen.findByText('Created 1, skipped 0 (already copied)')).toBeInTheDocument();
  });

  it('shows a BE 400 message verbatim (list + form save)', async () => {
    get.mockImplementation((url: string) =>
      url.startsWith('/api/admin/offers?')
        ? Promise.resolve({ success: false, error: 'Assume a tenant to manage offers.', status: 400 })
        : Promise.resolve({ success: true, data: [] }),
    );
    renderPage();
    expect(await screen.findByTestId('offers-error')).toHaveTextContent('Assume a tenant to manage offers.');

    post.mockResolvedValue({ success: false, error: 'Unknown KPI', status: 400 });
    fireEvent.click(screen.getByTestId('new-tile-btn'));
    const form = await screen.findByTestId('offer-form');
    fireEvent.change(within(form).getByLabelText(/^Value \(points\)/), { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText('Headline'), { target: { value: 'X' } });
    fireEvent.click(within(form).getByTestId('offer-save'));
    expect(await within(form).findByTestId('offer-form-error')).toHaveTextContent('Unknown KPI');
  });
});
