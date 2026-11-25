/// <reference types="vitest/globals" />
/**
 * /admin/offers route gate (D1): the page renders only when the tenant's `offerTiles` flag is ON;
 * a direct URL on a flag-OFF tenant (or an un-assumed Gifsy admin) shows the not-enabled notice;
 * a FAILED settings fetch shows "Couldn't load settings" + Retry (never "not enabled").
 * Run: npx vitest run src/app/admin/offers/__tests__/offers-feature-gate.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api-client', () => ({ authHeader: () => ({}) }));

import { OffersFeatureGate } from '../_components/offers-feature-gate';

const ok = (features: Record<string, unknown>) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { features } }) });

afterEach(() => vi.unstubAllGlobals());

describe('OffersFeatureGate', () => {
  it('shows a spinner while the tenant features load (never flashes the page)', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<OffersFeatureGate><p>PAGE</p></OffersFeatureGate>);
    expect(screen.getByTestId('offers-gate-loading')).toBeInTheDocument();
    expect(screen.queryByText('PAGE')).not.toBeInTheDocument();
  });

  it('blocks the page when offerTiles is OFF', async () => {
    const f = vi.fn(() => ok({}));
    vi.stubGlobal('fetch', f);
    render(<OffersFeatureGate><p>PAGE</p></OffersFeatureGate>);
    expect(await screen.findByTestId('offers-disabled')).toBeInTheDocument();
    expect(screen.queryByText('PAGE')).not.toBeInTheDocument();
    expect(f).toHaveBeenCalledWith('/api/admin/settings/features', expect.anything());
  });

  it('renders the page when offerTiles is ON', async () => {
    vi.stubGlobal('fetch', vi.fn(() => ok({ offerTiles: true })));
    render(<OffersFeatureGate><p>PAGE</p></OffersFeatureGate>);
    expect(await screen.findByText('PAGE')).toBeInTheDocument();
  });

  it.each([
    ['network error', () => Promise.reject(new Error('offline'))],
    ['HTTP 500', () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })],
    ['success:false body', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: false }) })],
  ])('%s ⇒ "Couldn\'t load settings" + Retry (not "not enabled"); retry recovers', async (_n, fail) => {
    const f = vi.fn().mockImplementationOnce(fail).mockImplementation(() => ok({ offerTiles: true }));
    vi.stubGlobal('fetch', f);
    render(<OffersFeatureGate><p>PAGE</p></OffersFeatureGate>);
    expect(await screen.findByTestId('offers-gate-error')).toHaveTextContent("Couldn't load settings");
    expect(screen.queryByTestId('offers-disabled')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('offers-gate-retry'));
    expect(await screen.findByText('PAGE')).toBeInTheDocument();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
