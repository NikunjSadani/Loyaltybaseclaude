/**
 * Re-KYC payout rail — default + lock (U1) and verbatim server rejections (U2).
 *
 * `existingKyc.paymentMode` = the partner's CURRENT payout rail. On a re-KYC the Bank step opens
 * on that rail, adjusted by WHICH payout fields the admin flagged:
 *   RL1: only non-routing payout flags (bankName)        → toggle LOCKED to the current rail (UPI) + note
 *   RL2: just ONE of accountNumber / ifscCode flagged    → LOCKED to the current rail (bank) + note
 *   RL3: only bank routing flagged (accountNumber+IFSC)  → default 'bank', toggle free, no note
 *   RL4: only UPI routing flagged (upiId) on a bank partner (bank stored → reachable) → default 'upi', toggle free, no note
 *   (Reachability rules in full — lib/payout-rail — are covered by kyc-rekyc-rail-rules.test.tsx.)
 *   RL5: an outlet MANDATE pins the mode                 → mandate wins over the rail lock (no note)
 *   RL6: a server 400 on submit is shown to the rep VERBATIM
 *
 * Harness mirrors kyc-consent-upi-summary: a RE_KYC_REQUIRED deep-link auto-skips Select Outlet
 * and the prior submission carries the required docs + both geo proofs so the step gates pass.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// requireLocation is DEFAULT ON since 2026-11-21 (LOCATION-GATE.md). These pre-gate cases model a tenant with the
// explicit emergency off (`requireLocation: false`) at the ONE shared seam, so their flows stay byte-identical.
// The default-ON / explicit-true paths are covered by the *location-gate* tests.
vi.mock('@/lib/location-required', () => ({ isLocationRequired: () => false }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...p }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...p}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

// UPI on + manual entry on (so the UPI panel renders an inspectable input).
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

const RAIL_LOCK_NOTE = "Payment method can't be changed in this re-KYC";

type Rail = 'upi' | 'bank';

const existingKyc = (rail: Rail) => ({
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

interface Scenario {
  rail: Rail;
  flags: Record<string, boolean>;
  requiredPaymentType?: 'BANK' | 'UPI' | 'ANY';
  /** Response to the POST /api/kyc submit (default: 200). */
  submitResponse?: { ok: boolean; body: unknown };
}

function install(sc: Scenario) {
  const posted: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/sales/outlets'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: [{
        id: 'OUT1', outletCode: 'OUT-1', name: 'Verma Traders', mobile: '7766554433',
        type: 'SSS', kycStatus: 'RE_KYC_REQUIRED', kycId: 'K1',
        ...(sc.requiredPaymentType ? { requiredPaymentType: sc.requiredPaymentType } : {}),
        existingKyc: existingKyc(sc.rail),
        reKycFlags: { ...sc.flags, remarks: 'Please re-check.' },
      }] } }) });
    if (u === '/api/kyc' && opts?.method === 'POST') {
      posted.push(JSON.parse(String(opts.body)));
      const r = sc.submitResponse ?? { ok: true, body: { success: true, data: { submissionId: 'S1' } } };
      return Promise.resolve({ ok: r.ok, status: r.ok ? 200 : 400, json: () => Promise.resolve(r.body) });
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
  await screen.findByTestId('rekyc-summary-banner', {}, { timeout: 15_000 });
  await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled(), { timeout: 15_000 });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByPlaceholderText('City', {}, { timeout: 15_000 });
  await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled(), { timeout: 15_000 });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByText('Bank Details', {}, { timeout: 15_000 });
  return utils;
}

const origGetContext = HTMLCanvasElement.prototype.getContext;
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
const ctxStub = {
  beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(),
  // QR poll (RL7) reads a frame — return an empty image so the (mocked) decoder no-ops.
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
  fillStyle: '', lineWidth: 0, lineCap: '', strokeStyle: '',
};

beforeEach(() => {
  vi.clearAllMocks();
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

describe('Re-KYC payout rail — default + lock', () => {
  it('RL1: only a non-routing payout field flagged (bankName) on a UPI partner → locked to UPI with the note', async () => {
    install({ rail: 'upi', flags: { bankName: true } });
    await walkToBankStep();
    expect(await screen.findByTestId('rekyc-rail-lock-note')).toHaveTextContent(RAIL_LOCK_NOTE);
    expect(screen.queryByTestId('payment-mode-toggle')).not.toBeInTheDocument();
    // UPI panel (the current rail) with the existing ID, locked (upiId not flagged).
    const upi = await screen.findByTestId('manual-upi-input');
    expect(upi).toHaveValue('verma@okaxis');
    expect(upi).toBeDisabled();
    expect(screen.queryByPlaceholderText('HDFC Bank')).not.toBeInTheDocument();
  }, 20000);

  it('RL2: just ONE of accountNumber / ifscCode flagged on a bank partner → locked to bank with the note', async () => {
    install({ rail: 'bank', flags: { ifscCode: true } });
    await walkToBankStep();
    expect(await screen.findByTestId('rekyc-rail-lock-note')).toHaveTextContent(RAIL_LOCK_NOTE);
    expect(screen.queryByTestId('payment-mode-toggle')).not.toBeInTheDocument();
    expect(await screen.findByPlaceholderText('HDFC0001234')).not.toBeDisabled(); // the flagged IFSC
    expect(await screen.findByPlaceholderText('Account number')).toBeDisabled();
    expect(screen.queryByTestId('manual-upi-input')).not.toBeInTheDocument();
  }, 20000);

  it('RL3: only bank routing flagged (accountNumber + ifscCode) on a UPI partner → defaults to bank, toggle free', async () => {
    install({ rail: 'upi', flags: { accountNumber: true, ifscCode: true } });
    await walkToBankStep();
    expect(screen.queryByTestId('rekyc-rail-lock-note')).not.toBeInTheDocument();
    expect(await screen.findByTestId('payment-mode-toggle')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /bank account/i })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByPlaceholderText('Account number')).not.toBeDisabled();
  }, 20000);

  it('RL4: only UPI routing flagged (upiId) on a bank partner → defaults to UPI, toggle free', async () => {
    install({ rail: 'bank', flags: { upiId: true } });
    await walkToBankStep();
    expect(screen.queryByTestId('rekyc-rail-lock-note')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /upi id/i })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByTestId('manual-upi-input')).not.toBeDisabled();
  }, 20000);

  it('RL5: an outlet mandate (BANK) wins over the rail lock of a UPI partner — bank panel, no lock note', async () => {
    install({ rail: 'upi', flags: { bankName: true }, requiredPaymentType: 'BANK' });
    await walkToBankStep();
    expect(screen.queryByTestId('rekyc-rail-lock-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-mode-toggle')).not.toBeInTheDocument();
    expect(await screen.findByPlaceholderText('HDFC Bank')).toBeInTheDocument();
    expect(screen.queryByTestId('manual-upi-input')).not.toBeInTheDocument();
  }, 20000);
});

describe('U8 — stable UPI handlers: the QR camera survives a parent re-render', () => {
  it('RL7: ticking a consent box while scanning does NOT restart the camera (one getUserMedia, no track stop)', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    try {
      install({ rail: 'bank', flags: { upiId: true } }); // defaults to UPI mode
      await walkToBankStep();
      fireEvent.click(screen.getByRole('button', { name: /scan qr code/i }));
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      await screen.findByTestId('qr-camera-view');

      // Parent state change → parent re-render (inline handlers would re-key the camera effect).
      fireEvent.click(screen.getByRole('checkbox', { name: /I agree to the/i }));
      fireEvent.click(screen.getByRole('checkbox', { name: /programme communications/i }));
      await new Promise((r) => setTimeout(r, 50));

      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(screen.getByTestId('qr-camera-view')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /stop scanning/i }));
    } finally {
      HTMLMediaElement.prototype.play = origPlay;
    }
  }, 20000);
});

describe('KYC submit — server rejection shown verbatim', () => {
  it('RL6: a 400 from POST /api/kyc surfaces the server message exactly', async () => {
    // (This UPI partner has no stored bank → bank is unreachable → the toggle is locked to UPI and
    // the rail-lock note is on screen, so use a different real server message to stay unambiguous.)
    const MSG = 'Flagged payout details not provided';
    const posted = install({
      rail: 'upi', flags: { upiId: true },
      submitResponse: { ok: false, body: { success: false, error: MSG } },
    });
    const { container } = await walkToBankStep();

    // Sign + both consents (payment geo is carried over from the prior submission).
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
    expect(posted[0].paymentMode).toBe('upi');
    expect(await screen.findByText(MSG)).toBeInTheDocument();
    // Never advanced to the OTP step.
    expect(screen.queryByText(/enter the otp/i)).not.toBeInTheDocument();
  }, 20000);
});
