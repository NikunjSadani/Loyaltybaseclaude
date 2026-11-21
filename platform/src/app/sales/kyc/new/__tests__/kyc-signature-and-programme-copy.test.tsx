/**
 * Owner 2026-11-14 (found while recording the Bajaj ISR training video):
 *   SIG-2  the "Signature required" / "To continue" hints below the pad must NOT disappear mid-stroke
 *          (that shrank the page and the pad jumped under the finger) — `hasSigned` flips on stroke END.
 *   COPY   the owner-OTP note named "Deoleo Loyalty Programme" on every tenant — it now uses the tenant's
 *          own display name, and neutral copy when the config has no tenant name (DEFAULT placeholder).
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
import { ClientConfigProvider } from '@/lib/platform/client-config-context';
import { DEFAULT_CLIENT_CONFIG } from '@/lib/platform/default-client-config';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...p }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...p}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));
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

const LOAD = { timeout: 15_000 };
const SIG_REQUIRED = 'Signature required to proceed.';

const existingKyc = {
  partnerName: 'Verma Traders', mobile: '7766554433',
  gstNumber: '27AAPFU0939F1Z5', panNumber: 'AAPFU0939F',
  address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
  bankName: 'HDFC Bank', accountHolderName: 'Suresh Verma', accountNumber: '123456789012', ifscCode: 'HDFC0001234',
  upiId: '', upiCaptureMethod: null, paymentMode: 'bank',
};
const SUBMISSION = { success: true, data: { submission: {
  id: 'K1', status: 'RE_KYC_REQUIRED',
  documents: ['GST_CERTIFICATE', 'SELFIE', 'SHOP_ESTABLISHMENT', 'STORE_BOARD_PHOTO', 'CANCELLED_CHEQUE'].map((t) => ({
    documentType: t, fileKey: `k/${t}.jpg`, fileUrl: `https://s/${t}.jpg`,
    viewUrl: 'data:image/jpeg;base64,AAAA', fileName: `${t}.jpg`, mimeType: 'image/jpeg', fileSizeBytes: 1000,
  })),
  boardPhotoLat: 18.52, boardPhotoLng: 73.85, boardPhotoGeoAccuracy: 10, boardPhotoGeoAt: '2026-06-01T00:00:00.000Z',
  paymentLat: 18.52, paymentLng: 73.85, paymentGeoAccuracy: 10, paymentGeoAt: '2026-06-01T00:00:00.000Z',
} } };

function install() {
  const posted: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/sales/outlets'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: [{
        id: 'OUT1', outletCode: 'OUT-1', name: 'Verma Traders', mobile: '7766554433',
        type: 'SSS', kycStatus: 'RE_KYC_REQUIRED', kycId: 'K1', existingKyc, reKycFlags: { remarks: 'Please re-check.' },
      }] } }) });
    if (u === '/api/kyc' && opts?.method === 'POST') {
      posted.push(JSON.parse(String(opts.body)));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { submissionId: 'S1' } }) });
    }
    if (u.includes('/api/kyc/K1')) return Promise.resolve({ ok: true, json: () => Promise.resolve(SUBMISSION) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
  return posted;
}

async function walkToBankStep(displayName?: string) {
  const page = <NewKYCPage />;
  const utils = render(displayName === undefined ? page : (
    <ClientConfigProvider config={{ ...DEFAULT_CLIENT_CONFIG, branding: { ...DEFAULT_CLIENT_CONFIG.branding, displayName } }}>
      {page}
    </ClientConfigProvider>
  ));
  await screen.findAllByDisplayValue('7766554433', {}, LOAD);
  await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled(), LOAD);
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByPlaceholderText('City', {}, LOAD);
  await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled(), LOAD);
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByText('Bank Details', {}, LOAD);
  return utils;
}

async function signConsentSubmit(container: HTMLElement, posted: Array<Record<string, unknown>>) {
  const canvas = container.querySelector('canvas') as HTMLCanvasElement;
  fireEvent.mouseDown(canvas, { clientX: 5, clientY: 5 });
  fireEvent.mouseMove(canvas, { clientX: 30, clientY: 30 });
  fireEvent.mouseUp(canvas);
  fireEvent.click(screen.getByRole('checkbox', { name: /I agree to the/i }));
  fireEvent.click(screen.getByRole('checkbox', { name: /programme communications/i }));
  const submit = await screen.findByRole('button', { name: /send otp to outlet owner/i });
  await waitFor(() => expect(submit).not.toBeDisabled(), LOAD);
  fireEvent.click(submit);
  await waitFor(() => expect(posted.length).toBe(1), LOAD);
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

describe('KYC signature pad — no layout change mid-stroke (SIG-2)', { timeout: 60_000 }, () => {
  it('the "Signature required" hint stays while the finger is down and goes only when the stroke ends', async () => {
    install();
    const { container } = await walkToBankStep();
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(await screen.findByText(SIG_REQUIRED)).toBeInTheDocument();
    fireEvent.touchStart(canvas, { touches: [{ clientX: 5, clientY: 5 }] });
    fireEvent.touchMove(canvas, { touches: [{ clientX: 30, clientY: 30 }] });
    fireEvent.touchMove(canvas, { touches: [{ clientX: 60, clientY: 20 }] });
    // mid-stroke: ink is drawn, but nothing below the pad has changed
    expect(ctxStub.stroke).toHaveBeenCalled();
    expect(screen.getByText(SIG_REQUIRED)).toBeInTheDocument();
    fireEvent.touchEnd(canvas);
    await waitFor(() => expect(screen.queryByText(SIG_REQUIRED)).not.toBeInTheDocument());
  });

  it('a tap with no movement (no ink) does not count as a signature', async () => {
    install();
    const { container } = await walkToBankStep();
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    fireEvent.mouseDown(canvas, { clientX: 5, clientY: 5 });
    fireEvent.mouseUp(canvas);
    expect(screen.getByText(SIG_REQUIRED)).toBeInTheDocument();
  });

  it('from the first touch the page height is pinned, so rows unmounting below cannot move the pad', async () => {
    install();
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 1234 });
    try {
      const { container } = await walkToBankStep();
      const root = screen.getByTestId('kyc-new-root');
      expect(root.style.minHeight).toBe('');
      const canvas = container.querySelector('canvas') as HTMLCanvasElement;
      fireEvent.touchStart(canvas, { touches: [{ clientX: 5, clientY: 5 }] });
      await waitFor(() => expect(root.style.minHeight).toBe('1234px'));
      fireEvent.touchMove(canvas, { touches: [{ clientX: 30, clientY: 30 }] });
      fireEvent.touchEnd(canvas);
      // the hint unmounts AFTER the stroke, but the page keeps its pinned height
      await waitFor(() => expect(screen.queryByText(SIG_REQUIRED)).not.toBeInTheDocument());
      expect(root.style.minHeight).toBe('1234px');
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    }
  });

  it('a second finger / palm mid-stroke does not reset the stroke (ink still counts on lift)', async () => {
    install();
    const { container } = await walkToBankStep();
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    fireEvent.touchStart(canvas, { touches: [{ clientX: 5, clientY: 5 }] });
    fireEvent.touchMove(canvas, { touches: [{ clientX: 30, clientY: 30 }] });
    fireEvent.touchStart(canvas, { touches: [{ clientX: 30, clientY: 30 }, { clientX: 90, clientY: 40 }] });
    fireEvent.touchEnd(canvas);
    await waitFor(() => expect(screen.queryByText(SIG_REQUIRED)).not.toBeInTheDocument());
  });

  it('a cancelled touch that drew ink still ends the stroke (counts as signed)', async () => {
    install();
    const { container } = await walkToBankStep();
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    fireEvent.touchStart(canvas, { touches: [{ clientX: 5, clientY: 5 }] });
    fireEvent.touchMove(canvas, { touches: [{ clientX: 30, clientY: 30 }] });
    fireEvent.touchCancel(canvas);
    await waitFor(() => expect(screen.queryByText(SIG_REQUIRED)).not.toBeInTheDocument());
  });
});

describe('Owner-OTP programme copy uses the tenant name (never a hard-coded "Deoleo")', { timeout: 60_000 }, () => {
  it('Bajaj sees its own name', async () => {
    const posted = install();
    const { container } = await walkToBankStep('Bajaj Consumer Care Ltd');
    await signConsentSubmit(container, posted);
    expect(await screen.findByText(/consent to enroll in the Bajaj Consumer Care Ltd Loyalty Programme\./, {}, LOAD)).toBeInTheDocument();
    expect(screen.queryByText(/Deoleo/)).not.toBeInTheDocument();
  });

  it('no tenant name resolved (platform DEFAULT config) → neutral copy, not "LoyaltyBase" or "Deoleo"', async () => {
    const posted = install();
    const { container } = await walkToBankStep();
    await signConsentSubmit(container, posted);
    expect(await screen.findByText(/consent to enroll in the Loyalty Programme\./, {}, LOAD)).toBeInTheDocument();
    expect(screen.queryByText(/LoyaltyBase Loyalty Programme|Deoleo/)).not.toBeInTheDocument();
  });
});
