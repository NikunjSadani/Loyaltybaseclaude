/// <reference types="vitest/globals" />
/**
 * SPC — Sales KYC detail: re-KYC proposed-change rendering (stage-at-approval)
 *
 * A re-KYC stages the owner's proposed identity/payout values on `submission.proposedPartner`;
 * the live `partner.*` fields keep the OLD values until Gifsy approval. The sales approver must
 * see the NEW (proposed) values with the old value alongside.
 *
 * SPC1: a banner surfaces the changed field labels
 * SPC2: a changed field shows the proposed value as primary + "was: <old>" (details auto-open)
 * SPC3: no proposedPartner → no banner, no badges (renders as before)
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href, children, ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import SalesKYCDetailPage from '../page';

const TEST_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const BASE = {
  id: TEST_UUID,
  status: 'PENDING_SO_APPROVAL',
  submittedAt: '2026-04-01T00:00:00.000Z',
  user: { id: 'u1', name: 'Rajesh Kumar', phone: '9876543210', role: 'SO' },
  partner: {
    id: 'p1', businessName: 'Kumar General Store', ownerName: 'Suresh Kumar',
    gstNumber: '27AAPFU0939F1ZV', panNumber: 'AAPFU0939F',
    address: '12 Market Road', city: 'Mumbai', state: 'Maharashtra',
    bankName: 'HDFC Bank', bankAccountNumber: '111100000022', ifscCode: 'HDFC0001234',
    outlets: [{
      id: 'o1', name: 'Kumar General Store', outletCode: 'O123', phone: '9876543210',
      addressLine1: '12 Market Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001',
    }],
  },
  documents: [],
  statusHistory: [],
};

/** Re-KYC proposing a NEW owner name + NEW GSTIN. */
const REKYC = {
  ...BASE,
  proposedPartner: {
    ownerName: 'Mahesh Kumar',        // CHANGED (always-visible field)
    gstNumber: '29ZZZZZ9999Z9Z9',     // CHANGED
    panNumber: 'AAPFU0939F',          // unchanged
  },
};

function stubFetch(submission: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { submission } }),
  }));
}

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

afterEach(() => { vi.unstubAllGlobals(); });

describe('SPC — Sales KYC re-KYC proposed-change rendering', () => {
  it('SPC1: a banner lists the changed field labels', async () => {
    stubFetch(REKYC);
    await renderPage();
    const banner = await screen.findByTestId('proposed-changes-banner');
    expect(banner).toHaveTextContent('Owner Name');
    expect(banner).toHaveTextContent('GST');
    expect(banner).not.toHaveTextContent('PAN');   // unchanged → not listed
  });

  it('SPC2: a changed field shows the proposed value + "was: <old>"', async () => {
    stubFetch(REKYC);
    await renderPage();
    // Details auto-open on a proposed change → the proposed owner name is visible.
    await waitFor(() => expect(screen.getByText('Mahesh Kumar')).toBeInTheDocument());
    expect(screen.getByText(/was: Suresh Kumar/)).toBeInTheDocument();
    // The changed fields carry the field-level badge (Owner Name + GST = 2).
    expect(screen.getAllByTestId('proposed-change')).toHaveLength(2);
  });

  it('SPC4: a staged outlet-address change shows the proposed address + "was: <old>"', async () => {
    stubFetch({
      ...BASE,
      proposedPartner: {
        addressLine1: '88 New Bazaar St', city: 'Pune', state: 'Maharashtra', pincode: '411002',
      },
    });
    await renderPage();
    const banner = await screen.findByTestId('proposed-changes-banner');
    expect(banner).toHaveTextContent('Address');
    // Details auto-open → proposed (overlaid) address is primary, old address as "was".
    await waitFor(() =>
      expect(screen.getByText('88 New Bazaar St, Pune, Maharashtra, 411002')).toBeInTheDocument());
    expect(screen.getByText(/was: 12 Market Road, Mumbai, Maharashtra, 400001/)).toBeInTheDocument();
  });

  it('SPC3: no proposedPartner → no banner, no badges', async () => {
    stubFetch({ ...BASE, proposedPartner: null });
    await renderPage();
    await waitFor(() => expect(screen.getByText('Kumar General Store')).toBeInTheDocument());
    expect(screen.queryByTestId('proposed-changes-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proposed-change')).not.toBeInTheDocument();
  });
});

/**
 * SPV — Sales KYC detail: "Verified on parent" badge (Wave-3 grouped child)
 *
 * A grouped child whose CURRENT value matches its APPROVED parent carries a per-field
 * `parentVerified` flag (server pre-mask). The sales approver sees a subtle emerald badge,
 * distinct from the amber "Proposed change" pill — a field can be BOTH. The badge lives inside
 * the collapsible Store Information; a proposed change auto-opens it, otherwise open it manually.
 */
describe('SPV — Sales KYC verified-on-parent badge', () => {
  it('SPV1: parent-verified fields show the badge (details opened manually)', async () => {
    stubFetch({ ...BASE, proposedPartner: null, parentVerified: { panNumber: true, gstNumber: true } });
    await renderPage();
    await waitFor(() => expect(screen.getByText('Kumar General Store')).toBeInTheDocument());
    // No proposed change → details stay closed; open Store Information to reveal the fields.
    fireEvent.click(screen.getByRole('button', { name: /store information/i }));
    expect(screen.getAllByTestId('verified-on-parent-badge')).toHaveLength(2);
    expect(screen.queryByTestId('proposed-change')).not.toBeInTheDocument();
  });

  it('SPV2: a field BOTH proposed AND parent-verified shows the pill and the badge (auto-open)', async () => {
    // REKYC proposes new Owner + GST; flag GST as verified-on-parent too.
    stubFetch({ ...REKYC, parentVerified: { gstNumber: true } });
    await renderPage();
    // A proposed change auto-opens details → the proposed owner name is visible.
    await waitFor(() => expect(screen.getByText('Mahesh Kumar')).toBeInTheDocument());
    // Proposed pills unchanged (Owner + GST = 2)…
    expect(screen.getAllByTestId('proposed-change')).toHaveLength(2);
    // …plus exactly one verified badge (GST).
    expect(screen.getAllByTestId('verified-on-parent-badge')).toHaveLength(1);
  });

  it('SPV3: a masked reader still gets the badge (parentVerified pre-mask)', async () => {
    stubFetch({
      ...BASE,
      partner: { ...BASE.partner, panNumber: 'AAPxxxxx9F' },  // PII-masked PAN on the wire
      proposedPartner: null,
      parentVerified: { panNumber: true },
    });
    await renderPage();
    await waitFor(() => expect(screen.getByText('Kumar General Store')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /store information/i }));
    expect(screen.getByTestId('verified-on-parent-badge')).toBeInTheDocument();
  });

  it('SPV4: no parentVerified → no badge (purely additive)', async () => {
    stubFetch({ ...BASE, proposedPartner: null });
    await renderPage();
    await waitFor(() => expect(screen.getByText('Kumar General Store')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /store information/i }));
    expect(screen.queryByTestId('verified-on-parent-badge')).not.toBeInTheDocument();
  });
});
