/**
 * Re-KYC payout rail — "never reject for something the rep can't fix" (lib/payout-rail, mirrors
 * the backend). allowed = permitted (tenant UPI gate + mandate) ∩ reachable (each routing field
 * editable OR stored). One allowed → locked; two → free; locked fields never block the step.
 *
 *   RR1 Deoleo-like: UPI OFF, live bank, upiId flagged → locked to bank (no re-KYC note), submit OK
 *   RR2 upiId flagged, live bank, UPI on, bank stored → default UPI, toggle FREE
 *   RR3 upiId flagged, live bank but NO stored IFSC → bank unreachable → locked to UPI + note
 *   RR4 accountNumber-only flagged on a live-UPI partner, no stored IFSC → locked to UPI + note
 *   RR5 blanket re-KYC (no field flags) → toggle free, opens on the live rail
 *   RR6 bank routing flagged on a live-UPI partner → bank chosen; the LOCKED (empty) bank name /
 *       holder never block the step → submit posts the typed account + IFSC
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// requireLocation is DEFAULT ON since 2026-11-21 (LOCATION-GATE.md). These pre-gate cases model a tenant with the
// explicit emergency off (`requireLocation: false`) at the ONE shared seam, so their flows stay byte-identical.
// The default-ON / explicit-true paths are covered by the *location-gate* tests.
vi.mock('@/lib/location-required', () => ({ isLocationRequired: () => false }));
vi.mock('@/lib/use-location-setting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-location-setting')>()),
  useLocationSetting: () => ({ lastKnown: false, gateEnabled: false, requireForForm: false, captureHold: false, settingsNote: false }),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...p }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...p}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

const tenant = vi.hoisted(() => ({ upiEnabled: true }));
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return {
    ...actual,
    getGifsySettings: () => {
      const s = actual.getGifsySettings();
      return { ...s, salesApp: { ...s.salesApp, upiEnabled: tenant.upiEnabled, upiManualEntry: true } };
    },
  };
});

import NewKYCPage from '../page';

const RAIL_LOCK_NOTE = "Payment method can't be changed in this re-KYC";
type Rail = 'upi' | 'bank';

const existingKyc = (rail: Rail, over: Record<string, unknown> = {}) => ({
  partnerName: 'Verma Traders', mobile: '7766554433',
  gstNumber: '27AAPFU0939F1Z5', panNumber: 'AAPFU0939F',
  address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
  bankName: rail === 'bank' ? 'HDFC Bank' : '',
  accountHolderName: rail === 'bank' ? 'Suresh Verma' : '',
  accountNumber: rail === 'bank' ? '123456789012' : '',
  ifscCode: rail === 'bank' ? 'HDFC0001234' : '',
  upiId: rail === 'upi' ? 'verma@okaxis' : '',
  upiCaptureMethod: rail === 'upi' ? 'QR' : null,
  paymentMode: rail,
  ...over,
});

const SUBMISSION = { success: true, data: { submission: {
  id: 'K1', status: 'RE_KYC_REQUIRED',
  documents: ['GST_CERTIFICATE', 'SELFIE', 'SHOP_ESTABLISHMENT', 'STORE_BOARD_PHOTO', 'CANCELLED_CHEQUE'].map((t) => ({
    documentType: t, fileKey: `k/${t}.jpg`, fileUrl: `https://s/${t}.jpg`,
    viewUrl: 'data:image/jpeg;base64,AAAA', fileName: `${t}.jpg`, mimeType: 'image/jpeg', fileSizeBytes: 1000,
  })),
  boardPhotoLat: 18.52, boardPhotoLng: 73.85, boardPhotoGeoAccuracy: 10, boardPhotoGeoAt: '2026-06-01T00:00:00.000Z',
  paymentLat: 18.52, paymentLng: 73.85, paymentGeoAccuracy: 10, paymentGeoAt: '2026-06-01T00:00:00.000Z',
} } };

function install(kyc: ReturnType<typeof existingKyc>, flags: Record<string, boolean>) {
  const posted: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/sales/outlets'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: [{
        id: 'OUT1', outletCode: 'OUT-1', name: 'Verma Traders', mobile: '7766554433',
        type: 'SSS', kycStatus: 'RE_KYC_REQUIRED', kycId: 'K1',
        existingKyc: kyc,
        reKycFlags: { ...flags, remarks: 'Please re-check.' },
      }] } }) });
    if (u === '/api/kyc' && opts?.method === 'POST') {
      posted.push(JSON.parse(String(opts.body)));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { submissionId: 'S1' } }) });
    }
    if (u.includes('/api/kyc/K1'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(SUBMISSION) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
  return posted;
}

/** Deep-link lands on Details → Continue (Address) → Continue (Bank). */
async function walkToBankStep() {
  const utils = render(<NewKYCPage />);
  await waitFor(() =>
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/api/kyc/K1'))).toBe(true),
    { timeout: 15_000 },
  );
  // Details step pre-filled from existingKyc (works for blanket re-KYC too — no summary banner).
  await screen.findAllByDisplayValue('7766554433', {}, { timeout: 15_000 });
  await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled(), { timeout: 15_000 });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByPlaceholderText('City', {}, { timeout: 15_000 });
  await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled(), { timeout: 15_000 });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByText('Bank Details', {}, { timeout: 15_000 });
  return utils;
}

/** Sign + both consents, then submit; resolves once the POST was sent. */
async function signConsentSubmit(container: HTMLElement, posted: Array<Record<string, unknown>>) {
  const canvas = container.querySelector('canvas') as HTMLCanvasElement;
  fireEvent.mouseDown(canvas, { clientX: 5, clientY: 5 });
  fireEvent.mouseMove(canvas, { clientX: 30, clientY: 30 });
  fireEvent.mouseUp(canvas);
  fireEvent.click(screen.getByRole('checkbox', { name: /I agree to the/i }));
  fireEvent.click(screen.getByRole('checkbox', { name: /programme communications/i }));
  const submit = await screen.findByRole('button', { name: /send otp to outlet owner/i });
  await waitFor(() => expect(submit).not.toBeDisabled(), { timeout: 15_000 });
  fireEvent.click(submit);
  await waitFor(() => expect(posted.length).toBe(1));
}

const origGetContext = HTMLCanvasElement.prototype.getContext;
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
const ctxStub = {
  beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
  fillStyle: '', lineWidth: 0, lineCap: '', strokeStyle: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  tenant.upiEnabled = true;
  localStorage.setItem('token', 'tok');
  window.history.replaceState({}, '', '/sales/kyc/new?outletId=OUT1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctxStub) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,SIG') as any;
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  HTMLCanvasElement.prototype.getContext = origGetContext;
  HTMLCanvasElement.prototype.toDataURL = origToDataURL;
});

describe('Re-KYC payout rail — reachability rules (mirrors the backend)', () => {
  it('RR1: Deoleo-like (UPI off, live bank, upiId flagged) → locked to bank, no re-KYC note, submit not blocked', async () => {
    tenant.upiEnabled = false;
    const posted = install(existingKyc('bank'), { upiId: true });
    const { container } = await walkToBankStep();
    expect(screen.queryByTestId('payment-mode-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rekyc-rail-lock-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('manual-upi-input')).not.toBeInTheDocument();
    const acct = await screen.findByPlaceholderText('Account number');
    expect(acct).toHaveValue('123456789012');
    expect(acct).toBeDisabled();
    await signConsentSubmit(container, posted);
    expect(posted[0].paymentMode).toBe('bank');
    expect(posted[0].accountNumber).toBe('123456789012');
  }, 20000);

  it('RR2: upiId flagged, live bank (complete), UPI on → default UPI and the toggle is free', async () => {
    install(existingKyc('bank'), { upiId: true });
    await walkToBankStep();
    expect(await screen.findByTestId('payment-mode-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('rekyc-rail-lock-note')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /upi id/i })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByTestId('manual-upi-input')).not.toBeDisabled();
  }, 20000);

  it('RR3: upiId flagged, live bank but NO stored IFSC → bank unreachable → locked to UPI with the note', async () => {
    install(existingKyc('bank', { ifscCode: '' }), { upiId: true });
    await walkToBankStep();
    expect(screen.queryByTestId('payment-mode-toggle')).not.toBeInTheDocument();
    expect(await screen.findByTestId('rekyc-rail-lock-note')).toHaveTextContent(RAIL_LOCK_NOTE);
    expect(await screen.findByTestId('manual-upi-input')).not.toBeDisabled();
  }, 20000);

  it('RR4: accountNumber-only flagged on a live-UPI partner (no stored IFSC) → locked to UPI with the note', async () => {
    install(existingKyc('upi'), { accountNumber: true });
    await walkToBankStep();
    expect(screen.queryByTestId('payment-mode-toggle')).not.toBeInTheDocument();
    expect(await screen.findByTestId('rekyc-rail-lock-note')).toHaveTextContent(RAIL_LOCK_NOTE);
    const upi = await screen.findByTestId('manual-upi-input');
    expect(upi).toHaveValue('verma@okaxis');
    expect(upi).toBeDisabled();
    expect(screen.queryByPlaceholderText('Account number')).not.toBeInTheDocument();
  }, 20000);

  it('RR5: blanket re-KYC (no field flags) → toggle free, opens on the live rail (UPI), no note', async () => {
    install(existingKyc('upi'), {});
    await walkToBankStep();
    expect(await screen.findByTestId('payment-mode-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('rekyc-rail-lock-note')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /upi id/i })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByTestId('manual-upi-input')).not.toBeDisabled();
  }, 20000);

  it('RR6: bank routing flagged on a live-UPI partner → locked empty bank name/holder never block the submit', async () => {
    const posted = install(existingKyc('upi'), { accountNumber: true, ifscCode: true });
    const { container } = await walkToBankStep();
    expect(await screen.findByRole('button', { name: /bank account/i })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByPlaceholderText('HDFC Bank')).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Account number'), { target: { value: '998877665544' } });
    fireEvent.change(screen.getByPlaceholderText('HDFC0001234'), { target: { value: 'ICIC0000001' } });
    await signConsentSubmit(container, posted);
    expect(posted[0].paymentMode).toBe('bank');
    expect(posted[0].accountNumber).toBe('998877665544');
    expect(posted[0].ifscCode).toBe('ICIC0000001');
  }, 20000);
});
