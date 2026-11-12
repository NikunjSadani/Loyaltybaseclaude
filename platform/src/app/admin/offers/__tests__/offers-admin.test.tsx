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
    kpiCode: 'ADHO50', copiedFromId: null, copiedToMonth: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
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
    // …with the same group colours partners see: brand tint, then amber when the group flips.
    const previewTile = () => within(screen.getByTestId('offer-preview')).getByTestId('offer-tile');
    expect(previewTile()).toHaveAttribute('data-group', 'TARGET_REWARD');
    expect(previewTile().className).toContain('bg-[var(--brand-primary-light,#ecf8f0)]');
    fireEvent.click(within(form).getByLabelText('Extra schemes this month'));
    expect(previewTile()).toHaveAttribute('data-group', 'EXTRA_SCHEME');
    expect(previewTile().className).toContain('bg-amber-50');
    fireEvent.click(within(form).getByLabelText('Earn on your targets'));
    expect(previewTile().className).toContain('bg-[var(--brand-primary-light,#ecf8f0)]');

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

  it('month picker is a month + year select pair (no type="month"); switching lists that month', async () => {
    const [y, m] = PREV.split('-');
    listByMonth[PREV] = [tile({ id: 'p1', label: 'Last month tile' })];
    renderPage();
    await screen.findByTestId('offer-row');
    expect(document.querySelector('input[type="month"]')).toBeNull();
    const monthSel = screen.getByLabelText('Month') as HTMLSelectElement;
    const yearSel = screen.getByLabelText('Year') as HTMLSelectElement;
    expect(monthSel.tagName).toBe('SELECT');
    expect(yearSel.value).toBe(CUR.slice(0, 4));
    fireEvent.change(yearSel, { target: { value: y } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: String(Number(m)) } });
    expect(await screen.findByText(/Last month tile/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`/api/admin/offers?month=${PREV}`);
  });

  it('ignores a stale (slower) month response after a fast switch', async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    renderPage();
    await screen.findByTestId('offer-row');
    get.mockImplementation((url: string) => {
      if (url.startsWith('/api/admin/offers?')) {
        const mo = new URL(url, 'http://x').searchParams.get('month') ?? '';
        return new Promise((r) => { resolvers[mo] = r; });
      }
      return Promise.resolve({ success: true, data: [] });
    });
    const [, curM] = CUR.split('-').map(Number);
    const a = curM === 1 ? 2 : curM - 1; // two other months in the same year
    const b = curM === 12 ? 11 : curM + 1;
    const key = (mm: number) => `${CUR.slice(0, 4)}-${String(mm).padStart(2, '0')}`;
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: String(a) } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: String(b) } });
    await waitFor(() => expect(resolvers[key(b)]).toBeDefined());
    resolvers[key(b)]({ success: true, data: { month: key(b), tiles: [tile({ id: 'nb', label: 'Newest month' })] } });
    expect(await screen.findByText(/Newest month/)).toBeInTheDocument();
    // The older request lands late — it must not overwrite the list.
    resolvers[key(a)]({ success: true, data: { month: key(a), tiles: [tile({ id: 'old', label: 'Stale month' })] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Stale month/)).not.toBeInTheDocument();
    expect(screen.getByText(/Newest month/)).toBeInTheDocument();
  });

  it('copy dialog shows an error (not "nothing to copy") when the count fetch fails', async () => {
    renderPage();
    await screen.findByTestId('offer-row');
    get.mockImplementation((url: string) =>
      url === `/api/admin/offers?month=${PREV}`
        ? Promise.resolve({ success: false, error: 'Network error' })
        : Promise.resolve({ success: true, data: [] }),
    );
    fireEvent.click(screen.getByTestId('copy-month-btn'));
    const modal = await screen.findByTestId('copy-modal');
    expect(await within(modal).findByTestId('copy-count-error')).toHaveTextContent('Network error');
    expect(within(modal).queryByText(/nothing to copy/)).not.toBeInTheDocument();
    expect(within(modal).getByTestId('confirm-copy')).toBeDisabled();
  });

  it('form validation: whitespace headline, value ≤ 0, percent > 100, sort order out of range — no request', async () => {
    renderPage();
    await screen.findByTestId('offer-row');
    fireEvent.click(screen.getByTestId('new-tile-btn'));
    const form = await screen.findByTestId('offer-form');
    const value = within(form).getByLabelText(/^Value \(points\)/);
    expect(value).toHaveAttribute('min', '0.01');
    expect(within(form).getByLabelText('Sort order')).toHaveAttribute('max', '1000000');

    fireEvent.change(value, { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText('Headline'), { target: { value: '   ' } });
    fireEvent.submit(form);
    expect(await within(form).findByTestId('offer-form-error')).toHaveTextContent('Headline is required.');

    fireEvent.change(within(form).getByLabelText('Headline'), { target: { value: 'H' } });
    fireEvent.change(value, { target: { value: '0' } });
    fireEvent.submit(form);
    expect(await within(form).findByTestId('offer-form-error')).toHaveTextContent('Value must be greater than 0.');

    fireEvent.change(within(form).getByLabelText('Value type'), { target: { value: 'PERCENT' } });
    const pctInput = within(form).getByLabelText(/^Value \(%\)/);
    expect(pctInput).toHaveAttribute('max', '100');
    fireEvent.change(pctInput, { target: { value: '101' } });
    fireEvent.submit(form);
    expect(await within(form).findByTestId('offer-form-error')).toHaveTextContent('Value must be at most 100%.');

    fireEvent.change(pctInput, { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText('Sort order'), { target: { value: '-1' } });
    fireEvent.submit(form);
    expect(await within(form).findByTestId('offer-form-error')).toHaveTextContent(/Sort order must be a whole number from 0 to/);
    expect(post).not.toHaveBeenCalled();
  });

  it('preview: empty value shows a placeholder (not +0 pts); fractional rupees show 2 decimals', async () => {
    renderPage();
    await screen.findByTestId('offer-row');
    fireEvent.click(screen.getByTestId('new-tile-btn'));
    const form = await screen.findByTestId('offer-form');
    const preview = screen.getByTestId('offer-preview');
    expect(within(preview).getByTestId('offer-tile-value')).toHaveTextContent('—');
    expect(within(preview).queryByText('+0 pts')).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Value type'), { target: { value: 'RUPEES' } });
    fireEvent.change(within(form).getByLabelText(/^Value \(₹\)/), { target: { value: '1500.5' } });
    expect(within(preview).getByTestId('offer-tile-value')).toHaveTextContent('₹1,500.50');
  });

  it('copy result: plain-words warnings for cleared KPI links + unknown outlet types; affected drafts marked', async () => {
    listByMonth[PREV] = [
      tile({ id: 'p1', validFrom: `${PREV}-01`, validTo: monthBounds(PREV).last }),
      tile({ id: 'p2', validFrom: `${PREV}-01`, validTo: monthBounds(PREV).last }),
    ];
    post.mockImplementation(() => {
      listByMonth[CUR] = [
        tile({ id: 'c1', label: 'Copy one', isActive: false, kpiCode: null, copiedFromId: 'p1', copiedToMonth: CUR }),
        tile({ id: 'c2', label: 'Copy two', isActive: false, kpiCode: null, copiedFromId: 'p2', copiedToMonth: CUR }),
      ];
      return Promise.resolve({
        success: true,
        data: { created: 2, skipped: 0, kpiCleared: ['c1', 'c2'], unknownOutletTypes: ['c2'], tiles: [] },
      });
    });
    renderPage();
    await screen.findByTestId('offer-row');
    fireEvent.click(screen.getByTestId('copy-month-btn'));
    const modal = await screen.findByTestId('copy-modal');
    await within(modal).findByText(/Copy 2 tiles/);
    fireEvent.click(within(modal).getByTestId('confirm-copy'));

    const panel = await screen.findByTestId('copy-warnings');
    expect(panel).toHaveTextContent('2 copies had their target link removed');
    expect(panel).toHaveTextContent('1 copy has outlet types that no longer exist — fix before publishing.');
    await screen.findByText(/Copy two/);
    const rows = screen.getAllByTestId('offer-row');
    expect(within(rows[0]).getByTestId('row-kpi-cleared')).toBeInTheDocument();
    expect(within(rows[0]).queryByTestId('row-unknown-types')).not.toBeInTheDocument();
    expect(within(rows[1]).getByTestId('row-unknown-types')).toHaveTextContent('fix before publishing');

    fireEvent.click(screen.getByLabelText('Dismiss copy warnings'));
    expect(screen.queryByTestId('copy-warnings')).not.toBeInTheDocument();
  });

  it('marks a row whose outlet type no longer exists in the tenant master (survives reload)', async () => {
    listByMonth[CUR] = [tile({ id: 'x', outletTypeCodes: ['GONE_TYPE'] })];
    renderPage();
    const row = await screen.findByTestId('offer-row');
    expect(await within(row).findByTestId('row-unknown-types')).toBeInTheDocument();
  });

  it('no copy warnings panel when the copy reports none', async () => {
    listByMonth[PREV] = [tile({ id: 'p1', validFrom: `${PREV}-01`, validTo: monthBounds(PREV).last })];
    post.mockResolvedValue({ success: true, data: { created: 1, skipped: 0, kpiCleared: [], unknownOutletTypes: [], tiles: [] } });
    renderPage();
    await screen.findByTestId('offer-row');
    fireEvent.click(screen.getByTestId('copy-month-btn'));
    const modal = await screen.findByTestId('copy-modal');
    await within(modal).findByText(/Copy 1 tile/);
    fireEvent.click(within(modal).getByTestId('confirm-copy'));
    expect(await screen.findByText('Created 1, skipped 0 (already copied)')).toBeInTheDocument();
    expect(screen.queryByTestId('copy-warnings')).not.toBeInTheDocument();
  });
});
