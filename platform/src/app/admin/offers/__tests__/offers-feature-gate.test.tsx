/// <reference types="vitest/globals" />
/**
 * /admin/offers route gate (D1): the page renders only when the tenant's `offerTiles` flag is ON;
 * a direct URL on a flag-OFF tenant (or an un-assumed Gifsy admin) shows the not-enabled notice.
 * Run: npx vitest run src/app/admin/offers/__tests__/offers-feature-gate.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const state: { features: Record<string, unknown>; loading: boolean } = { features: {}, loading: false };
vi.mock('@/lib/tenant-features', async (orig) => {
  const actual = await orig<typeof import('@/lib/tenant-features')>();
  return { ...actual, useTenantFeatures: () => ({ features: actual.normalizeFeatures(state.features), loading: state.loading }) };
});

import { OffersFeatureGate } from '../_components/offers-feature-gate';

describe('OffersFeatureGate', () => {
  it('shows a spinner while the tenant features load (never flashes the page)', () => {
    state.loading = true; state.features = { offerTiles: true };
    render(<OffersFeatureGate><p>PAGE</p></OffersFeatureGate>);
    expect(screen.getByTestId('offers-gate-loading')).toBeInTheDocument();
    expect(screen.queryByText('PAGE')).not.toBeInTheDocument();
  });

  it('blocks the page when offerTiles is OFF', () => {
    state.loading = false; state.features = {};
    render(<OffersFeatureGate><p>PAGE</p></OffersFeatureGate>);
    expect(screen.getByTestId('offers-disabled')).toBeInTheDocument();
    expect(screen.queryByText('PAGE')).not.toBeInTheDocument();
  });

  it('renders the page when offerTiles is ON', () => {
    state.loading = false; state.features = { offerTiles: true };
    render(<OffersFeatureGate><p>PAGE</p></OffersFeatureGate>);
    expect(screen.getByText('PAGE')).toBeInTheDocument();
  });
});
