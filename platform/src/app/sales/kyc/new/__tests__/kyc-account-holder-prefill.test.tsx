/**
 * Task E (frontend): on re-entry (rejected / re-KYC outlet deep-link) the form must
 * pre-fill the bank "Account Holder Name" from `existingKyc.accountHolderName`,
 * alongside the already-mapped `existingKyc.address` and `existingKyc.pincode`.
 *
 * The backend now adds `existingKyc.accountHolderName` to the /api/sales/outlets
 * payload. This test deep-links such an outlet and walks the wizard to the steps
 * where those fields render, asserting each shows the prefilled value.
 *
 * Navigation is gated on doc uploads; the prior submission (GET /api/kyc/:id)
 * carries over the GST cert + owner photo so the Details-step gate passes, and the
 * address proof + store board photo + geo so the Address-step gate passes.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...p }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...p}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

import NewKYCPage from '../page';

const EXISTING_KYC = {
  partnerName: 'Verma Traders', mobile: '7766554433',
  gstNumber: '', panNumber: '',
  address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
  bankName: 'HDFC Bank', accountHolderName: 'Suresh Verma',
  accountNumber: '123456789012', ifscCode: 'HDFC0001234', upiId: '',
};

const OUTLETS_RESPONSE = {
  success: true,
  data: { outlets: [{
    id: 'OUT1', outletCode: 'OUT-1', name: 'Verma Traders', mobile: '7766554433',
    type: 'SSS', kycStatus: 'REJECTED', kycId: 'K1',
    existingKyc: EXISTING_KYC,
    kycRejectionReason: 'GST document is blurry',
  }] },
};

// Carries over all four required docs + both geo proofs so the step gates pass.
const SUBMISSION = { success: true, data: { submission: {
  id: 'K1', status: 'REJECTED',
  documents: [
    { documentType: 'GST_CERTIFICATE', fileKey: 'k/gst.jpg', fileUrl: 'https://s/gst.jpg', viewUrl: 'data:image/jpeg;base64,AAAA', fileName: 'gst.jpg', mimeType: 'image/jpeg', fileSizeBytes: 1000 },
    { documentType: 'SELFIE', fileKey: 'k/selfie.jpg', fileUrl: 'https://s/selfie.jpg', viewUrl: 'data:image/jpeg;base64,BBBB', fileName: 'selfie.jpg', mimeType: 'image/jpeg', fileSizeBytes: 1000 },
    { documentType: 'SHOP_ESTABLISHMENT', fileKey: 'k/addr.jpg', fileUrl: 'https://s/addr.jpg', viewUrl: 'data:image/jpeg;base64,CCCC', fileName: 'addr.jpg', mimeType: 'image/jpeg', fileSizeBytes: 1000 },
    { documentType: 'STORE_BOARD_PHOTO', fileKey: 'k/board.jpg', fileUrl: 'https://s/board.jpg', viewUrl: 'data:image/jpeg;base64,DDDD', fileName: 'board.jpg', mimeType: 'image/jpeg', fileSizeBytes: 1000 },
  ],
  boardPhotoLat: 18.52, boardPhotoLng: 73.85, boardPhotoGeoAccuracy: 10, boardPhotoGeoAt: '2026-06-01T00:00:00.000Z',
  paymentLat: 18.52, paymentLng: 73.85, paymentGeoAccuracy: 10, paymentGeoAt: '2026-06-01T00:00:00.000Z',
} } };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('token', 'tok');
  window.history.replaceState({}, '', '/sales/kyc/new?outletId=OUT1');
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (String(url).includes('/api/sales/outlets'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(OUTLETS_RESPONSE) });
    if (String(url).includes('/api/kyc/'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(SUBMISSION) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('KYC re-entry prefill — address/pincode/state + accountHolderName', () => {
  it('prefills State, Street Address and Pincode on the Address step', async () => {
    render(<NewKYCPage />);
    // Wait for the prior submission to be fetched (docs carried over → gates pass).
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/api/kyc/K1'))).toBe(true));

    // Outlet → Details
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    // Details → Address
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }));

    // Street Address + Pincode prefilled from existingKyc.address / .pincode
    expect(await screen.findByDisplayValue('12 MG Road')).toBeInTheDocument();
    expect(screen.getByDisplayValue('411001')).toBeInTheDocument();
    // State searchable dropdown shows the prefilled value
    expect(screen.getByTestId('state-select-input')).toHaveValue('Maharashtra');
  });

  it('prefills the bank Account Holder Name on the Bank step', async () => {
    render(<NewKYCPage />);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/api/kyc/K1'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));       // Outlet → Details
    fireEvent.click(await screen.findByRole('button', { name: /continue/i })); // Details → Address
    fireEvent.click(await screen.findByRole('button', { name: /continue/i })); // Address → Bank

    // accountHolderName came from existingKyc.accountHolderName
    expect(await screen.findByTestId('account-holder-name-input')).toHaveValue('Suresh Verma');
  });
});
