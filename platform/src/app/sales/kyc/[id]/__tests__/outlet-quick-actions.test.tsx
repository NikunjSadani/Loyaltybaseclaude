/// <reference types="vitest/globals" />
/**
 * TDD — Outlet detail quick actions (Deoleo tenant config)
 *
 * AD1: Ledger quick action shows tenant-configured label ("Wallet") instead of default
 * AD2: Ledger quick action shows default "View Points Ledger" when no custom label set
 * AD3: "Redeem Gift for Outlet" is shown for a WHOLESALER outlet when redeemGiftWholesalerOnly=true
 * AD4: "Redeem Gift for Outlet" is hidden for a RETAILER outlet when redeemGiftWholesalerOnly=true
 * AD5: Past Performance section is present and shows monthly bar data for the outlet
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import SalesKYCDetailPage from '../page';

const SETTINGS_KEY = 'gifsy_settings_v1';

async function renderKyc(id: string) {
  const params = Promise.resolve({ id });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
  // k1 = Kumar General Store (RETAILER), k4 = Singh Supermart (WHOLESALER)
  const firmNames: Record<string, string> = {
    k1: 'Kumar General Store',
    k4: 'Singh Supermart',
  };
  await waitFor(
    () => expect(screen.getByText(firmNames[id] ?? id)).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('AD — Outlet quick actions tenant config', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('AD1: shows custom ledger label "Wallet" when salesApp.ledgerLabel is configured', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      salesApp: { ledgerLabel: 'Wallet' },
    }));
    await renderKyc('k1');
    expect(screen.getByText('Wallet')).toBeInTheDocument();
    expect(screen.queryByText('View Points Ledger')).not.toBeInTheDocument();
  });

  it('AD2: shows default "View Points Ledger" when salesApp has no custom label (non-Deoleo tenant)', async () => {
    // Simulate a tenant that has no ledgerLabel override (salesApp: {} clears the Deoleo default)
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ salesApp: {} }));
    await renderKyc('k1');
    expect(screen.getByText('View Points Ledger')).toBeInTheDocument();
    expect(screen.queryByText('Wallet')).not.toBeInTheDocument();
  });

  it('AD3: "Redeem Gift for Outlet" is shown for a WHOLESALER outlet', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      salesApp: { redeemGiftWholesalerOnly: true },
    }));
    await renderKyc('k4'); // Singh Supermart = WHOLESALER
    expect(screen.getByText('Redeem Gift for Outlet')).toBeInTheDocument();
  });

  it('AD4: "Redeem Gift for Outlet" is hidden for a RETAILER outlet when redeemGiftWholesalerOnly=true', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      salesApp: { redeemGiftWholesalerOnly: true },
    }));
    await renderKyc('k1'); // Kumar General Store = RETAILER
    expect(screen.queryByText('Redeem Gift for Outlet')).not.toBeInTheDocument();
  });

  it('AD5: past performance section is shown with month labels and achievement bars', async () => {
    await renderKyc('k1');
    expect(screen.getByTestId('past-performance')).toBeInTheDocument();
    // Should show at least one month label
    const section = screen.getByTestId('past-performance');
    expect(section.querySelectorAll('[data-testid="perf-month-bar"]').length).toBeGreaterThanOrEqual(1);
  });
});
