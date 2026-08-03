/**
 * PPL — Sales New-KYC: approved-parent pre-fill + group-PAN lock (Wave-3 grouped child)
 *
 * When an assigned outlet carries `parentPrefill` (present ONLY when it has an APPROVED
 * parent), a FRESH KYC pre-fills the owner identity/payout fields from the parent — all
 * EDITABLE except PAN, which is LOCKED to the group's canonical PAN (`groupPan`). When the
 * parent has no PAN yet (`groupPan` null) the fields still pre-fill but PAN stays editable.
 * No `parentPrefill` → the form behaves exactly as before.
 *
 * PPL1: parentPrefill → owner/GST pre-filled; PAN forced to groupPan (readonly + disabled + badge)
 * PPL2: groupPan null  → fields pre-filled but PAN NOT locked (editable, no badge)
 * PPL3: no parentPrefill → nothing pre-filled, PAN editable, no badge (unchanged behavior)
 * PPL4: RE-ENTRY (existingKyc) child that ALSO has a group PAN — the existing-KYC prefill
 *       must NOT clobber the pinned group PAN: the field DISPLAYS + SUBMITS groupPan, never
 *       the stale existingKyc PAN (the audit defect where display=groupPan but submit sent
 *       the old PAN → backend checkPanMatchesGroup hard-blocked on an uneditable field).
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

/** An approved parent's full identity + a canonical group PAN. */
const PARENT_PREFILL = {
  businessName: 'Sharma Traders HQ',
  ownerName: 'Anil Sharma',
  gstNumber: '27AABCS1429B1Z5',
  panNumber: 'AABCS1429B',
  bankName: 'HDFC Bank',
  bankAccountNumber: '50100000000012',
  bankAccountHolder: 'Anil K Sharma',
  ifscCode: 'HDFC0004832',
  upiId: 'anil@hdfc',
  groupPan: 'AABCS1429B',
};

/** A parent WITHOUT a PAN yet (no GST either → PAN must stay freely editable). */
const PARENT_NO_PAN = {
  ownerName: 'Ravi Kumar',
  panNumber: 'ZZZZZ9999Z',
  bankName: 'ICICI Bank',
  bankAccountNumber: '000111222333',
  bankAccountHolder: 'Ravi Kumar',
  ifscCode: 'ICIC0001234',
  upiId: '',
  groupPan: null,
};

function outletsResponse(parentPrefill: unknown) {
  return { success: true, data: { outlets: [{
    id: 'OUT1', outletCode: 'OUT-1', name: 'Sharma Branch 2', mobile: '',
    type: 'SSS', kycStatus: 'NOT_STARTED', kycId: '',
    ...(parentPrefill ? { parentPrefill } : {}),
  }] } };
}

function installFetch(parentPrefill: unknown) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (String(url).includes('/api/sales/outlets'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(outletsResponse(parentPrefill)) });
    // /api/sales/me (tenant features) + everything else → benign defaults.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

/** Select OUT1 via the dropdown (deterministic — sets selectedOutlet before Continue,
 *  unlike the deep-link whose effect races the button click for a NOT_STARTED outlet),
 *  then advance to the Details step. Mirrors the passing kyc-reentry-prefill RP3 flow. */
async function gotoDetails() {
  fireEvent.click(await screen.findByTestId('outlet-dropdown-trigger'));
  fireEvent.click(await screen.findByTestId('outlet-option-OUT1'));
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

// jsdom has no real canvas — stub getContext/toDataURL so the signature pad (drawing +
// the submit-time export) works. Harmless for PPL1-3 (they never touch the pad).
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
  // Neutral path (no ?outletId=) — selection is driven explicitly via the dropdown, so the
  // pre-fill provably fires from `parentPrefill`, not from a deep-link/existingKyc side effect.
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

describe('PPL — approved-parent pre-fill + group-PAN lock', () => {
  it('PPL1: pre-fills owner/GST and LOCKS PAN to the group PAN', async () => {
    installFetch(PARENT_PREFILL);
    render(<NewKYCPage />);
    await gotoDetails();

    // Owner + GST pre-filled from the parent.
    expect(await screen.findByDisplayValue('Anil Sharma')).toBeInTheDocument();   // Owner/Contact Name
    expect(screen.getByDisplayValue('27AABCS1429B1Z5')).toBeInTheDocument();      // GST

    // PAN forced to the group PAN, read-only + disabled, badged.
    const pan = screen.getByPlaceholderText('AAPFU0939F');
    expect(pan).toHaveValue('AABCS1429B');
    expect(pan).toBeDisabled();
    expect(pan).toHaveAttribute('readonly');
    expect(screen.getByTestId('group-pan-locked-badge')).toBeInTheDocument();
  });

  it('PPL2: groupPan null → pre-fills but PAN stays editable (no lock, no badge)', async () => {
    installFetch(PARENT_NO_PAN);
    render(<NewKYCPage />);
    await gotoDetails();

    expect(await screen.findByDisplayValue('Ravi Kumar')).toBeInTheDocument();     // Owner pre-filled

    // PAN pre-filled from the parent PAN but NOT locked (no GST, no group PAN).
    const pan = screen.getByPlaceholderText('AAPFU0939F');
    expect(pan).toHaveValue('ZZZZZ9999Z');
    expect(pan).not.toBeDisabled();
    expect(pan).not.toHaveAttribute('readonly');
    expect(screen.queryByTestId('group-pan-locked-badge')).not.toBeInTheDocument();
  });

  it('PPL3: no parentPrefill → nothing pre-filled, PAN editable, no badge', async () => {
    installFetch(null);
    render(<NewKYCPage />);
    await gotoDetails();

    const pan = await screen.findByPlaceholderText('AAPFU0939F');
    expect(pan).toHaveValue('');
    expect(pan).not.toBeDisabled();
    expect(pan).not.toHaveAttribute('readonly');
    expect(screen.queryByTestId('group-pan-locked-badge')).not.toBeInTheDocument();
    // Owner name is blank (no parent to seed from).
    expect(screen.getByPlaceholderText('Full name')).toHaveValue('');
  });
});

/* ── PPL4 — re-entry child with a group PAN: submit must send groupPan, not the stale
      existingKyc PAN. Drives the wizard to the real POST /api/kyc and inspects its body.
      The stale existingKyc PAN ('OLDPAN0000') differs from the group PAN ('AABCS1429B'):
      on the buggy code the existing-KYC prefill overwrote the pin → submit sent OLDPAN0000
      while the input still DISPLAYED the group PAN. ── */
const GROUP_PAN = 'AABCS1429B';
const STALE_PAN = 'OLDPAN0000';

/** A REJECTED (re-entry) outlet that carries BOTH existingKyc (stale PAN) AND a group PAN. */
function reentryOutletsResponse() {
  return { success: true, data: { outlets: [{
    id: 'OUT9', outletCode: 'OUT-9', name: 'Sharma Branch 9', mobile: '9812345678',
    type: 'SSS', kycStatus: 'REJECTED', kycId: 'K9',
    kycRejectionReason: 'GST document blurry',
    existingKyc: {
      partnerName: 'Anil Sharma', mobile: '9812345678', gstNumber: '27AABCS1429B1Z5',
      panNumber: STALE_PAN, address: '12 MG Road', city: 'Pune', state: 'Maharashtra',
      pincode: '411001', bankName: 'HDFC Bank', accountHolderName: 'Anil K Sharma',
      accountNumber: '50100000000012', ifscCode: 'HDFC0004832', upiId: '',
    },
    parentPrefill: { groupPan: GROUP_PAN, panNumber: GROUP_PAN },
  }] } };
}

/** The prior submission — supplies every required doc + both geo captures so the wizard
 *  can advance to Bank without on-device uploads/geolocation (all carried over on re-entry). */
const REENTRY_SUBMISSION = { success: true, data: { submission: {
  id: 'K9', status: 'REJECTED', addressNameMismatch: false,
  documents: ['GST_CERTIFICATE', 'SELFIE', 'SHOP_ESTABLISHMENT', 'STORE_BOARD_PHOTO', 'CANCELLED_CHEQUE'].map((t) => ({
    documentType: t, fileKey: `kyc/${t}.jpg`, fileUrl: `https://storage.googleapis.com/b/${t}.jpg`,
    viewUrl: 'data:image/jpeg;base64,AAAA', fileName: `${t}.jpg`, mimeType: 'image/jpeg', fileSizeBytes: 1000,
  })),
  boardPhotoLat: 18.52, boardPhotoLng: 73.85, boardPhotoGeoAccuracy: 10, boardPhotoGeoAt: '2026-06-01T00:00:00.000Z',
  paymentLat: 18.52, paymentLng: 73.85, paymentGeoAccuracy: 10, paymentGeoAt: '2026-06-01T00:00:00.000Z',
} } };

describe('PPL4 — re-entry child: submit sends the group PAN, not the stale existing PAN', () => {
  it('submits groupPan even though existingKyc holds a different PAN', async () => {
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/sales/outlets'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(reentryOutletsResponse()) });
      if (u === '/api/kyc' && opts?.method === 'POST') {
        posted.push(JSON.parse(String(opts.body)));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { submissionId: 'S9' } }) });
      }
      if (u.includes('/api/kyc/K9'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(REENTRY_SUBMISSION) });
      // consent-otp + /api/sales/me + everything else → benign OK.
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }));

    // Deep-link the re-entry outlet so it auto-selects (REJECTED stays on the outlet step).
    window.history.replaceState({}, '', '/sales/kyc/new?outletId=OUT9');
    const { container } = render(<NewKYCPage />);

    // Outlet step — wait for auto-selection + doc/geo prefill, then advance to Details.
    const outletContinue = await screen.findByRole('button', { name: /continue/i });
    await waitFor(() => expect(outletContinue).not.toBeDisabled());
    fireEvent.click(outletContinue);

    // The PAN input DISPLAYS the locked group PAN (not the stale existingKyc PAN).
    const pan = await screen.findByPlaceholderText('AAPFU0939F');
    expect(pan).toHaveValue(GROUP_PAN);
    expect(pan).toBeDisabled();

    // Details → Address: the "Continue" button enables once the carried-over docs settle.
    const detailsContinue = screen.getByRole('button', { name: /continue/i });
    await waitFor(() => expect(detailsContinue).not.toBeDisabled());
    fireEvent.click(detailsContinue);

    // Address → Bank.
    const addressContinue = await screen.findByRole('button', { name: /continue/i });
    await waitFor(() => expect(addressContinue).not.toBeDisabled());
    fireEvent.click(addressContinue);

    // Bank step — sign (draw on the pad → hasSigned) and tick both consents.
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    fireEvent.mouseDown(canvas, { clientX: 5, clientY: 5 });
    fireEvent.mouseMove(canvas, { clientX: 30, clientY: 30 });
    fireEvent.mouseUp(canvas);
    // KYC-H4: consent controls are now accessible role="checkbox" rows (whole row toggles);
    // query by the accessible name rather than the old <label><div> DOM structure.
    fireEvent.click(screen.getByRole('checkbox', { name: /I agree to the/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /programme communications/i }));

    const submit = await screen.findByRole('button', { name: /send otp to outlet owner/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    // The POST body carries the GROUP PAN — never the stale existingKyc PAN.
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].panNumber).toBe(GROUP_PAN);
    expect(posted[0].panNumber).not.toBe(STALE_PAN);
  });
});
