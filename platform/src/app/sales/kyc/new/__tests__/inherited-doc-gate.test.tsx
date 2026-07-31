/**
 * IDG — Sales New-KYC: inherited-document gate relaxation (grouped child, unchanged group details)
 *
 * When a grouped child's approved group source has a GST certificate / cancelled cheque on
 * file, the backend exposes `parentPrefill.gstCertInheritable` / `.chequeInheritable`. The FE
 * then RELAXES the required-upload gate for that doc, but ONLY while the corresponding fields
 * still match the group source (normalised: GST/IFSC upper+trim, account trim) AND the rep
 * hasn't uploaded a fresh doc. An "Inherited from group (approved)" note is shown on the card.
 *
 * These tests exercise the GST-certificate slot (reachable on the Details step). They validate:
 *   IDG1: gstCertInheritable=true + unchanged group GST → inherited note shown (gate relaxed)
 *   IDG2: rep edits GST to a DIFFERENT value → note gone (gate reverts to required)
 *   IDG3: gstCertInheritable absent/false → no note even with a matching GST
 *
 * The cancelled-cheque slot lives on the Bank step (step 4), reachable only after live camera
 * capture (owner photo, store-board photo) + two geolocation captures — impractical to stub in
 * jsdom. Its derived flag `chequeInherited` mirrors `gstCertInherited` field-for-field
 * (inheritable && normalised-match && !freshUpload, plus paymentMode==='bank'), so the same
 * logic is covered here by symmetry. See the report note.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...p }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...p}>{children}</a>,
}));
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

import NewKYCPage from '../page';

const GROUP_GST = '27AABCS1429B1Z5';

/** An approved parent that HAS a GST certificate + cheque available to inherit. */
function parentPrefill(extra: Record<string, unknown> = {}) {
  return {
    businessName: 'Sharma Traders HQ',
    ownerName: 'Anil Sharma',
    gstNumber: GROUP_GST,
    panNumber: 'AABCS1429B',
    bankName: 'HDFC Bank',
    bankAccountNumber: '50100000000012',
    bankAccountHolder: 'Anil K Sharma',
    ifscCode: 'HDFC0004832',
    upiId: 'anil@hdfc',
    groupPan: 'AABCS1429B',
    gstCertInheritable: true,
    chequeInheritable: true,
    ...extra,
  };
}

function outletsResponse(pf: unknown) {
  return { success: true, data: { outlets: [{
    id: 'OUT1', outletCode: 'OUT-1', name: 'Sharma Branch 2', mobile: '',
    type: 'SSS', kycStatus: 'NOT_STARTED', kycId: '',
    ...(pf ? { parentPrefill: pf } : {}),
  }] } };
}

function installFetch(pf: unknown) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (String(url).includes('/api/sales/outlets'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(outletsResponse(pf)) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

/** Select OUT1 via the dropdown, then advance to the Details step (mirrors PPL harness). */
async function gotoDetails() {
  fireEvent.click(await screen.findByTestId('outlet-dropdown-trigger'));
  fireEvent.click(await screen.findByTestId('outlet-option-OUT1'));
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

// jsdom canvas stubs (signature pad) — harmless for these Details-step tests.
const origGetContext = HTMLCanvasElement.prototype.getContext;
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
const ctxStub = {
  beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(),
  fillStyle: '', lineWidth: 0, lineCap: '', strokeStyle: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('token', 'tok');
  window.history.replaceState({}, '', '/sales/kyc/new');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctxStub) as any;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,SIG') as any;
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  HTMLCanvasElement.prototype.getContext = origGetContext;
  HTMLCanvasElement.prototype.toDataURL = origToDataURL;
});

describe('IDG — GST-certificate inherited-doc gate relaxation', () => {
  it('IDG1: gstCertInheritable + unchanged group GST → inherited note shown', async () => {
    installFetch(parentPrefill());
    render(<NewKYCPage />);
    await gotoDetails();

    // GST pre-filled from the group source.
    expect(await screen.findByDisplayValue(GROUP_GST)).toBeInTheDocument();
    // No fresh GST cert uploaded + GST unchanged → inherited note visible (gate relaxed).
    expect(screen.getByTestId('gst-cert-inherited-note')).toBeInTheDocument();
  });

  it('IDG2: editing GST to a different value removes the inherited note', async () => {
    installFetch(parentPrefill());
    render(<NewKYCPage />);
    await gotoDetails();

    expect(await screen.findByTestId('gst-cert-inherited-note')).toBeInTheDocument();

    // Rep edits GST away from the group value → derived flag false → note gone.
    const gst = screen.getByPlaceholderText('27AAPFU0939F1Z5');
    fireEvent.change(gst, { target: { value: '27ZZZZZ9999Z1Z5' } });

    expect(screen.queryByTestId('gst-cert-inherited-note')).not.toBeInTheDocument();
  });

  it('IDG3: gstCertInheritable absent → no inherited note even with a matching GST', async () => {
    installFetch(parentPrefill({ gstCertInheritable: false }));
    render(<NewKYCPage />);
    await gotoDetails();

    // GST still pre-filled + matching, but the group source has no cert to inherit.
    expect(await screen.findByDisplayValue(GROUP_GST)).toBeInTheDocument();
    expect(screen.queryByTestId('gst-cert-inherited-note')).not.toBeInTheDocument();
  });

  // IDG4 (re-KYC suppression — the audit HIGH fix) is NOT a runtime test here: driving a re-entry
  // outlet (existingKyc set) through the jsdom dropdown/nav is impractical (same harness limit that
  // keeps the cheque note out of runtime coverage). The guard itself is a single boolean —
  // `isFreshKyc = !selectedOutlet?.existingKyc`, ANDed into BOTH gstCertInherited/chequeInherited —
  // so a re-KYC child can never satisfy the waiver. The real safety net is server-side and IS unit-
  // tested: the backend group-carry is scoped to `!outlet.partnerId` (first KYC only) and rejects a
  // grouped child that would be left without a required, non-inheritable doc (kyc.service.spec).
});
