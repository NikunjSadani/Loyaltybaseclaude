/// <reference types="vitest/globals" />
/**
 * UCB — Admin KYC detail: UPI capture-method reviewer badge (VPA safeguards)
 *
 * Next to the UPI ID the reviewer sees "Scanned" (QR) or "Typed" (MANUAL, warning style);
 * nothing when the method is unknown (null / legacy). A re-KYC's proposed method wins over
 * the live partner's (mirrors the backend stage-at-approval overlay).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
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

const partner = (upiCaptureMethod: 'QR' | 'MANUAL' | null) => ({
  id: 'p1', businessName: 'Sharma General Store', ownerName: 'Anil Sharma', partnerCode: 'CP777',
  gstNumber: '27AABCS1429B1Z5', panNumber: 'AABCS1429B',
  upiId: 'sharma@okaxis', upiCaptureMethod, paymentMode: 'upi',
  outlets: [{ outletCode: 'O999', name: 'Sharma General Store', city: 'Mumbai', state: 'Maharashtra', pincode: '400053' }],
});

const submission = (p: unknown, proposedPartner: unknown = null) => ({
  id: 'KYC001', status: 'PENDING_GIFSY',
  submittedAt: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z',
  user: { id: 'u1', name: 'Rohit Verma', phone: '9820184321', role: 'SALES_SO' },
  partner: p, proposedPartner, documents: [], statusHistory: [],
});

function stubFetch(s: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: () => Promise.resolve({ success: true, data: { submission: s } }),
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('UCB — Admin KYC UPI capture-method badge', () => {
  it('UCB1: QR → "Scanned" badge next to the UPI ID', async () => {
    stubFetch(submission(partner('QR')));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    await screen.findByText('sharma@okaxis');
    expect(screen.getByTestId('upi-capture-badge')).toHaveTextContent('Scanned');
    // Recorded (client-reported, possibly group-inherited) provenance — the tooltip must not
    // imply server-verified capture by this submission.
    expect(screen.getByTestId('upi-capture-badge').getAttribute('title')).toMatch(
      /^As recorded when the UPI ID was captured \(may be inherited from the outlet group\)/,
    );
  });

  it('UCB2: MANUAL → "Typed" badge in warning (amber) style', async () => {
    stubFetch(submission(partner('MANUAL')));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    await screen.findByText('sharma@okaxis');
    const badge = screen.getByTestId('upi-capture-badge');
    expect(badge).toHaveTextContent('Typed');
    expect(badge.className).toMatch(/amber/);
    expect(badge.getAttribute('title')).toMatch(/may be inherited from the outlet group\): typed by hand/);
  });

  it('UCB3: null (legacy/unknown) → no badge', async () => {
    stubFetch(submission(partner(null)));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    await screen.findByText('sharma@okaxis');
    expect(screen.queryByTestId('upi-capture-badge')).not.toBeInTheDocument();
  });

  it('UCB4: a re-KYC proposed method (MANUAL) overrides the live one (QR)', async () => {
    stubFetch(submission(partner('QR'), { upiId: 'sharma2@okaxis', upiCaptureMethod: 'MANUAL' }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    await screen.findByText('sharma2@okaxis');
    expect(screen.getByTestId('upi-capture-badge')).toHaveTextContent('Typed');
  });
});

describe('UCB-R — Admin KYC: payout rail REMOVED by a re-KYC (explicit null proposed key)', () => {
  it('UCB-R1: proposed upiId=null (bank rail set) → UPI struck through, "Will be removed on approval", NO capture badge', async () => {
    // Even with the method key NOT staged (so the effective method stays the live 'QR'), the
    // badge must not describe a UPI that approval removes.
    stubFetch(submission(partner('QR'), {
      upiId: null, bankName: 'HDFC Bank', bankAccountNumber: '50100012345678', ifscCode: 'HDFC0001234', paymentMode: 'bank',
    }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    const struck = await screen.findByText('sharma@okaxis');
    expect(struck.tagName).toBe('DEL');
    expect(struck).toHaveAttribute('data-testid', 'proposed-removal-value');
    expect(screen.getByTestId('proposed-removal-badge')).toHaveTextContent('Will be removed on approval');
    expect(screen.queryByTestId('upi-capture-badge')).not.toBeInTheDocument();
    // Banner lists the removal explicitly.
    expect(screen.getByTestId('proposed-changes-banner')).toHaveTextContent('UPI ID (removed)');
    // The new bank values still render as ordinary proposed changes.
    expect(screen.getByText('HDFC Bank')).toBeInTheDocument();
  });

  it('UCB-R2: proposed upiId=null but NO current UPI → nothing to remove (no removal row)', async () => {
    const p = { ...partner(null), upiId: null };
    stubFetch(submission(p, { upiId: null, bankName: 'HDFC Bank', paymentMode: 'bank' }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    await screen.findByText('HDFC Bank');
    expect(screen.queryByTestId('proposed-removal-badge')).not.toBeInTheDocument();
  });

  /* U9 — UNVERIFIED partner: the backend hides the LIVE self-captured payout (nulls) but now ships
     the rep-entered PROPOSED payout values (+ explicit-null "will be removed" keys). The reviewer
     must see the proposed values as changes; a hidden live value has nothing visible to strike. */
  it('UCB-R4: UNVERIFIED partner (live payout hidden) → proposed UPI shown as a change, no phantom removals', async () => {
    const hidden = {
      ...partner(null), upiId: null, upiCaptureMethod: null, paymentMode: 'bank', paymentDetailsStatus: 'UNVERIFIED',
      bankName: null, bankAccountNumber: null, bankAccountHolder: null, ifscCode: null,
    };
    stubFetch(submission(hidden, {
      upiId: 'fresh@okaxis', upiCaptureMethod: 'MANUAL', paymentMode: 'upi',
      bankName: null, bankAccountNumber: null, bankAccountHolder: null, ifscCode: null,
    }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    const upi = await screen.findByText('fresh@okaxis');
    expect(upi.closest('[data-testid="proposed-change"]')).not.toBeNull();
    // The proposed method drives the reviewer badge.
    expect(screen.getByTestId('upi-capture-badge')).toHaveTextContent('Typed');
    // Hidden (null) live bank values → nothing to strike through.
    expect(screen.queryByTestId('proposed-removal-badge')).not.toBeInTheDocument();
    const banner = screen.getByTestId('proposed-changes-banner');
    expect(banner).toHaveTextContent('UPI ID');
    expect(banner).toHaveTextContent('Payment Mode');
    expect(banner).not.toHaveTextContent('(removed)');
  });

  it('UCB-R5: UNVERIFIED partner → proposed BANK values render as changes on every bank row', async () => {
    const hidden = {
      ...partner(null), upiId: null, upiCaptureMethod: null, paymentMode: 'upi', paymentDetailsStatus: 'UNVERIFIED',
    };
    stubFetch(submission(hidden, {
      bankName: 'HDFC Bank', bankAccountNumber: '50100012345678', bankAccountHolder: 'Anil K Sharma HUF',
      ifscCode: 'HDFC0001234', paymentMode: 'bank', upiId: null,
    }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    for (const v of ['HDFC Bank', '50100012345678', 'Anil K Sharma HUF', 'HDFC0001234']) {
      const el = await screen.findByText(v);
      expect(el.closest('[data-testid="proposed-change"]')).not.toBeNull();
    }
    expect(screen.queryByTestId('proposed-removal-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('upi-capture-badge')).not.toBeInTheDocument();
  });

  it('UCB-R3: proposed bank keys=null (UPI rail set) → current bank values struck through', async () => {
    const p = { ...partner('QR'), bankName: 'ICICI Bank', bankAccountNumber: '000111222333', ifscCode: 'ICIC0000001' };
    stubFetch(submission(p, {
      upiId: 'sharma3@okaxis', upiCaptureMethod: 'QR', paymentMode: 'upi',
      bankName: null, bankAccountNumber: null, bankAccountHolder: null, ifscCode: null,
    }));
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    await screen.findByText('sharma3@okaxis');
    expect(screen.getByText('ICICI Bank').tagName).toBe('DEL');
    expect(screen.getByText('ICIC0000001').tagName).toBe('DEL');
    expect(screen.getAllByTestId('proposed-removal-badge').length).toBe(3); // bank, account, IFSC (holder was empty)
    // The NEW UPI keeps its (proposed) capture badge.
    expect(screen.getByTestId('upi-capture-badge')).toHaveTextContent('Scanned');
  });
});

describe('UCB-RR — Admin KYC: server removedRail notice (R10)', () => {
  it('UCB-RR1: removedRail=upi → value-free notice + the per-field UPI removal row (consistent)', async () => {
    stubFetch({
      ...submission(partner('QR'), {
        upiId: null, bankName: 'HDFC Bank', bankAccountNumber: '50100012345678', ifscCode: 'HDFC0001234', paymentMode: 'bank',
      }),
      removedRail: 'upi',
    });
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    const notice = await screen.findByTestId('kyc-detail-removed-rail');
    expect(notice).toHaveTextContent('The partner’s current UPI ID will be removed on approval');
    expect(notice).not.toHaveTextContent('sharma@okaxis'); // value-free
    expect(screen.getByText('sharma@okaxis').tagName).toBe('DEL');
    expect(screen.getAllByTestId('proposed-removal-badge')).toHaveLength(1);
  });

  it('UCB-RR2: removedRail=bank with HIDDEN live values → notice still shown, no per-field rows', async () => {
    const hidden = {
      ...partner(null), upiId: null, paymentMode: 'upi', paymentDetailsStatus: 'UNVERIFIED',
      bankName: null, bankAccountNumber: null, bankAccountHolder: null, ifscCode: null,
    };
    stubFetch({ ...submission(hidden, { upiId: 'fresh@okaxis', paymentMode: 'upi' }), removedRail: 'bank' });
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    expect(await screen.findByTestId('kyc-detail-removed-rail'))
      .toHaveTextContent('The partner’s current bank details will be removed on approval');
    expect(screen.queryByTestId('proposed-removal-badge')).not.toBeInTheDocument();
  });

  it('UCB-RR3: removedRail=null is authoritative → no notice and NO contradicting per-field removal rows', async () => {
    stubFetch({
      ...submission(partner('QR'), { upiId: null, bankName: 'HDFC Bank', paymentMode: 'bank' }),
      removedRail: null,
    });
    render(<KYCDetailPage params={Promise.resolve({ id: 'KYC001' })} />);
    await screen.findByText('HDFC Bank');
    expect(screen.queryByTestId('kyc-detail-removed-rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proposed-removal-badge')).not.toBeInTheDocument();
    expect(screen.getByText('sharma@okaxis').tagName).not.toBe('DEL');
  });
});
