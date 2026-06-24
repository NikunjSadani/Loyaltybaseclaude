/// <reference types="vitest/globals" />
/**
 * SKDP — Sales KYC detail: real documents + photos (the senior reviewer's view)
 *
 * Regression for the owner-reported "senior sees blank PENDING docs + demo-mode
 * photos + a dead Tier chip". The page must render:
 *   SKDP1: each document with its human label (PAN Card, GST Certificate, …)
 *   SKDP2: a "View" link for documents that carry a signed viewUrl
 *   SKDP3: store/owner photos as image thumbnails (not a demo-mode placeholder)
 *   SKDP4: NO "demo mode" text and NO dead "Tier" chip
 *   SKDP5: an honest empty state when no documents/photos were uploaded
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

function submission(documents: unknown[]) {
  return {
    id: TEST_UUID,
    status: 'PENDING_SO_APPROVAL',
    submittedAt: '2026-04-01T00:00:00.000Z',
    rejectionReason: null,
    user: { id: 'u1', name: 'Rep Ramesh', phone: '9000000003', role: 'SALES_SO' },
    partner: {
      id: 'p1',
      businessName: 'Verma Traders',
      ownerName: 'Suresh Verma',
      gstNumber: '27AAPFU0939F1ZV',
      panNumber: 'AAPFU0939F',
      address: '12 Market Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      outlets: [{ id: 'o1', name: 'Verma Store', outletCode: 'OUT-2026-00111', phone: '9876543210' }],
    },
    documents,
    statusHistory: [],
  };
}

function stubFetch(documents: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { submission: submission(documents) } }),
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

describe('SKDP — Sales KYC detail documents + photos', () => {
  it('SKDP1+2: documents render with human labels and a View link', async () => {
    stubFetch([
      { documentType: 'PAN_CARD', status: 'PENDING', viewUrl: 'https://signed/pan' },
      { documentType: 'GST_CERTIFICATE', status: 'VERIFIED', viewUrl: 'https://signed/gst' },
    ]);
    await renderAndExpand();
    await waitFor(() => expect(screen.getByText('PAN Card')).toBeInTheDocument());
    expect(screen.getByText('GST Certificate')).toBeInTheDocument();
    const viewLinks = screen.getAllByTestId('kyc-doc-view-link');
    expect(viewLinks.length).toBe(2);
    expect(viewLinks[0]).toHaveAttribute('href', expect.stringContaining('https://signed/'));
  });

  it('SKDP3: store/owner photos render as image thumbnails', async () => {
    stubFetch([
      { documentType: 'STORE_BOARD_PHOTO', status: 'PENDING', viewUrl: 'https://signed/board' },
      { documentType: 'SELFIE', status: 'PENDING', viewUrl: 'https://signed/selfie' },
    ]);
    await renderAndExpand();
    await waitFor(() => expect(screen.getAllByTestId('outlet-photo-thumb').length).toBe(2));
    const imgs = screen.getAllByRole('img');
    expect(imgs.some(i => i.getAttribute('src') === 'https://signed/board')).toBe(true);
  });

  it('SKDP4: no demo-mode placeholder and no dead Tier chip', async () => {
    stubFetch([{ documentType: 'PAN_CARD', status: 'PENDING', viewUrl: 'https://signed/pan' }]);
    await renderAndExpand();
    await waitFor(() => expect(screen.getByText('PAN Card')).toBeInTheDocument());
    expect(screen.queryByText(/demo mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tier/i)).not.toBeInTheDocument();
  });

  it('SKDP5: honest empty states when nothing was uploaded', async () => {
    stubFetch([]);
    await renderAndExpand();
    await waitFor(() => expect(screen.getByText(/no documents uploaded/i)).toBeInTheDocument());
    expect(screen.getByText(/no photos uploaded/i)).toBeInTheDocument();
  });
});
