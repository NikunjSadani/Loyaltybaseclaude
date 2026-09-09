/// <reference types="vitest/globals" />
/**
 * RFO — Sales outlet-detail "Redeem for Outlet" action
 *
 * The XSR redeems reward points on behalf of an outlet. Owner decision: the action
 * appears ONLY on the outlet-detail view (this page, reached by tapping an outlet),
 * surfaced PROMINENTLY — not on the outlet list, not as a bottom-nav tab.
 *
 * The gate is now the PER-OUTLET-TYPE "Sales-Assisted Redemption" setting
 * (OutletTypeClientConfig.salesAssistedRedeemEnabled), computed by the backend and delivered
 * on the KYC detail as `submission.salesRedeemEnabled` — settings-driven per outlet type, NOT
 * hardcoded to a role. (The backend redeemForOutlet/confirmRedeemForOutlet enforce the same flag.)
 *
 * RFO1: an APPROVED outlet whose type has redemption ENABLED shows a prominent
 *       "Redeem for Outlet" button linking to /sales/catalogue?outletId=<id>
 * RFO2: enablement is independent of the outlet TYPE label (a non-wholesaler with the
 *       flag on still shows it) — proves nothing is hardcoded to WHOLESALER
 * RFO3: an outlet whose type has redemption DISABLED hides the action
 * RFO4: the action is rendered once (prominent button) — not duplicated as a Quick-Action row
 */

import React, { Suspense, act } from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { GifsySettings } from '@/types';
import { DEFAULT_SETTINGS } from '@/lib/gifsy-settings';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// The page reads the sales role from localStorage via getRole(); pin it to XSR.
vi.mock('@/lib/sales-role', () => ({ getRole: () => 'XSR' }));

// useGifsySettings is still consumed by the page (other cards); pin it to defaults.
let mockSettings: GifsySettings = DEFAULT_SETTINGS;
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@/lib/gifsy-settings');
  return { ...actual, useGifsySettings: () => mockSettings };
});

import SalesKYCDetailPage from '../page';

/**
 * A KYC submission whose enrolled outlet has a given outletType.code and the backend-computed
 * `salesRedeemEnabled` flag (the gate input).
 */
function submission(outletTypeCode: string, salesRedeemEnabled: boolean) {
  return {
    id: 'KYC42',
    status: 'APPROVED',
    submittedAt: '2026-05-01T00:00:00.000Z',
    rejectionReason: null,
    salesRedeemEnabled,
    user: { id: 'u1', name: 'Anil XSR', phone: '9900000011', role: 'SALES_XSR' },
    partner: {
      id: 'p1',
      businessName: 'Mehta Distributors',
      ownerName: 'Mehta',
      address: '12 Market Rd',
      city: 'Pune',
      state: 'Maharashtra',
      outlets: [{
        id: 'OUT9', name: 'Mehta Distributors', outletCode: 'W123', phone: '9900000011',
        addressLine1: '12 Market Rd', city: 'Pune', state: 'Maharashtra', pincode: '411001',
        outletType: { code: outletTypeCode },
      }],
    },
    documents: [],
    statusHistory: [],
  };
}

function stubFetch(outletTypeCode: string, salesRedeemEnabled: boolean) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { submission: submission(outletTypeCode, salesRedeemEnabled) } }),
  }));
}

// The page reads its route id via React `use(params)`, which SUSPENDS on the promise —
// so the render must sit under a Suspense boundary inside an awaited act(), matching the
// proven pattern in kyc-detail-api.test.tsx. Without it the component never mounts.
async function renderPage(id: string) {
  const params = Promise.resolve({ id });
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
  return result;
}

beforeEach(() => { mockSettings = DEFAULT_SETTINGS; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('RFO — sales outlet-detail Redeem for Outlet', () => {
  it('RFO1: an outlet whose type has redemption ENABLED shows a prominent redeem button to the catalogue', async () => {
    stubFetch('WHOLESALER', true);
    await renderPage('KYC42');

    const action = await screen.findByTestId('redeem-for-outlet');
    expect(action).toHaveAttribute('href', '/sales/catalogue?outletId=KYC42');
    expect(action).toHaveTextContent(/Redeem for Outlet/i);
  });

  it('RFO2: enablement is per-type, not hardcoded — a NON-wholesaler with the flag ON still shows redeem', async () => {
    stubFetch('SSS', true);
    await renderPage('KYC42');

    const action = await screen.findByTestId('redeem-for-outlet');
    expect(action).toHaveAttribute('href', '/sales/catalogue?outletId=KYC42');
  });

  it('RFO3: an outlet whose type has redemption DISABLED hides the action', async () => {
    stubFetch('SSS', false);
    await renderPage('KYC42');

    // Wait for the page to hydrate (the outlet/firm name renders post-fetch).
    await screen.findAllByText('Mehta Distributors');
    expect(screen.queryByTestId('redeem-for-outlet')).toBeNull();
  });

  it('RFO4: the redeem action renders exactly once (prominent button, not also a Quick-Action row)', async () => {
    stubFetch('WHOLESALER', true);
    const { container } = await renderPage('KYC42');

    await screen.findByTestId('redeem-for-outlet');
    const catalogueLinks = container.querySelectorAll('a[href="/sales/catalogue?outletId=KYC42"]');
    expect(catalogueLinks.length).toBe(1);
  });
});
