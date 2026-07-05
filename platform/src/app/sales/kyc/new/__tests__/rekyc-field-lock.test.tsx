/**
 * Re-KYC field-level lock (frontend): when the admin flags SPECIFIC fields for
 * re-entry, only those fields are editable on wizard re-entry — every other mapped
 * KYC field stays pre-filled but LOCKED (disabled). A blanket re-KYC (no field
 * flags) keeps the whole form editable.
 *
 * This test deep-links a re-KYC outlet with ONLY `gstNumber` flagged and asserts:
 *   - the GST input is enabled (the flagged field the rep must correct)
 *   - a non-flagged input (City) is disabled (locked for reference)
 *   - the summary banner lists the flagged label "GST Number"
 *
 * The prior submission (GET /api/kyc/:id) carries over all four required docs +
 * both geo proofs so the step gates pass and the wizard can walk to each field.
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
  gstNumber: '27AAPFU0939F1Z5', panNumber: 'AAPFU0939F',
  address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
  bankName: 'HDFC Bank', accountHolderName: 'Suresh Verma',
  accountNumber: '123456789012', ifscCode: 'HDFC0001234', upiId: '',
};

const OUTLETS_RESPONSE = {
  success: true,
  data: { outlets: [{
    id: 'OUT1', outletCode: 'OUT-1', name: 'Verma Traders', mobile: '7766554433',
    type: 'SSS', kycStatus: 'RE_KYC_REQUIRED', kycId: 'K1',
    existingKyc: EXISTING_KYC,
    // ONLY the GST Number is flagged for re-entry → everything else must be locked.
    reKycFlags: { gstNumber: true, remarks: 'GSTIN does not match the certificate.' },
  }] },
};

// Carries over all four required docs + both geo proofs so the step gates pass.
const SUBMISSION = { success: true, data: { submission: {
  id: 'K1', status: 'RE_KYC_REQUIRED',
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

describe('Re-KYC field-level lock', () => {
  it('leaves the flagged GST input editable + banner lists "GST Number", but locks the non-flagged City input', async () => {
    render(<NewKYCPage />);
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/api/kyc/K1'))).toBe(true),
    );

    // A RE_KYC_REQUIRED deep-link auto-skips Step 1 (Select Outlet) → the wizard
    // lands directly on Details, where the GST field + summary banner live. No click.

    // Summary banner names the flagged field.
    const banner = await screen.findByTestId('rekyc-summary-banner');
    expect(banner).toHaveTextContent('GST Number');

    // The flagged GST input is EDITABLE (pre-filled, not disabled).
    const gstInput = screen.getByPlaceholderText('27AAPFU0939F1Z5') as HTMLInputElement;
    expect(gstInput).toHaveValue('27AAPFU0939F1Z5');
    expect(gstInput).not.toBeDisabled();

    // A non-flagged Details field (PAN) is LOCKED.
    expect(screen.getByPlaceholderText('AAPFU0939F')).toBeDisabled();

    // Details → Address step (City field lives here)
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }));

    // The non-flagged City input is pre-filled but DISABLED (locked for reference).
    const cityInput = await screen.findByPlaceholderText('City') as HTMLInputElement;
    expect(cityInput).toHaveValue('Pune');
    expect(cityInput).toBeDisabled();
  });
});
