/**
 * New-KYC "Select Outlet" picker must only offer outlets a rep can START a fresh
 * KYC on — i.e. NOT yet submitted (NOT_STARTED / saved draft). Everything already
 * in the pipeline — submitted / under review / approval-pending / Gifsy review /
 * approved / rejected / re-upload / re-KYC — is excluded from the manual picker
 * (owner 2026-06-24). Re-entry of rejected/re-KYC outlets is via the KYC list's
 * "Edit & Resubmit" deep-link, which pre-selects from the full roster.
 *
 * Run: npx vitest run src/app/sales/kyc/new/__tests__/outlet-picker-filter.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import NewKYCPage from '../page';

const OUTLETS = [
  { id: 'o-ns',    outletCode: 'OUT-NS',    name: 'Fresh Store',     district: 'B1', type: 'SSS',        kycStatus: 'NOT_STARTED' },
  { id: 'o-gifsy', outletCode: 'OUT-GIFSY', name: 'Under Review Co', district: 'B1', type: 'SSS',        kycStatus: 'PENDING_GIFSY' },
  { id: 'o-rej',   outletCode: 'OUT-REJ',   name: 'Rejected Mart',   district: 'B1', type: 'SSS',        kycStatus: 'REJECTED' },
  { id: 'o-appr',  outletCode: 'OUT-APPR',  name: 'Approved Bazaar', district: 'B1', type: 'WHOLESALER', kycStatus: 'APPROVED' },
  { id: 'o-rekyc', outletCode: 'OUT-REKYC', name: 'ReKYC Kirana',    district: 'B1', type: 'SSS',        kycStatus: 'RE_KYC_REQUIRED' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: OUTLETS } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
  });
});

describe('New KYC — outlet picker only lists not-yet-submitted outlets', () => {
  it('shows NOT_STARTED, hides submitted/under-review/approved/rejected/re-KYC', async () => {
    const user = userEvent.setup();
    render(<NewKYCPage />);
    await user.click(screen.getByTestId('outlet-dropdown-trigger'));

    // The one startable outlet is offered…
    expect(await screen.findByTestId('outlet-option-o-ns')).toBeInTheDocument();
    // …and every pipeline status is excluded from the manual picker.
    expect(screen.queryByTestId('outlet-option-o-gifsy')).toBeNull(); // under review
    expect(screen.queryByTestId('outlet-option-o-rej')).toBeNull();   // rejected
    expect(screen.queryByTestId('outlet-option-o-appr')).toBeNull();  // approved
    expect(screen.queryByTestId('outlet-option-o-rekyc')).toBeNull(); // re-KYC

    // Count reflects only startable outlets.
    await waitFor(() => expect(document.body.textContent).toContain('1 of 1 outlets shown'));
  });
});
