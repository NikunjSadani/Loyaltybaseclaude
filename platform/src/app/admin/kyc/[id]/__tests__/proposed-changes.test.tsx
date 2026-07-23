/// <reference types="vitest/globals" />
/**
 * KYCPC — Admin KYC detail: re-KYC proposed-change rendering (stage-at-approval)
 *
 * A re-KYC stages the owner's proposed identity/payout values on `submission.proposedPartner`
 * and applies them to the live partner only at Gifsy approval. Until then the live `partner.*`
 * fields hold the OLD (approved) values. The reviewer must see the NEW (proposed) values they
 * are approving, with the old value alongside — else they'd approve stale bank/PAN/GST.
 *
 * KYCPC1: a changed field shows the PROPOSED value as primary + "was: <old>"
 * KYCPC2: a proposed-changes banner lists the changed field labels
 * KYCPC3: an UNCHANGED field renders normally (no "Proposed change" badge)
 * KYCPC4: no proposedPartner → no banner, no badges (renders as before)
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href, children, ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('react');
  return {
    ...actual,
    use: vi.fn((val: unknown) => {
      if (val && typeof val === 'object' && 'then' in val) return { id: 'KYC001' };
      return actual.use(val as React.Context<unknown>);
    }),
  };
});

import KYCDetailPage from '../page';

const BASE_PARTNER = {
  id: 'p1', businessName: 'Sharma General Store', ownerName: 'Anil Sharma', partnerCode: 'CP777',
  gstNumber: '27AABCS1429B1Z5', panNumber: 'AABCS1429B',
  bankName: 'HDFC Bank', bankAccountNumber: '50100000000012', ifscCode: 'HDFC0004832',
  outlets: [{
    outletCode: 'O999', name: 'Sharma General Store',
    addressLine1: 'Shop 12, Old Lane', city: 'Mumbai', state: 'Maharashtra', pincode: '400053',
  }],
};

/** A re-KYC that proposes a NEW GSTIN + NEW bank account; PAN + owner unchanged. */
const REKYC_SUBMISSION = {
  id: 'KYC001',
  status: 'PENDING_GIFSY',
  submittedAt: '2026-05-01T00:00:00.000Z',
  createdAt: '2026-05-01T00:00:00.000Z',
  user: { id: 'u1', name: 'Rohit Verma', phone: '9820184321', role: 'SALES_SO' },
  partner: BASE_PARTNER,
  proposedPartner: {
    businessName: 'Sharma General Store',   // unchanged
    ownerName: 'Anil Sharma',               // unchanged
    panNumber: 'AABCS1429B',                // unchanged
    gstNumber: '29ZZZZZ9999Z9Z9',           // CHANGED
    bankAccountNumber: '77777000000099',    // CHANGED
  },
  documents: [],
  statusHistory: [],
};

function stubFetch(submission: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { submission } }),
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('KYCPC — Admin KYC re-KYC proposed-change rendering', () => {
  it('KYCPC1: a changed field shows the proposed value + "was: <old>"', async () => {
    stubFetch(REKYC_SUBMISSION);
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    // Proposed (new) GSTIN is shown as the primary value…
    expect(await screen.findByText('29ZZZZZ9999Z9Z9')).toBeInTheDocument();
    // …with the old value alongside (one "was:" per changed field — GST + Account).
    expect(screen.getAllByText(/was:/)).toHaveLength(2);
    expect(screen.getByText('27AABCS1429B1Z5')).toBeInTheDocument();     // old GST
    expect(screen.getByText('77777000000099')).toBeInTheDocument();      // new account
    expect(screen.getByText('50100000000012')).toBeInTheDocument();      // old account
  });

  it('KYCPC2: banner lists the changed field labels', async () => {
    stubFetch(REKYC_SUBMISSION);
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    const banner = await screen.findByTestId('proposed-changes-banner');
    expect(banner).toHaveTextContent('GSTIN');
    expect(banner).toHaveTextContent('Account No.');
    expect(banner).not.toHaveTextContent('PAN');   // unchanged → not listed
  });

  it('KYCPC3: exactly the changed fields carry a "Proposed change" badge', async () => {
    stubFetch(REKYC_SUBMISSION);
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    await screen.findByText('29ZZZZZ9999Z9Z9');
    // GSTIN + Account No. changed → 2 field-level badges.
    expect(screen.getAllByTestId('proposed-change')).toHaveLength(2);
    // PAN unchanged → its live value still renders plainly.
    expect(screen.getByText('AABCS1429B')).toBeInTheDocument();
  });

  it('KYCPC5: a staged outlet-address change shows the proposed address + "was: <old>"', async () => {
    stubFetch({
      ...REKYC_SUBMISSION,
      proposedPartner: {
        // Only the address moved (a re-KYC re-capturing the shop address).
        addressLine1: 'Unit 4, New Market Rd', city: 'Pune', state: 'Maharashtra', pincode: '411001',
      },
    });
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    // Proposed (overlaid) full address shown as primary…
    expect(await screen.findByText('Unit 4, New Market Rd, Pune, Maharashtra, 411001')).toBeInTheDocument();
    // …old outlet address as "was".
    expect(screen.getByText(/was:/)).toBeInTheDocument();
    expect(screen.getByText('Shop 12, Old Lane, Mumbai, Maharashtra, 400053')).toBeInTheDocument();
    // Banner lists Address.
    expect(await screen.findByTestId('proposed-changes-banner')).toHaveTextContent('Address');
  });

  it('KYCPC4: no proposedPartner → no banner and no badges', async () => {
    stubFetch({ ...REKYC_SUBMISSION, proposedPartner: null });
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    await screen.findAllByText('Sharma General Store');
    expect(screen.queryByTestId('proposed-changes-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proposed-change')).not.toBeInTheDocument();
    // Live GST renders as the plain value (no proposed override).
    expect(screen.getByText('27AABCS1429B1Z5')).toBeInTheDocument();
  });
});
