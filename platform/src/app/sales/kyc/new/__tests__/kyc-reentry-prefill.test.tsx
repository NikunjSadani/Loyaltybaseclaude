/**
 * Regression: when a rejected / re-KYC outlet is re-opened (deep-link from the KYC
 * list "Edit & Resubmit"), the wizard must pre-fill the PREVIOUS submission's
 * documents & photos — not just the text fields. It does so by fetching that one
 * submission (GET /api/kyc/:id). A never-submitted (NOT_STARTED) outlet must NOT
 * trigger that fetch.
 *
 * RP1: a REJECTED outlet deep-link fetches GET /api/kyc/:kycId (doc/photo prefill)
 * RP2: a NOT_STARTED outlet does NOT fetch any prior submission
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

function outletsResponse(kycStatus: string, kycId: string) {
  return { success: true, data: { outlets: [{
    id: 'OUT1', outletCode: 'OUT-1', name: 'Verma Traders', mobile: '7766554433',
    type: 'SSS', kycStatus, kycId,
    existingKyc: { partnerName: 'Verma Traders', mobile: '7766554433', gstNumber: '', panNumber: '',
      address: '', city: '', state: '', pincode: '', bankName: '', accountNumber: '', ifscCode: '', upiId: '' },
    kycRejectionReason: 'GST document is blurry',
  }] } };
}

const SUBMISSION = { success: true, data: { submission: {
  id: 'K1', status: 'REJECTED', rejectionReason: 'GST document is blurry',
  documents: [
    { documentType: 'STORE_BOARD_PHOTO', fileKey: 'kyc/deoleo/board.jpg',
      fileUrl: 'https://storage.googleapis.com/b/board.jpg', viewUrl: 'data:image/jpeg;base64,AAAA',
      fileName: 'board.jpg', mimeType: 'image/jpeg', fileSizeBytes: 1000 },
    { documentType: 'SELFIE', fileKey: 'kyc/deoleo/selfie.jpg',
      fileUrl: 'https://storage.googleapis.com/b/selfie.jpg', viewUrl: 'data:image/jpeg;base64,BBBB',
      fileName: 'selfie.jpg', mimeType: 'image/jpeg', fileSizeBytes: 1000 },
  ],
  boardPhotoLat: 19.07, boardPhotoLng: 72.87, boardPhotoGeoAccuracy: 12, boardPhotoGeoAt: '2026-06-01T00:00:00.000Z',
} } };

function installFetch(kycStatus: string, kycId: string) {
  const calls: string[] = [];
  const fetchMock = vi.fn((url: string) => {
    calls.push(String(url));
    if (String(url).includes('/api/sales/outlets'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(outletsResponse(kycStatus, kycId)) });
    if (String(url).includes('/api/kyc/'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(SUBMISSION) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('token', 'tok');
  window.history.replaceState({}, '', '/sales/kyc/new?outletId=OUT1');
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('KYC re-entry prefill', () => {
  it('RP1: a REJECTED outlet deep-link fetches the prior submission to pre-fill docs/photos', async () => {
    const calls = installFetch('REJECTED', 'K1');
    render(<NewKYCPage />);
    await waitFor(() => expect(calls.some((u) => u.includes('/api/kyc/K1'))).toBe(true));
  });

  it('RP2: a NOT_STARTED outlet does NOT fetch any prior submission', async () => {
    const calls = installFetch('NOT_STARTED', '');
    render(<NewKYCPage />);
    await waitFor(() => expect(calls.some((u) => u.includes('/api/sales/outlets'))).toBe(true));
    // Give the deep-link + prefill effects a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((u) => u.includes('/api/kyc/'))).toBe(false);
  });

  it('RP3: switching from a re-entry outlet to a fresh outlet clears the carried-over docs (no leak)', async () => {
    // Deep-link a REJECTED outlet A (prefills its SELFIE/board photo), then switch to a
    // never-submitted outlet C via the picker. A's documents must NOT survive onto C —
    // the audited cross-outlet evidence-contamination defect. Without the per-outlet
    // reset the Owner Photo slot would still show A's carried-over preview.
    const calls: string[] = [];
    const outlets = { success: true, data: { outlets: [
      { id: 'OUT1', outletCode: 'O1', name: 'Outlet A', mobile: '7000000001', type: 'SSS', kycStatus: 'REJECTED', kycId: 'K1', existingKyc: null, kycRejectionReason: 'blurry' },
      { id: 'OUT3', outletCode: 'O3', name: 'Outlet C Fresh', mobile: '7000000003', type: 'SSS', kycStatus: 'NOT_STARTED', kycId: '', existingKyc: null },
    ] } };
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      calls.push(String(url));
      if (String(url).includes('/api/sales/outlets')) return Promise.resolve({ ok: true, json: () => Promise.resolve(outlets) });
      if (String(url).includes('/api/kyc/')) return Promise.resolve({ ok: true, json: () => Promise.resolve(SUBMISSION) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }));

    render(<NewKYCPage />);
    await waitFor(() => expect(calls.some((u) => u.includes('/api/kyc/K1'))).toBe(true)); // A prefilled
    fireEvent.click(await screen.findByTestId('outlet-dropdown-trigger'));
    fireEvent.click(await screen.findByTestId('outlet-option-OUT3'));               // switch to fresh C
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));             // → basic step
    // The Owner Photo slot must be empty (no carried-over preview) → camera prompt shows.
    expect(await screen.findByText(/tap to open camera/i)).toBeInTheDocument();
  });
});
