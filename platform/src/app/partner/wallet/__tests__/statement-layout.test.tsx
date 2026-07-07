/// <reference types="vitest/globals" />
/**
 * TDD — Statement header layout: controls row / KPI row separation
 *
 * The wallet now renders ONE combined statement (points + payouts) below the
 * presence-based summary cards. The statement header layout is unchanged:
 *   Row 1 (controls): "STATEMENT · <period>"  |  Excel  |  <date picker>
 *   Row 2 (filters):  earn/burn chips + KPI dropdown
 *
 * V1: data-testid="statement-controls-row" is rendered
 * V2: KPI filter (wallet-kpi-filter) is NOT inside statement-controls-row
 * V3: Excel button IS inside statement-controls-row
 * V4: date/period button IS inside statement-controls-row
 * V5: KPI filter exists somewhere in the statement section
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// A BOTH-active partner exercises both summary cards + the combined statement.
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
    outletType: 'SSS', hasPointsActivity: true, hasPayoutActivity: true,
  }),
}));

import WalletPage from '../page';

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = url as string;
    if (u.includes('/api/wallet/transactions'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { transactions: [] } }) });
    if (u.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: [] } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

async function renderAndWait() {
  stubFetch();
  render(<WalletPage />);
  await waitFor(
    () => expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('V — Statement header layout (combined statement)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('V1: statement-controls-row is rendered', async () => {
    await renderAndWait();
    expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument();
  });

  it('V2: KPI filter is NOT inside statement-controls-row', async () => {
    await renderAndWait();
    const controlsRow = screen.getByTestId('statement-controls-row');
    const kpiFilter   = screen.getByTestId('wallet-kpi-filter');
    expect(controlsRow.contains(kpiFilter)).toBe(false);
  });

  it('V3: Excel button is inside statement-controls-row', async () => {
    await renderAndWait();
    const controlsRow = screen.getByTestId('statement-controls-row');
    expect(controlsRow.querySelector('[data-testid="excel-btn"]')).not.toBeNull();
  });

  it('V4: date picker button is inside statement-controls-row', async () => {
    await renderAndWait();
    const controlsRow = screen.getByTestId('statement-controls-row');
    expect(controlsRow.querySelector('[data-testid="period-picker-btn"]')).not.toBeNull();
  });

  it('V5: KPI filter exists somewhere in the statement section', async () => {
    await renderAndWait();
    expect(screen.getByTestId('wallet-kpi-filter')).toBeInTheDocument();
  });
});
