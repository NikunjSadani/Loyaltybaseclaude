/**
 * VPA safeguards — the KYC Bank/Consent step shows the payout UPI ID in full where the owner
 * consents, with a "typed manually — please double-check" note when the ID was hand-typed.
 *
 *   CU1: UPI re-KYC whose stored ID was typed (MANUAL) → summary shows the ID + the manual note
 *   CU2: UPI re-KYC whose stored ID was scanned (QR)   → summary shows the ID, NO manual note
 *   CU3: typing a new ID on the step flips the note on (MANUAL), even from a QR-seeded value
 *
 * Harness mirrors rekyc-field-lock: a RE_KYC_REQUIRED deep-link auto-skips Select Outlet and the
 * prior submission carries the required docs + both geo proofs so the step gates pass.
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

// UPI on + manual entry on (the tenant config the safeguards target). Everything else = real defaults.
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return {
    ...actual,
    getGifsySettings: () => {
      const s = actual.getGifsySettings();
      return { ...s, salesApp: { ...s.salesApp, upiEnabled: true, upiManualEntry: true } };
    },
  };
});

import NewKYCPage from '../page';

const existingKyc = (upiCaptureMethod: 'QR' | 'MANUAL') => ({
  partnerName: 'Verma Traders', mobile: '7766554433',
  gstNumber: '27AAPFU0939F1Z5', panNumber: 'AAPFU0939F',
  address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
  bankName: '', accountHolderName: '', accountNumber: '', ifscCode: '',
  upiId: 'verma@okaxis', upiCaptureMethod,
});

const outletsResponse = (upiCaptureMethod: 'QR' | 'MANUAL') => ({
  success: true,
  data: { outlets: [{
    id: 'OUT1', outletCode: 'OUT-1', name: 'Verma Traders', mobile: '7766554433',
    type: 'SSS', kycStatus: 'RE_KYC_REQUIRED', kycId: 'K1',
    // Outlet mandate pins UPI so the step opens in UPI mode.
    requiredPaymentType: 'UPI',
    existingKyc: existingKyc(upiCaptureMethod),
    reKycFlags: { upiId: true, remarks: 'Re-confirm the UPI ID.' },
  }] },
});

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

function install(upiCaptureMethod: 'QR' | 'MANUAL') {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (String(url).includes('/api/sales/outlets'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(outletsResponse(upiCaptureMethod)) });
    if (String(url).includes('/api/kyc/'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(SUBMISSION) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

/** Deep-link lands on Details → Continue (Address) → Continue (Bank/Consent). */
async function walkToBankStep() {
  render(<NewKYCPage />);
  await waitFor(() =>
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/api/kyc/K1'))).toBe(true),
    { timeout: 15_000 },
  );
  await screen.findByTestId('rekyc-summary-banner', {}, { timeout: 15_000 });
  fireEvent.click(await screen.findByRole('button', { name: /continue/i }));
  await screen.findByPlaceholderText('City', {}, { timeout: 15_000 });
  await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled(), { timeout: 15_000 });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  return screen.findByTestId('consent-upi-summary', {}, { timeout: 15_000 });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('token', 'tok');
  window.history.replaceState({}, '', '/sales/kyc/new?outletId=OUT1');
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('KYC consent step — payout UPI ID summary', () => {
  it('CU1: a typed (MANUAL) UPI ID shows in full with the double-check note', async () => {
    install('MANUAL');
    const summary = await walkToBankStep();
    expect(summary).toHaveTextContent('Payouts will be sent to UPI ID: verma@okaxis');
    expect(await screen.findByTestId('consent-upi-manual-note')).toHaveTextContent('(typed manually — please double-check)');
  }, 20000);

  it('CU2: a scanned (QR) UPI ID shows in full WITHOUT the manual note', async () => {
    install('QR');
    const summary = await walkToBankStep();
    expect(summary).toHaveTextContent('Payouts will be sent to UPI ID: verma@okaxis');
    expect(screen.queryByTestId('consent-upi-manual-note')).not.toBeInTheDocument();
  }, 20000);

  it('CU3: hand-editing the ID on the step flips the note on and the summary tracks the new value', async () => {
    install('QR');
    await walkToBankStep();
    expect(screen.queryByTestId('consent-upi-manual-note')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('manual-upi-input'), { target: { value: 'verma2@okaxis' } });
    expect(screen.getByTestId('consent-upi-summary')).toHaveTextContent('verma2@okaxis');
    expect(screen.getByTestId('consent-upi-manual-note')).toBeInTheDocument();
  }, 20000);
});
