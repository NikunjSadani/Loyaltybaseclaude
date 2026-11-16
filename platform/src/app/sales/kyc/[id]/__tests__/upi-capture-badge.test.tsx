/// <reference types="vitest/globals" />
/**
 * SUCB — Sales KYC detail: UPI capture-method reviewer badge (VPA safeguards)
 *
 * The sales approver sees "Scanned" (QR) / "Typed" (MANUAL, warning) beside the UPI ID in
 * Payment Details; nothing when the method is unknown.
 */
import React, { Suspense, act } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import SalesKYCDetailPage from '../page';

const TEST_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const submission = (upiCaptureMethod: 'QR' | 'MANUAL' | null) => ({
  id: TEST_UUID,
  status: 'PENDING_SO_APPROVAL',
  submittedAt: '2026-04-01T00:00:00.000Z',
  user: { id: 'u1', name: 'Rajesh Kumar', phone: '9876543210', role: 'SO' },
  partner: {
    id: 'p1', businessName: 'Kumar General Store', ownerName: 'Suresh Kumar',
    gstNumber: '27AAPFU0939F1ZV', panNumber: 'AAPFU0939F',
    address: '12 Market Road', city: 'Mumbai', state: 'Maharashtra',
    upiId: 'kumar@okaxis', upiCaptureMethod, paymentMode: 'upi',
    outlets: [{
      id: 'o1', name: 'Kumar General Store', outletCode: 'O123', phone: '9876543210',
      addressLine1: '12 Market Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001',
    }],
  },
  proposedPartner: null,
  documents: [],
  statusHistory: [],
});

function stubFetch(s: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: () => Promise.resolve({ success: true, data: { submission: s } }),
  }));
}

async function renderAndOpen() {
  const params = Promise.resolve({ id: TEST_UUID });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
  expect(await screen.findByText('Kumar General Store')).toBeInTheDocument();
  // Payment Details live inside the collapsible Store Information.
  fireEvent.click(screen.getByRole('button', { name: /store information/i }));
  await screen.findByText('kumar@okaxis');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('SUCB — Sales KYC UPI capture-method badge', () => {
  it('SUCB1: QR → "Scanned"', async () => {
    stubFetch(submission('QR'));
    await renderAndOpen();
    expect(await screen.findByTestId('upi-capture-badge')).toHaveTextContent('Scanned');
  });

  it('SUCB2: MANUAL → "Typed" (warning style)', async () => {
    stubFetch(submission('MANUAL'));
    await renderAndOpen();
    const badge = await screen.findByTestId('upi-capture-badge');
    expect(badge).toHaveTextContent('Typed');
    expect(badge.className).toMatch(/amber/);
  });

  it('SUCB3: null → no badge', async () => {
    stubFetch(submission(null));
    await renderAndOpen();
    expect(screen.queryByTestId('upi-capture-badge')).not.toBeInTheDocument();
  });

  it('SUCB4: re-KYC proposes upiId=null (bank rail) → UPI struck through, "Will be removed on approval", NO badge', async () => {
    stubFetch({
      ...submission('QR'),
      proposedPartner: {
        upiId: null, bankName: 'HDFC Bank', bankAccountNumber: '50100012345678', ifscCode: 'HDFC0001234', paymentMode: 'bank',
      },
    });
    const params = Promise.resolve({ id: TEST_UUID });
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading…</div>}>
          <SalesKYCDetailPage params={params} />
        </Suspense>,
      );
      await params;
    });
    // A re-KYC with proposed changes auto-opens Store Information (no click needed).
    const struck = await screen.findByText('kumar@okaxis');
    expect(struck.tagName).toBe('DEL');
    expect(await screen.findByTestId('proposed-removal-badge')).toHaveTextContent('Will be removed on approval');
    expect(screen.queryByTestId('upi-capture-badge')).not.toBeInTheDocument();
    expect(await screen.findByTestId('proposed-changes-banner')).toHaveTextContent('UPI ID (removed)');
  });

  /* U9 — UNVERIFIED partner: live payout hidden (nulls), proposed rep-entered values present. */
  it('SUCB5: UNVERIFIED partner (live payout hidden) → proposed UPI shown as a change, no phantom removals', async () => {
    const base = submission(null);
    stubFetch({
      ...base,
      partner: { ...base.partner, upiId: null, upiCaptureMethod: null, paymentMode: 'bank', paymentDetailsStatus: 'UNVERIFIED' },
      proposedPartner: {
        upiId: 'fresh@okaxis', upiCaptureMethod: 'QR', paymentMode: 'upi',
        bankName: null, bankAccountNumber: null, bankAccountHolder: null, ifscCode: null,
      },
    });
    const params = Promise.resolve({ id: TEST_UUID });
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading…</div>}>
          <SalesKYCDetailPage params={params} />
        </Suspense>,
      );
      await params;
    });
    // Proposed changes auto-open Store Information.
    const upi = await screen.findByText('fresh@okaxis');
    expect(upi.closest('[data-testid="proposed-change"]')).not.toBeNull();
    expect(await screen.findByTestId('upi-capture-badge')).toHaveTextContent('Scanned');
    expect(screen.queryByTestId('proposed-removal-badge')).not.toBeInTheDocument();
    const banner = await screen.findByTestId('proposed-changes-banner');
    expect(banner).toHaveTextContent('UPI ID');
    expect(banner).not.toHaveTextContent('(removed)');
  });
});

describe('SUCB-RR — Sales KYC detail: server removedRail notice (R10)', () => {
  async function renderPage() {
    const params = Promise.resolve({ id: TEST_UUID });
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading…</div>}>
          <SalesKYCDetailPage params={params} />
        </Suspense>,
      );
      await params;
    });
  }

  it('SUCB-RR1: removedRail=upi → value-free notice + consistent per-field UPI removal row', async () => {
    stubFetch({
      ...submission('QR'),
      proposedPartner: {
        upiId: null, bankName: 'HDFC Bank', bankAccountNumber: '50100012345678', ifscCode: 'HDFC0001234', paymentMode: 'bank',
      },
      removedRail: 'upi',
    });
    await renderPage();
    const notice = await screen.findByTestId('kyc-detail-removed-rail');
    expect(notice).toHaveTextContent('The partner’s current UPI ID will be removed on approval');
    expect(notice).not.toHaveTextContent('kumar@okaxis'); // value-free
    expect((await screen.findByText('kumar@okaxis')).tagName).toBe('DEL');
  });

  it('SUCB-RR2: removedRail=bank with HIDDEN live values (no payment rows) → notice still shown', async () => {
    const base = submission(null);
    stubFetch({
      ...base,
      partner: { ...base.partner, upiId: null, paymentMode: 'upi', paymentDetailsStatus: 'UNVERIFIED' },
      proposedPartner: null,
      removedRail: 'bank',
    });
    await renderPage();
    expect(await screen.findByTestId('kyc-detail-removed-rail'))
      .toHaveTextContent('The partner’s current bank details will be removed on approval');
    expect(screen.queryByTestId('proposed-removal-badge')).not.toBeInTheDocument();
  });

  it('SUCB-RR3: removedRail=null is authoritative → no notice, no contradicting removal rows', async () => {
    stubFetch({
      ...submission('QR'),
      proposedPartner: { upiId: null, bankName: 'HDFC Bank', paymentMode: 'bank' },
      removedRail: null,
    });
    await renderPage();
    await screen.findByText('HDFC Bank');
    expect(screen.queryByTestId('kyc-detail-removed-rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proposed-removal-badge')).not.toBeInTheDocument();
  });
});
