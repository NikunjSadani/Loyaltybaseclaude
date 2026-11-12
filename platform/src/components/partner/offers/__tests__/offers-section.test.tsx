/// <reference types="vitest/globals" />
/**
 * "This month's offers" partner section (OFFER-TILES-PLAN F2): self-hiding, hydration-safe first
 * render, grouping + 2-col grid, value-first tile, KPI progress / Unlocked, the detail sheet and
 * the D5 brand disclaimer.
 * Run: npx vitest run src/components/partner/offers/__tests__/offers-section.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { OfferTilePartner } from '@/lib/offers';

const fetchPartnerOffers = vi.fn();
vi.mock('@/lib/offers', async (orig) => {
  const actual = await orig<typeof import('@/lib/offers')>();
  return { ...actual, fetchPartnerOffers: () => fetchPartnerOffers() };
});

const brandRef = { current: 'Bajaj Consumer Care' };
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ branding: { displayName: brandRef.current } }),
}));

import { OffersSection } from '../offers-section';

const BRAND_TEXT = 'text-[color:color-mix(in_srgb,var(--brand-primary,#16a34a)_40%,black)]';

const T1: OfferTilePartner = {
  id: 't1', group: 'TARGET_REWARD', valueType: 'POINTS', valueNumber: 35, valueText: null,
  unitLabel: 'per case', product: 'ADHO 50 ml', label: 'Earn on every case',
  details: 'Valid on billed cases only.', validTo: '2026-11-30',
  progress: { kpiCode: 'ADHO50', kpiName: 'ADHO 50 ml', unit: 'cases', target: 200, achieved: 120, pct: 60, unlocked: false },
};
const T2: OfferTilePartner = {
  id: 't2', group: 'EXTRA_SCHEME', valueType: 'PERCENT', valueNumber: 2.5, valueText: null,
  unitLabel: 'extra margin', product: 'Olive Pomace 1 L', label: 'Festive bonus', details: null,
  validTo: '2026-11-30', progress: null,
};
const T3: OfferTilePartner = {
  id: 't3', group: 'TARGET_REWARD', valueType: 'TEXT', valueNumber: null, valueText: 'Free kit',
  unitLabel: null, product: 'Pomace 5 L', label: 'Hit the target, get a kit', details: null,
  validTo: '2026-11-30',
  progress: { kpiCode: 'P5', kpiName: 'Pomace 5 L', unit: 'cases', target: 50, achieved: 55, pct: 110, unlocked: true },
};

beforeEach(() => {
  fetchPartnerOffers.mockReset();
  brandRef.current = 'Bajaj Consumer Care';
});

describe('OffersSection', () => {
  it('renders nothing when the API returns no tiles', async () => {
    fetchPartnerOffers.mockResolvedValue([]);
    const { container } = render(<OffersSection />);
    await waitFor(() => expect(fetchPartnerOffers).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing (and no error text) when the fetch rejects', async () => {
    fetchPartnerOffers.mockRejectedValue(new Error('boom'));
    const { container } = render(<OffersSection />);
    await waitFor(() => expect(fetchPartnerOffers).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/boom/i)).not.toBeInTheDocument();
  });

  it('first render is empty before any data (hydration guard)', async () => {
    fetchPartnerOffers.mockResolvedValue([T1, T2]);
    const { container } = render(<OffersSection />);
    expect(container.innerHTML).toBe('');
    expect(await screen.findByTestId('offers-section')).toBeInTheDocument();
  });

  it('renders heading, both groups in order, a 2-col grid, value first then product + label', async () => {
    fetchPartnerOffers.mockResolvedValue([T2, T1, T3]);
    render(<OffersSection />);
    const section = await screen.findByTestId('offers-section');
    expect(within(section).getByText("This month's offers")).toBeInTheDocument();

    const g1 = screen.getByText('Earn on your targets');
    const g2 = screen.getByText('Extra schemes this month');
    expect(g1.compareDocumentPosition(g2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const grid = screen.getByTestId('offers-grid-TARGET_REWARD');
    expect(grid.className).toContain('grid-cols-2');
    expect(within(grid).getAllByTestId('offer-tile')).toHaveLength(2);

    const tile = within(grid).getAllByTestId('offer-tile')[0];
    const value = within(tile).getByText('+35 pts');
    const product = within(tile).getByText('ADHO 50 ml');
    const label = within(tile).getByText('Earn on every case');
    expect(value.compareDocumentPosition(product) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(product.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByTestId('offers-grid-EXTRA_SCHEME')).getByText('+2.5%')).toBeInTheDocument();
    expect(within(grid).getByText('Free kit')).toBeInTheDocument();
  });

  it('KPI progress: bar with aria-valuenow, "Unlocked" at ≥100%, no bar without a target', async () => {
    const noTarget: OfferTilePartner = {
      ...T1, id: 't4', label: 'No target tile',
      progress: { ...T1.progress!, target: null, achieved: 3, pct: null, unlocked: false },
    };
    fetchPartnerOffers.mockResolvedValue([T1, T3, noTarget]);
    render(<OffersSection />);
    await screen.findByTestId('offers-section');
    const tiles = screen.getAllByTestId('offer-tile');

    const bar1 = within(tiles[0]).getByRole('progressbar');
    expect(bar1).toHaveAttribute('aria-valuenow', '60');
    expect(within(tiles[0]).getByText('60%')).toBeInTheDocument();
    expect(within(tiles[0]).queryByText('Unlocked')).not.toBeInTheDocument();

    expect(within(tiles[1]).getByText('Unlocked')).toBeInTheDocument();
    // pct 110 is clamped for aria (0–100).
    expect(within(tiles[1]).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(within(tiles[2]).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('never a full bar without "Unlocked": pct rounds to 100 but API says locked ⇒ 99, no pill', async () => {
    const almost: OfferTilePartner = {
      ...T1, id: 't5', label: 'Almost there',
      progress: { ...T1.progress!, achieved: 199, pct: 100, unlocked: false },
    };
    fetchPartnerOffers.mockResolvedValue([almost]);
    render(<OffersSection />);
    const tile = (await screen.findAllByTestId('offer-tile'))[0];
    const bar = within(tile).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '99');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('99%');
    expect(within(tile).queryByText('Unlocked')).not.toBeInTheDocument();
  });

  it('tile button has a concise aria-label: headline + value + unit + progress', async () => {
    fetchPartnerOffers.mockResolvedValue([T1, T3]);
    render(<OffersSection />);
    await screen.findByTestId('offers-section');
    expect(screen.getByRole('button', { name: 'Earn on every case, +35 pts per case, ADHO 50 ml, 60% of target' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hit the target, get a kit, Free kit, Pomace 5 L, Unlocked' }))
      .toBeInTheDocument();
  });

  it('narrow layout: the value never truncates; the unit label sits on its own (truncating) line', async () => {
    fetchPartnerOffers.mockResolvedValue([{ ...T1, valueNumber: 9999999 }]);
    render(<OffersSection />);
    const tile = (await screen.findAllByTestId('offer-tile'))[0];
    const value = within(tile).getByTestId('offer-tile-value');
    expect(value).toHaveTextContent('+99,99,999 pts');
    expect(value.className).not.toContain('truncate');
    expect(value.className).toContain('text-xl');
    expect(value).not.toContainElement(within(tile).getByTestId('offer-tile-unit'));
    expect(within(tile).getByTestId('offer-tile-unit').className).toContain('truncate');
  });

  it('small print meets contrast: ≥ 12px, gray-600 off-tile, group tone on-tile (Valid till, per-tile till, footer)', async () => {
    fetchPartnerOffers.mockResolvedValue([T1, T2]);
    const { unmount } = render(<OffersSection />);
    const vt = await screen.findByTestId('offers-valid-till');
    expect(vt.className).toContain('text-gray-600');
    expect(vt.className).toContain('text-xs');
    fireEvent.click(screen.getByText('Festive bonus').closest('button')!);
    const footer = within(await screen.findByRole('dialog')).getByTestId('offer-sheet-footer');
    expect(footer.className).toContain('text-gray-600');
    expect(footer.className).toContain('text-xs');
    unmount();

    fetchPartnerOffers.mockResolvedValue([T1, { ...T2, validTo: '2026-11-15' }]);
    render(<OffersSection />);
    // On-tile "till" uses the group's secondary tone: amber-800 on amber-50 (6.8:1), and the
    // derived brand dark shade on the brand tint (≥ 5.7:1 for any brand colour).
    const till = await screen.findByText('till 15 Nov');
    expect(till.className).toContain('text-amber-800');
    expect(till.className).toContain('text-xs');
    const tillBrand = screen.getByText('till 30 Nov');
    expect(tillBrand.className).toContain(BRAND_TEXT);
    expect(tillBrand.className).toContain('text-xs');
  });

  it('group colours: TARGET_REWARD = brand tint + brand dark text; EXTRA_SCHEME = amber tint', async () => {
    fetchPartnerOffers.mockResolvedValue([T1, T2]);
    render(<OffersSection />);
    await screen.findByTestId('offers-section');

    const target = within(screen.getByTestId('offers-grid-TARGET_REWARD')).getByTestId('offer-tile');
    expect(target).toHaveAttribute('data-group', 'TARGET_REWARD');
    expect(target.className).toContain('bg-[var(--brand-primary-light,#ecf8f0)]');
    expect(target.className).toContain('border-[color:color-mix(in_srgb,var(--brand-primary,#16a34a)_25%,white)]');
    expect(target.className).not.toContain('bg-white');
    expect(target.className).not.toMatch(/amber/);
    for (const id of ['offer-tile-value', 'offer-tile-unit', 'offer-tile-product', 'offer-tile-label', 'offer-tile-pct']) {
      expect(within(target).getByTestId(id).className).toContain(BRAND_TEXT);
    }
    // No hardcoded tenant colour anywhere on the brand tile.
    expect(target.outerHTML).not.toMatch(/#[0-9a-f]{6}(?!\)|\])/i);

    const extra = within(screen.getByTestId('offers-grid-EXTRA_SCHEME')).getByTestId('offer-tile');
    expect(extra).toHaveAttribute('data-group', 'EXTRA_SCHEME');
    expect(extra.className).toContain('bg-amber-50');
    expect(extra.className).toContain('border-amber-200');
    expect(extra.className).not.toContain('bg-white');
    expect(within(extra).getByTestId('offer-tile-value').className).toContain('text-amber-900');
    expect(within(extra).getByTestId('offer-tile-product').className).toContain('text-amber-900');
    expect(within(extra).getByTestId('offer-tile-unit').className).toContain('text-amber-800');
    expect(within(extra).getByTestId('offer-tile-label').className).toContain('text-amber-800');
    expect(extra.className).not.toContain('brand-primary-light');
  });

  it('progress bar + Unlocked pill keep contrast on tinted tiles: white track, -700 fills, ringed pill', async () => {
    const at85: OfferTilePartner = { ...T1, id: 't6', progress: { ...T1.progress!, achieved: 170, pct: 85 } };
    fetchPartnerOffers.mockResolvedValue([T1, T3, at85, { ...T2, id: 't7', progress: T1.progress }]);
    render(<OffersSection />);
    await screen.findByTestId('offers-section');
    const tiles = screen.getAllByTestId('offer-tile');
    const bar = (t: HTMLElement) => within(t).getByRole('progressbar');
    const fill = (t: HTMLElement) => within(t).getByTestId('offer-tile-bar-fill');

    for (const t of tiles) expect(bar(t).className).toContain('bg-white');
    expect(fill(tiles[0]).className).toContain('bg-orange-700'); // 60%
    expect(fill(tiles[1]).className).toContain('bg-emerald-700'); // unlocked
    expect(fill(tiles[2]).className).toContain('bg-amber-700');  // 85%
    expect(fill(tiles[3]).className).toContain('bg-orange-700'); // EXTRA_SCHEME tile, 60%
    for (const t of tiles) expect(fill(t).className).not.toMatch(/-(400|500)\b/);
    expect(within(tiles[3]).getByTestId('offer-tile-pct').className).toContain('text-amber-800');

    const pill = within(tiles[1]).getByTestId('offer-tile-unlocked');
    expect(pill.className).toContain('bg-emerald-50');
    expect(pill.className).toContain('text-emerald-700');
    expect(pill.className).toContain('ring-emerald-200');
    expect(pill.className).toContain('text-xs');
  });

  it('detail sheet stays white; the value carries the group accent colour', async () => {
    fetchPartnerOffers.mockResolvedValue([T1, T2]);
    render(<OffersSection />);
    await screen.findByTestId('offers-section');
    fireEvent.click(screen.getByText('Earn on every case').closest('button')!);
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('offer-sheet-value').className).toContain('text-[var(--brand-primary)]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText('Festive bonus').closest('button')!);
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('offer-sheet-value').className).toContain('text-amber-700');
    expect(within(dialog).getByTestId('offer-sheet').className).not.toMatch(/bg-amber|brand-primary-light/);
  });

  it('tapping a tile opens the sheet with details + Valid till + brand footer; close works', async () => {
    fetchPartnerOffers.mockResolvedValue([T1, T2]);
    render(<OffersSection />);
    await screen.findByTestId('offers-section');
    fireEvent.click(screen.getByText('Earn on every case').closest('button')!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('+35 pts')).toBeInTheDocument();
    expect(within(dialog).getByText('ADHO 50 ml')).toBeInTheDocument();
    expect(within(dialog).getByText('Details')).toBeInTheDocument();
    expect(within(dialog).getByText('Valid on billed cases only.')).toBeInTheDocument();
    expect(within(dialog).getByText('Valid till 30 Nov 2026')).toBeInTheDocument();
    expect(within(dialog).getByText(/120 \/ 200 cases · 60%/)).toBeInTheDocument();
    expect(within(dialog).getByTestId('offer-sheet-footer')).toHaveTextContent(
      'Offer details are shared by Bajaj Consumer Care. Terms apply.',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // A tile with no details shows no "Details" heading.
    fireEvent.click(screen.getByText('Festive bonus').closest('button')!);
    const d2 = await screen.findByRole('dialog');
    expect(within(d2).queryByText('Details')).not.toBeInTheDocument();
  });

  it('footer falls back to "your brand" when the tenant name is the neutral placeholder', async () => {
    brandRef.current = 'LoyaltyBase';
    fetchPartnerOffers.mockResolvedValue([T2]);
    render(<OffersSection />);
    await screen.findByTestId('offers-section');
    fireEvent.click(screen.getByText('Festive bonus').closest('button')!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('offer-sheet-footer')).toHaveTextContent(
      'Offer details are shared by your brand. Terms apply.',
    );
  });

  it('header "Valid till" only when all tiles share validTo; otherwise per-tile "till"', async () => {
    fetchPartnerOffers.mockResolvedValue([T1, T2]);
    const { unmount } = render(<OffersSection />);
    expect(await screen.findByTestId('offers-valid-till')).toHaveTextContent('Valid till 30 Nov 2026');
    expect(screen.queryByText(/^till /)).not.toBeInTheDocument();
    unmount();

    fetchPartnerOffers.mockResolvedValue([T1, { ...T2, validTo: '2026-11-15' }]);
    render(<OffersSection />);
    await screen.findByTestId('offers-section');
    expect(screen.queryByTestId('offers-valid-till')).not.toBeInTheDocument();
    expect(screen.getByText('till 15 Nov')).toBeInTheDocument();
    expect(screen.getByText('till 30 Nov')).toBeInTheDocument();
  });
});
