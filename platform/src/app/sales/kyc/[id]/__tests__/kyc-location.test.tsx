/// <reference types="vitest/globals" />
/**
 * SKGEO — Sales KYC detail: the KYC-captured geo (lat/long) on the review screen.
 *
 * The reviewer validates the outlet's location. The geo is captured during KYC and
 * lives on the submission (boardPhotoLat/Lng = where the store-board photo was shot;
 * paymentLat/Lng = where the cheque/UPI was captured), serialized as Decimal strings.
 *   SKGEO1: a Location row renders the store-board geo (lat, long), 6dp
 *   SKGEO2: falls back to the payment geo when the board geo is absent
 *   SKGEO3: no Location row when neither geo was captured (honest omission)
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import SalesKYCDetailPage from '../page';

const TEST_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function submission(geo: Record<string, unknown>) {
  return {
    id: TEST_UUID,
    status: 'PENDING_SO_APPROVAL',
    submittedAt: '2026-04-01T00:00:00.000Z',
    rejectionReason: null,
    user: { id: 'u1', name: 'Rep Ramesh', phone: '9000000003', role: 'SALES_SO' },
    partner: {
      id: 'p1', businessName: 'Verma Traders', ownerName: 'Suresh Verma',
      outlets: [{ id: 'o1', name: 'Verma Store', outletCode: 'OUT-2026-00111', phone: '9876543210',
        addressLine1: '12 Market Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' }],
    },
    documents: [],
    statusHistory: [],
    ...geo,
  };
}

function stubFetch(geo: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { submission: submission(geo) } }),
  }));
}

async function renderAndExpand() {
  const params = Promise.resolve({ id: TEST_UUID });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
  await waitFor(() => expect(screen.getByText('Verma Store')).toBeInTheDocument());
  fireEvent.click(screen.getByText(/store information/i));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('SKGEO — Sales KYC detail location (lat/long)', () => {
  it('SKGEO1: renders the store-board geo as a Location row (6dp)', async () => {
    // Decimal columns arrive as strings on the wire.
    stubFetch({ boardPhotoLat: '19.07600000', boardPhotoLng: '72.87770000' });
    await renderAndExpand();
    const row = await screen.findByTestId('kyc-store-location');
    expect(row).toHaveTextContent('Location (lat, long)');
    expect(row).toHaveTextContent('19.076000, 72.877700');
  });

  it('SKGEO2: falls back to the payment geo when the board geo is absent', async () => {
    stubFetch({ boardPhotoLat: null, boardPhotoLng: null, paymentLat: '28.61390000', paymentLng: '77.20900000' });
    await renderAndExpand();
    const row = await screen.findByTestId('kyc-store-location');
    expect(row).toHaveTextContent('28.613900, 77.209000');
  });

  it('SKGEO3: no Location row when neither geo was captured', async () => {
    stubFetch({ boardPhotoLat: null, boardPhotoLng: null, paymentLat: null, paymentLng: null });
    await renderAndExpand();
    await waitFor(() => expect(screen.getByText('Verma Store')).toBeInTheDocument());
    expect(screen.queryByTestId('kyc-store-location')).not.toBeInTheDocument();
  });
});
