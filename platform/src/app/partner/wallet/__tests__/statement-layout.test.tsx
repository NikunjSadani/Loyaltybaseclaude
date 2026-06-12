/// <reference types="vitest/globals" />
/**
 * TDD — Statement header layout: controls row / KPI row separation
 *
 * The statement section header was congested with label, KPI dropdown,
 * Excel button and date picker all on one row.
 *
 * Desired layout (both tracks):
 *   Row 1 (controls): "STATEMENT · <period>"  |  Excel  |  <date picker>
 *   Row 2 (filters):  KPI dropdown (and for POINTS: earn/burn chips)
 *
 * V1: INR track — data-testid="statement-controls-row" is rendered
 * V2: INR track — KPI filter (wallet-kpi-filter) is NOT inside statement-controls-row
 * V3: INR track — Excel button IS inside statement-controls-row
 * V4: INR track — date/period button IS inside statement-controls-row
 * V5: INR track — KPI filter exists somewhere in the statement section
 * V6: POINTS track — KPI filter (wallet-kpi-filter) is NOT inside statement-controls-row
 * V7: POINTS track — data-testid="statement-controls-row" is rendered
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/redemption-store', () => ({
  loadRedemptions: () => [],
}));

import WalletPage from '../page';

const SESSION_KEY = 'partner_outlet_type_demo';

async function renderAndWait(outletType: string) {
  localStorage.setItem(SESSION_KEY, outletType);
  render(<WalletPage />);
  await waitFor(
    () => expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('V — Statement header layout', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── INR track (RETAILER) ──

  it('V1: INR track — statement-controls-row is rendered', async () => {
    await renderAndWait('SSS');
    expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument();
  });

  it('V2: INR track — KPI filter is NOT inside statement-controls-row', async () => {
    await renderAndWait('SSS');
    const controlsRow = screen.getByTestId('statement-controls-row');
    const kpiFilter   = screen.getByTestId('wallet-kpi-filter');
    expect(controlsRow.contains(kpiFilter)).toBe(false);
  });

  it('V3: INR track — Excel button is inside statement-controls-row', async () => {
    await renderAndWait('SSS');
    const controlsRow = screen.getByTestId('statement-controls-row');
    expect(controlsRow.querySelector('[data-testid="excel-btn"]')).not.toBeNull();
  });

  it('V4: INR track — date picker button is inside statement-controls-row', async () => {
    await renderAndWait('SSS');
    const controlsRow = screen.getByTestId('statement-controls-row');
    expect(controlsRow.querySelector('[data-testid="period-picker-btn"]')).not.toBeNull();
  });

  it('V5: INR track — KPI filter exists somewhere in the statement section', async () => {
    await renderAndWait('SSS');
    expect(screen.getByTestId('wallet-kpi-filter')).toBeInTheDocument();
  });

  // ── POINTS track (WHOLESALER) ──

  it('V6: POINTS track — statement-controls-row is rendered', async () => {
    await renderAndWait('WHOLESALER');
    expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument();
  });

  it('V7: POINTS track — KPI filter is NOT inside statement-controls-row', async () => {
    await renderAndWait('WHOLESALER');
    const controlsRow = screen.getByTestId('statement-controls-row');
    const kpiFilter   = screen.getByTestId('wallet-kpi-filter');
    expect(controlsRow.contains(kpiFilter)).toBe(false);
  });
});
