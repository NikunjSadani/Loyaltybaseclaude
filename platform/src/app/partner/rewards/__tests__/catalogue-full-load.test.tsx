/// <reference types="vitest/globals" />
/**
 * CFL — the partner Rewards page loads the WHOLE catalogue (every API page, 200 per page) and a failed
 * load is shown as an error with Retry — never as "No items found".
 * Regression (2026-11-27, Bajaj prod): the page called /api/rewards/catalog with no limit → API default 20,
 * ordered by points cost → the 20 zero-cost "choose an amount" vouchers hid every physical gift.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Kumar Store', ownerName: 'Rajesh', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false, loyaltyEnabled: true,
  }),
}));
vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({
    pointsConversionRate: 1, minBankTransferAmount: 250, minVoucherFreeAmount: 250,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
  }),
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), toast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import RewardsPage from '../page';

const phys = (i: number) => ({
  id: `g${i}`, name: `Gift ${i}`, brand: 'B', category: 'Kitchen', pointsCost: 500 + i,
  redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true,
});
const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });

function stub(catalog: (page: number, call: number) => Promise<unknown>) {
  let calls = 0;
  const f = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/rewards/catalog')) {
      const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? '1');
      return catalog(page, ++calls);
    }
    if (url.includes('/api/partner/me')) return ok({ features: { catalogueMrpSlash: false } });
    return ok({});
  });
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('CFL — partner catalogue loads every page; failures are loud', () => {
  it('CFL1: requests 200 per page and shows items from BOTH pages', async () => {
    const f = stub((page) => ok(page === 1
      ? { items: [phys(1), phys(2)], userBalance: 1000, pagination: { page: 1, limit: 200, total: 3, pages: 2 } }
      : { items: [phys(3)], userBalance: 1000, pagination: { page: 2, limit: 200, total: 3, pages: 2 } }));
    render(<RewardsPage />);
    expect(await screen.findByText('Gift 1')).toBeInTheDocument();
    expect(await screen.findByText('Gift 3')).toBeInTheDocument();
    const urls = f.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/rewards/catalog'));
    expect(urls).toEqual(['/api/rewards/catalog?page=1&limit=200', '/api/rewards/catalog?page=2&limit=200']);
  });

  it('CFL2: a failed load says so with Retry (not "No items found"); Retry loads the catalogue', async () => {
    stub((_page, call) => call === 1
      ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'boom' }) })
      : ok({ items: [phys(7)], userBalance: 1000, pagination: { page: 1, limit: 200, total: 1, pages: 1 } }));
    render(<RewardsPage />);
    const alert = await screen.findByTestId('catalogue-load-error');
    expect(alert).toHaveTextContent("Couldn't load the rewards");
    expect(screen.queryByText('No items found')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Gift 7')).toBeInTheDocument();
    expect(screen.queryByTestId('catalogue-load-error')).not.toBeInTheDocument();
  });
});
