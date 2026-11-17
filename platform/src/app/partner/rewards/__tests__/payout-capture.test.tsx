/// <reference types="vitest/globals" />
/**
 * PC — Partner Rewards · Cash Payout inline capture sheet (captureBankAtRedemption)
 *
 * The Cash-Payout dead-end ("Bank / UPI details needed → Go to KYC") is replaced, ONLY
 * when the per-tenant feature `captureBankAtRedemption` is ON, by an inline capture sheet
 * that reuses the KYC BankOrUpiSection + payment-type rules. Flag OFF ⇒ the dead-end card is
 * byte-identical (Deoleo + every non-opted tenant unchanged).
 *
 *   PC1: flag OFF              → dead-end card renders, NO capture sheet
 *   PC2: flag ON + no beneficiary               → capture sheet renders (no dead-end)
 *   PC3: flag ON + paymentDetailsStatus NEEDS_RECAPTURE (beneficiary fields present)
 *                                               → capture sheet STILL renders (re-prompt)
 *   PC4: submit happy path → POST /api/partner/payout-details, THEN re-fetch /api/auth/me
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

// Loyalty-enabled, points-active partner → reaches the catalogue.
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Kumar Store', ownerName: 'Rajesh', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false,
    loyaltyEnabled: true,
  }),
}));

// Gifsy settings are read through a MUTABLE ref so individual tests can flip the salesApp
// gates. Default: upiEnabled:false → BankOrUpiSection forces BANK mode (no toggle, cheque
// required) — the deterministic path for the bank submit test (QR is not drivable in jsdom).
// The UPI-validation test flips upiEnabled+upiManualEntry on to drive the manual UPI input.
const BANK_ONLY_SETTINGS = {
  pointsConversionRate: 1,
  minBankTransferAmount: 250,
  minVoucherFreeAmount: 250,
  redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
  salesApp: { upiEnabled: false } as { upiEnabled: boolean; upiManualEntry?: boolean },
};
const settingsRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => settingsRef.current,
}));

const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn(), toast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// jsqr is dynamically imported by BankOrUpiSection's QR poll; default = no QR in frame. The
// VPA7 test overrides it to "see" a UPI QR (camera APIs are stubbed by the global test setup).
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

import RewardsPage from '../page';
import jsqrDefault from 'jsqr';

// A FREE_AMOUNT cash catalog item (pointsCost 0 + a min) — the deterministic cash item.
const CASH_ITEM = {
  id: 'cash-1',
  name: 'Cash Payout',
  brand: 'Cash',
  category: 'Cash',
  pointsCost: 0,
  redemptionMode: 'BANK_TRANSFER',
  minRedemptionPoints: 500,
  available: true,
  isAffordable: true,
};

function catalogResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: { items: [CASH_ITEM], userBalance: 50_000, pagination: { page: 1, limit: 20, total: 1, pages: 1 } },
    }),
  };
}

/** A channelPartner with NO payout rails on file. */
const CP_EMPTY = { bankName: null, bankAccountNumber: null, ifscCode: null, upiId: null };
/** A channelPartner WITH bank details but flagged NEEDS_RECAPTURE (a prior payout failed). */
const CP_NEEDS_RECAPTURE = {
  bankName: 'Axis Bank', bankAccountNumber: '998877665544', bankAccountHolder: 'Test Partner',
  ifscCode: 'UTIB0001234', upiId: null, paymentMode: 'BANK_TRANSFER',
  paymentDetailsStatus: 'NEEDS_RECAPTURE',
};

interface FetchOpts {
  captureBankAtRedemption: boolean;
  channelPartner: Record<string, unknown>;
  docResult?: { ok?: boolean; body: unknown };
  payoutResult?: { ok?: boolean; body: unknown };
}

/** Build a URL-routed fetch mock covering catalog, wishlist, partner/me (features), auth/me,
 *  and the two capture POSTs. Returns the mock so tests can inspect `.mock.calls`. */
function makeFetch(opts: FetchOpts) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogResponse());
    if (url.includes('/api/partner/me')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { features: { captureBankAtRedemption: opts.captureBankAtRedemption } },
        }),
      });
    }
    if (url.includes('/api/partner/documents')) {
      const r = opts.docResult ?? { ok: true, body: { success: true, data: { fileKey: 'chk_1', fileUrl: 'u1' } } };
      return Promise.resolve({ ok: r.ok ?? true, json: () => Promise.resolve(r.body) });
    }
    if (url.includes('/api/partner/payout-details')) {
      const r = opts.payoutResult ?? { ok: true, body: { success: true, data: {} } };
      return Promise.resolve({ ok: r.ok ?? true, json: () => Promise.resolve(r.body) });
    }
    if (url.includes('/api/auth/me')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { conversionRate: 1, user: { channelPartner: opts.channelPartner } },
        }),
      });
    }
    // wishlist + anything else
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  });
}

async function openCashTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /cash payout/i }));
}

beforeEach(() => {
  pushMock.mockClear();
  toastError.mockClear();
  // Reset to the bank-only default before every test (fresh copy so a test's override can't leak).
  settingsRef.current = { ...BANK_ONLY_SETTINGS, salesApp: { upiEnabled: false } };
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('PC — Cash Payout inline capture sheet (captureBankAtRedemption)', () => {
  it('PC1: flag OFF → the dead-end card renders and NO capture sheet appears', async () => {
    vi.stubGlobal('fetch', makeFetch({ captureBankAtRedemption: false, channelPartner: CP_EMPTY }));
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openCashTab(user);

    expect(await screen.findByTestId('cash-no-beneficiary')).toBeInTheDocument();
    expect(screen.queryByTestId('payout-capture-sheet')).not.toBeInTheDocument();
  });

  it('PC2: flag ON + no beneficiary → the capture sheet renders (no dead-end)', async () => {
    vi.stubGlobal('fetch', makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY }));
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openCashTab(user);

    expect(await screen.findByTestId('payout-capture-sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('cash-no-beneficiary')).not.toBeInTheDocument();
  });

  it('PC3: flag ON + NEEDS_RECAPTURE (beneficiary fields present) → capture sheet still renders', async () => {
    vi.stubGlobal('fetch', makeFetch({ captureBankAtRedemption: true, channelPartner: CP_NEEDS_RECAPTURE }));
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openCashTab(user);

    // Re-prompt even though bank fields exist — the capture sheet shows, not the "On file" card.
    expect(await screen.findByTestId('payout-capture-sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('cash-tab-bank')).not.toBeInTheDocument();
  });

  it('PC4: submit posts /api/partner/payout-details, then re-fetches /api/auth/me', async () => {
    const fetchMock = makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY });
    vi.stubGlobal('fetch', fetchMock);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openCashTab(user);

    await screen.findByTestId('payout-capture-sheet');

    // Fill the bank fields (BankOrUpiSection is forced to bank mode — upiEnabled:false).
    fireEvent.change(screen.getByPlaceholderText('HDFC Bank'),        { target: { value: 'Axis Bank' } });
    fireEvent.change(screen.getByTestId('account-holder-name-input'), { target: { value: 'Test Partner' } });
    fireEvent.change(screen.getByPlaceholderText('Account number'),   { target: { value: '998877665544' } });
    fireEvent.change(screen.getByPlaceholderText('HDFC0001234'),      { target: { value: 'UTIB0001234' } });

    // Upload the cancelled cheque → POST /api/partner/documents returns { fileKey }.
    const chequeFile = new File(['cheque-bytes'], 'cheque.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('payout-cheque-input'), { target: { files: [chequeFile] } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/partner/documents', expect.objectContaining({ method: 'POST' })),
    );

    const meCallsBefore = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/auth/me')).length;

    // Submit → POST /api/partner/payout-details.
    await user.click(await screen.findByTestId('payout-capture-submit'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => u === '/api/partner/payout-details');
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.paymentMode).toBe('bank');
      expect(body.chequeFileKey).toBe('chk_1');
      expect(body.ifscCode).toBe('UTIB0001234');
      // Bank mode sends ONLY bank fields — never a upiId.
      expect(body).not.toHaveProperty('upiId');
    });

    // …then the sheet triggers a re-fetch of /api/auth/me so partnerHasBeneficiary refreshes.
    await waitFor(() => {
      const meCallsAfter = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/auth/me')).length;
      expect(meCallsAfter).toBeGreaterThan(meCallsBefore);
    });
  });

  it('PC5: invalid manual UPI is blocked by isValidUpiId BEFORE submit (no POST)', async () => {
    // Enable UPI + manual entry so the manual UPI <input> is drivable in jsdom.
    settingsRef.current = {
      ...BANK_ONLY_SETTINGS,
      salesApp: { upiEnabled: true, upiManualEntry: true },
    };
    const fetchMock = makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY });
    vi.stubGlobal('fetch', fetchMock);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openCashTab(user);

    await screen.findByTestId('payout-capture-sheet');

    // Switch to UPI mode, then type an invalid VPA into the manual input.
    await user.click(await screen.findByRole('button', { name: /upi id/i }));
    fireEvent.change(await screen.findByTestId('manual-upi-input'), { target: { value: 'notaupi' } });

    // Submit → the new isValidUpiId gate blocks it inline; NO payout-details POST fires.
    await user.click(screen.getByTestId('payout-capture-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('payout-capture-error')).toHaveTextContent(/valid upi id/i);
    });
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/partner/payout-details')).toBe(false);
  });

  it('PC6: a padded valid manual UPI is trimmed → POST carries the trimmed upiId and NO bank fields', async () => {
    settingsRef.current = {
      ...BANK_ONLY_SETTINGS,
      salesApp: { upiEnabled: true, upiManualEntry: true },
    };
    const fetchMock = makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY });
    vi.stubGlobal('fetch', fetchMock);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openCashTab(user);

    await screen.findByTestId('payout-capture-sheet');
    await user.click(await screen.findByRole('button', { name: /upi id/i }));
    fireEvent.change(await screen.findByTestId('manual-upi-input'), { target: { value: '  shop@okaxis  ' } });
    // Typed ID → the type-it-twice confirm field is required (VPA safeguards).
    fireEvent.change(await screen.findByTestId('manual-upi-confirm-input'), { target: { value: ' shop@okaxis ' } });

    await user.click(screen.getByTestId('payout-capture-submit'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => u === '/api/partner/payout-details');
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toEqual({
        paymentMode: 'upi', upiId: 'shop@okaxis', upiIdConfirm: 'shop@okaxis', upiCaptureMethod: 'MANUAL',
      });
    });
  });

  it('PC7: a whitespace-only manual UPI is blocked with the EMPTY-state copy (no POST)', async () => {
    settingsRef.current = {
      ...BANK_ONLY_SETTINGS,
      salesApp: { upiEnabled: true, upiManualEntry: true },
    };
    const fetchMock = makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY });
    vi.stubGlobal('fetch', fetchMock);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openCashTab(user);

    await screen.findByTestId('payout-capture-sheet');
    await user.click(await screen.findByRole('button', { name: /upi id/i }));
    fireEvent.change(await screen.findByTestId('manual-upi-input'), { target: { value: '   ' } });

    await user.click(screen.getByTestId('payout-capture-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('payout-capture-error')).toHaveTextContent('Enter or scan your UPI ID to continue');
    });
    expect(await screen.findByTestId('payout-capture-error')).not.toHaveTextContent(/valid upi id/i);
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/partner/payout-details')).toBe(false);
  });
});

/* ─── VPA safeguards: type-it-twice for a typed UPI ID; QR captures skip it ───────────── */
describe('PC-VPA — UPI capture method + confirm entry', () => {
  const MANUAL_SETTINGS = () => ({ ...BANK_ONLY_SETTINGS, salesApp: { upiEnabled: true, upiManualEntry: true } });

  async function openUpiSheet(fetchMock: ReturnType<typeof makeFetch>) {
    vi.stubGlobal('fetch', fetchMock);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openCashTab(user);
    await screen.findByTestId('payout-capture-sheet');
    await user.click(screen.getByRole('button', { name: /upi id/i }));
    return user;
  }
  const payoutCall = (fetchMock: ReturnType<typeof makeFetch>) =>
    fetchMock.mock.calls.find(([u]) => u === '/api/partner/payout-details');

  afterEach(() => { vi.mocked(jsqrDefault).mockReset(); vi.mocked(jsqrDefault).mockReturnValue(null); });

  it('VPA1: a typed UPI ID shows the "Re-enter UPI ID" field with the manual-input keyboard attrs', async () => {
    settingsRef.current = MANUAL_SETTINGS();
    await openUpiSheet(makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY }));

    expect(screen.queryByTestId('manual-upi-confirm-input')).not.toBeInTheDocument();
    fireEvent.change(await screen.findByTestId('manual-upi-input'), { target: { value: 'shop@okaxis' } });

    const confirm = await screen.findByTestId('manual-upi-confirm-input');
    expect(await screen.findByLabelText('Re-enter UPI ID *')).toBe(confirm);
    expect(confirm).toHaveAttribute('autocapitalize', 'none');
    expect(confirm).toHaveAttribute('autocorrect', 'off');
    expect(confirm).toHaveAttribute('spellcheck', 'false');
    expect(confirm).toHaveAttribute('inputmode', 'email');
    expect(confirm).toHaveAttribute('autocomplete', 'off');
    expect(confirm).toHaveAttribute('maxlength', '100');
  });

  it('VPA2: a mismatched confirm blocks submit with "UPI IDs do not match" and NO POST', async () => {
    settingsRef.current = MANUAL_SETTINGS();
    const fetchMock = makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY });
    const user = await openUpiSheet(fetchMock);

    fireEvent.change(await screen.findByTestId('manual-upi-input'), { target: { value: 'shop@okaxis' } });
    fireEvent.change(await screen.findByTestId('manual-upi-confirm-input'), { target: { value: 'shop@okaxsi' } });
    await user.click(screen.getByTestId('payout-capture-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('payout-capture-error')).toHaveTextContent('UPI IDs do not match');
    });
    expect(payoutCall(fetchMock)).toBeUndefined();
    // a11y: the error is announced (role=alert) and linked to the confirm input.
    const err = await screen.findByTestId('payout-capture-error');
    expect(err).toHaveAttribute('role', 'alert');
    const confirm = await screen.findByTestId('manual-upi-confirm-input');
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    expect(confirm.getAttribute('aria-describedby')).toBe(err.id);
    expect(err.id).not.toBe('');
  });

  it('VPA3: an empty confirm also blocks (no POST)', async () => {
    settingsRef.current = MANUAL_SETTINGS();
    const fetchMock = makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY });
    const user = await openUpiSheet(fetchMock);

    fireEvent.change(await screen.findByTestId('manual-upi-input'), { target: { value: 'shop@okaxis' } });
    await user.click(screen.getByTestId('payout-capture-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('payout-capture-error')).toHaveTextContent('UPI IDs do not match');
    });
    expect(payoutCall(fetchMock)).toBeUndefined();
  });

  it('VPA4: a case/space-different but matching confirm POSTs upiId + upiIdConfirm + MANUAL', async () => {
    settingsRef.current = MANUAL_SETTINGS();
    const fetchMock = makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY });
    const user = await openUpiSheet(fetchMock);

    fireEvent.change(await screen.findByTestId('manual-upi-input'), { target: { value: 'shop@okaxis' } });
    fireEvent.change(await screen.findByTestId('manual-upi-confirm-input'), { target: { value: '  Shop@OKAXIS ' } });
    await user.click(screen.getByTestId('payout-capture-submit'));

    await waitFor(() => {
      const call = payoutCall(fetchMock);
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        paymentMode: 'upi', upiId: 'shop@okaxis', upiIdConfirm: 'Shop@OKAXIS', upiCaptureMethod: 'MANUAL',
      });
    });
  });

  it('VPA5: paste into the confirm field is ALLOWED (partners copy their VPA from their UPI app); the second entry is still required', async () => {
    settingsRef.current = MANUAL_SETTINGS();
    const fetchMock = makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY });
    const user = await openUpiSheet(fetchMock);

    fireEvent.change(await screen.findByTestId('manual-upi-input'), { target: { value: 'shop@okaxis' } });
    const confirm = await screen.findByTestId('manual-upi-confirm-input');
    // fireEvent returns true when NO handler called preventDefault() → the paste goes through.
    const notPrevented = fireEvent.paste(confirm, { clipboardData: { getData: () => 'shop@okaxis' } });
    expect(notPrevented).toBe(true);
    // No mismatch flagged before a submit attempt.
    expect(confirm).not.toHaveAttribute('aria-invalid');
    // The second entry itself is still required: an un-filled confirm blocks the POST.
    await user.click(screen.getByTestId('payout-capture-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('payout-capture-error')).toHaveTextContent('UPI IDs do not match');
    });
    expect(payoutCall(fetchMock)).toBeUndefined();
  });

  it('VPA6: a server 400 message is surfaced as the error text', async () => {
    settingsRef.current = MANUAL_SETTINGS();
    const fetchMock = makeFetch({
      captureBankAtRedemption: true,
      channelPartner: CP_EMPTY,
      payoutResult: { ok: false, body: { success: false, error: 'UPI IDs do not match' } },
    });
    const user = await openUpiSheet(fetchMock);

    fireEvent.change(await screen.findByTestId('manual-upi-input'), { target: { value: 'shop@okaxis' } });
    fireEvent.change(await screen.findByTestId('manual-upi-confirm-input'), { target: { value: 'shop@okaxis' } });
    await user.click(screen.getByTestId('payout-capture-submit'));

    await waitFor(() => expect(payoutCall(fetchMock)).toBeTruthy());
    await waitFor(() => {
      expect(screen.getByTestId('payout-capture-error')).toHaveTextContent('UPI IDs do not match');
    });
  });

  it('VPA7: a QR-scanned UPI ID shows NO confirm field and POSTs upiCaptureMethod QR (no upiIdConfirm)', async () => {
    // QR-only tenant (no manual entry): the scan is the only capture path.
    settingsRef.current = { ...BANK_ONLY_SETTINGS, salesApp: { upiEnabled: true } };
    vi.mocked(jsqrDefault).mockReturnValue({
      data: 'upi://pay?pa=shop@okaxis&pn=Shop',
      location: {} as never, binaryData: [], chunks: [], version: 1,
    } as never);
    const fetchMock = makeFetch({ captureBankAtRedemption: true, channelPartner: CP_EMPTY });
    const user = await openUpiSheet(fetchMock);

    await user.click(await screen.findByRole('button', { name: /scan qr/i }));
    await waitFor(() => expect(screen.getByTestId('scanned-upi-display')).toHaveTextContent('shop@okaxis'), { timeout: 15_000 });
    expect(screen.queryByTestId('manual-upi-confirm-input')).not.toBeInTheDocument();

    await user.click(await screen.findByTestId('payout-capture-submit'));
    await waitFor(() => {
      const call = payoutCall(fetchMock);
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        paymentMode: 'upi', upiId: 'shop@okaxis', upiCaptureMethod: 'QR',
      });
    });
  }, 30_000);
});
