/// <reference types="vitest/globals" />
/**
 * Sales-assisted PHYSICAL-gift redeem — delivery address (PLATFORM-WIDE, owner-approved).
 *
 * Bug: the rep's redeem-for-outlet POST carried no `deliveryAddress`, so the backend 400'd every
 * physical gift. The confirm step now captures the address, pre-filled from the TARGET outlet's
 * address on file (GET /sales/outlets `deliveryDefaults`, junk-cleaned server-side by the shared
 * pickDeliveryDefaults), editable, never overwriting what the rep typed — the partner flow's rules.
 * Vouchers / cash are unchanged (no form, no deliveryAddress).
 *
 * Run: npx vitest run src/app/sales/catalogue/__tests__/catalogue-delivery-address.test.tsx
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import CataloguePage from '../page';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}));

const PHYSICAL_ITEM = {
  id: 'gift-1', name: 'JBL Speaker', pointsCost: 2500, description: 'A speaker',
  imageUrls: null, status: 'ACTIVE', stockQuantity: null, redemptionMode: 'PHYSICAL_GIFT',
  minRedemptionPoints: null, maxRedemptionPoints: null,
};
const VOUCHER_ITEM = {
  id: 'vch-1', name: 'Amazon 500', pointsCost: 500, description: 'A voucher',
  imageUrls: null, status: 'ACTIVE', stockQuantity: null, redemptionMode: 'GIFT_CARD',
  minRedemptionPoints: null, maxRedemptionPoints: null,
};

const FULL_DEFAULTS = { line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' };

function outletRow(over: Record<string, unknown> = {}) {
  return {
    id: 'o1', partnerId: 'p1', kycId: 'k1', name: 'Shop One', mobile: '9830011252', balance: 50000,
    ownerName: 'Asha Patil', deliveryDefaults: FULL_DEFAULTS, ...over,
  };
}

/** Route fetch: catalog, outlets, and capture the redeem-for-outlet POST body. */
function mockFetch(items: unknown[], outlet: Record<string, unknown>) {
  const posts: Record<string, unknown>[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
    if (url.includes('/api/rewards/redeem-for-outlet')) {
      posts.push(JSON.parse(String(init?.body ?? '{}')));
      return ok({ orderId: 'ord-1', orderNumber: 'BAJ-26-000001' });
    }
    if (url.includes('/api/rewards/catalog')) return ok({ items });
    if (url.includes('/api/sales/outlets')) return ok({ outlets: [outlet] });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posts };
}

/** Open the gift, pick the outlet → the confirm step. */
async function openConfirm(giftName: RegExp) {
  render(<CataloguePage />);
  fireEvent.click(await screen.findByRole('button', { name: giftName }));
  fireEvent.click(screen.getByRole('button', { name: /^Redeem for/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Shop One/ }));
  await screen.findByText('Confirm Redemption');
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const sendOtp = () => fireEvent.click(screen.getByRole('button', { name: /Send OTP/ }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('sales catalogue — physical-gift delivery address', () => {
  it('pre-fills the form from the TARGET outlet\'s address on file and shows the source hint', async () => {
    mockFetch([PHYSICAL_ITEM], outletRow());
    await openConfirm(/JBL Speaker/);

    expect(field('Recipient name *').value).toBe('Asha Patil');
    expect(field('Street address *').value).toBe('12 MG Road');
    expect(field('City *').value).toBe('Pune');
    expect(field('State').value).toBe('Maharashtra');
    expect(field('Pincode *').value).toBe('411001');
    expect(screen.getByText('From the outlet address')).toBeInTheDocument();
  });

  it('sends deliveryAddress (with the outlet mobile) in the redeem-for-outlet body', async () => {
    const { posts } = mockFetch([PHYSICAL_ITEM], outletRow());
    await openConfirm(/JBL Speaker/);
    sendOtp();

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      rewardId: 'gift-1',
      targetPartnerId: 'p1',
      deliveryAddress: {
        name: 'Asha Patil', mobile: '9830011252',
        address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
      },
    });
    expect(await screen.findByText('OTP Verification')).toBeInTheDocument();
  });

  it('junk on file (server-nulled street/pincode) stays EMPTY and blocks the POST until the rep fills it', async () => {
    // pickDeliveryDefaults turns '-' / 'NA' / '0' into null server-side; a malformed value is ignored.
    const { posts } = mockFetch([PHYSICAL_ITEM], outletRow({
      deliveryDefaults: { line1: null, city: 'Pune', state: null, pincode: null },
    }));
    await openConfirm(/JBL Speaker/);

    expect(field('Street address *').value).toBe('');
    expect(field('Pincode *').value).toBe('');
    expect(field('City *').value).toBe('Pune');

    sendOtp();
    expect(await screen.findByText('Please fill in all required address fields')).toBeInTheDocument();
    expect(posts).toHaveLength(0);

    fireEvent.change(field('Street address *'), { target: { value: 'Shop 4, Station Rd' } });
    fireEvent.change(field('Pincode *'), { target: { value: '411002' } });
    sendOtp();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].deliveryAddress).toMatchObject({
      address: 'Shop 4, Station Rd', city: 'Pune', state: 'Pune', pincode: '411002',
    });
  });

  it('a malformed / absent deliveryDefaults renders an empty working form with no hint', async () => {
    mockFetch([PHYSICAL_ITEM], outletRow({ deliveryDefaults: '-', ownerName: undefined }));
    await openConfirm(/JBL Speaker/);

    for (const l of ['Recipient name *', 'Street address *', 'City *', 'State', 'Pincode *']) {
      expect(field(l).value).toBe('');
    }
    expect(screen.queryByText('From the outlet address')).not.toBeInTheDocument();
  });

  it('never overwrites what the rep typed or deliberately cleared', async () => {
    const { posts } = mockFetch([PHYSICAL_ITEM], outletRow());
    await openConfirm(/JBL Speaker/);

    fireEvent.change(field('City *'), { target: { value: 'Nashik' } });
    fireEvent.change(field('State'), { target: { value: '' } }); // deliberate clear
    fireEvent.change(field('Recipient name *'), { target: { value: 'Ravi Patil' } });

    expect(field('City *').value).toBe('Nashik');
    expect(field('State').value).toBe('');
    expect(field('Street address *').value).toBe('12 MG Road'); // untouched → still pre-filled

    sendOtp();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].deliveryAddress).toEqual({
      name: 'Ravi Patil', mobile: '9830011252',
      address: '12 MG Road', city: 'Nashik', state: 'Nashik', pincode: '411001',
    });
  });

  it('rejects an impossible pincode without calling the backend', async () => {
    const { posts } = mockFetch([PHYSICAL_ITEM], outletRow());
    await openConfirm(/JBL Speaker/);
    fireEvent.change(field('Pincode *'), { target: { value: '011001' } });
    sendOtp();
    expect(await screen.findByText('Enter a valid 6-digit pincode')).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it('voucher path is unchanged: no address form and no deliveryAddress in the body', async () => {
    const { posts } = mockFetch([VOUCHER_ITEM], outletRow());
    await openConfirm(/Amazon 500/);

    expect(screen.queryByTestId('delivery-address-form')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Street address *')).not.toBeInTheDocument();

    sendOtp();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ rewardId: 'vch-1', targetPartnerId: 'p1' });
  });
});
