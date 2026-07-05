/**
 * Re-KYC deep-link auto-skips Step 1 (Select Outlet).
 *
 * When a rep is deep-linked (?outletId=) into a RE_KYC_REQUIRED outlet, Step 1 has no
 * decision left — the outlet is already chosen and 'Not Interested' is hidden for
 * re-KYC — so the wizard jumps straight to Details (Step 2). A REJECTED deep-link, by
 * contrast, KEEPS Step 1 because the rep can still mark that outlet Not Interested there.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...p }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...p}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

import NewKYCPage from '../page';

function outletsResponse(kycStatus: string, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    data: { outlets: [{
      id: 'OUT1', outletCode: 'OUT-1', name: 'Verma Traders', mobile: '7766554433',
      type: 'SSS', kycStatus, kycId: 'K1',
      // A re-KYC outlet always carries a completed prior KYC (mobile included).
      existingKyc: {
        partnerName: 'Verma Traders', mobile: '7766554433',
        gstNumber: '27AAPFU0939F1Z5', panNumber: 'AAPFU0939F',
        address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
        bankName: 'HDFC Bank', accountHolderName: 'Suresh Verma',
        accountNumber: '123456789012', ifscCode: 'HDFC0001234', upiId: '',
      },
      ...extra,
    }] },
  };
}

const SUBMISSION = { success: true, data: { submission: { id: 'K1', status: 'RE_KYC_REQUIRED', documents: [] } } };

function stubFetch(outlets: unknown) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (String(url).includes('/api/sales/outlets'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(outlets) });
    if (String(url).includes('/api/kyc/'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(SUBMISSION) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('token', 'tok');
  window.history.replaceState({}, '', '/sales/kyc/new?outletId=OUT1');
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('Re-KYC deep-link — Step 1 auto-skip', () => {
  it('a RE_KYC_REQUIRED deep-link skips Select Outlet and lands on Details', async () => {
    stubFetch(outletsResponse('RE_KYC_REQUIRED', { reKycFlags: { gstNumber: true, remarks: 'GSTIN mismatch' } }));
    render(<NewKYCPage />);

    // The re-KYC summary banner renders only on steps 2-4 → confirms we advanced past Step 1.
    expect(await screen.findByTestId('rekyc-summary-banner')).toBeInTheDocument();
    // Step 1 is gone: its outlet-dropdown trigger renders only on the 'outlet' step.
    expect(screen.queryByTestId('outlet-dropdown-trigger')).not.toBeInTheDocument();
  });

  it('a REJECTED deep-link KEEPS Step 1 (rep can still mark Not Interested)', async () => {
    stubFetch(outletsResponse('REJECTED'));
    render(<NewKYCPage />);

    // Still on Step 1: the outlet-dropdown trigger + Not Interested button are present.
    expect(await screen.findByTestId('outlet-dropdown-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('ni-btn')).toBeInTheDocument();
    // And NOT auto-advanced — the summary banner (a step 2-4 element) is absent.
    expect(screen.queryByTestId('rekyc-summary-banner')).not.toBeInTheDocument();
  });
});
