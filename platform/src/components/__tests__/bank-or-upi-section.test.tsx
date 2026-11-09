/**
 * TDD tests for BankOrUpiSection component.
 *
 * Covers:
 *   A) Mode toggle — switches between Bank Account and UPI ID panels
 *   B) Bank mode   — shows correct fields, hides UPI fields
 *   C) UPI mode    — NO manual input; QR scan is the only entry method
 *   D) QR scanner  — camera view lifecycle + onPaymentGeoTrigger callback
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock jsqr — the actual decode is exercised via upi-utils.test.ts
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

// Per-tenant UPI gate. The existing suites below assume UPI is available, so the default
// mock returns upiEnabled: true. The dedicated "UPI gate" describe overrides it per-test.
const getGifsySettingsMock = vi.fn(
  (): { salesApp: { upiEnabled: boolean; upiManualEntry?: boolean } } => ({ salesApp: { upiEnabled: true } }),
);
vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => getGifsySettingsMock(),
}));

import { BankOrUpiSection } from '../bank-or-upi-section';

/* ─── Fixtures ──────────────────────────────────────────────────────────────── */

const baseProps = {
  paymentMode:          'bank' as const,
  bankName:             '',
  accountHolderName:    '',
  accountNumber:        '',
  ifscCode:             '',
  upiId:                '',
  onPaymentModeChange:  vi.fn(),
  onFieldChange:        (_f: string) => (_e: React.ChangeEvent<HTMLInputElement>) => {},
  onUpiChange:          vi.fn(),
  onPaymentGeoTrigger:  vi.fn(),
};

const upiProps = { ...baseProps, paymentMode: 'upi' as const };

beforeEach(() => {
  vi.clearAllMocks();
  // Full reset (incl. any queued *Once values) then restore the default (UPI enabled, manual
  // entry OFF) — so a describe that turns manual entry ON can never leak into a later block.
  getGifsySettingsMock.mockReset();
  getGifsySettingsMock.mockReturnValue({ salesApp: { upiEnabled: true } });
});
afterEach(() => vi.useRealTimers());

/* ─── A: Mode toggle ────────────────────────────────────────────────────────── */

describe('mode toggle', () => {
  it('renders both Bank Account and UPI ID toggle buttons', () => {
    render(<BankOrUpiSection {...baseProps} />);
    expect(screen.getByRole('button', { name: /bank account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upi id/i })).toBeInTheDocument();
  });

  it('marks Bank Account tab as active in bank mode', () => {
    render(<BankOrUpiSection {...baseProps} />);
    expect(screen.getByRole('button', { name: /bank account/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks UPI ID tab as inactive in bank mode', () => {
    render(<BankOrUpiSection {...baseProps} />);
    expect(screen.getByRole('button', { name: /upi id/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks UPI ID tab as active in upi mode', () => {
    render(<BankOrUpiSection {...upiProps} />);
    expect(screen.getByRole('button', { name: /upi id/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onPaymentModeChange("upi") when UPI tab is clicked', async () => {
    const onPaymentModeChange = vi.fn();
    render(<BankOrUpiSection {...baseProps} onPaymentModeChange={onPaymentModeChange} />);
    await userEvent.click(screen.getByRole('button', { name: /upi id/i }));
    expect(onPaymentModeChange).toHaveBeenCalledWith('upi');
  });

  it('calls onPaymentModeChange("bank") when Bank Account tab is clicked in upi mode', async () => {
    const onPaymentModeChange = vi.fn();
    render(<BankOrUpiSection {...upiProps} onPaymentModeChange={onPaymentModeChange} />);
    await userEvent.click(screen.getByRole('button', { name: /bank account/i }));
    expect(onPaymentModeChange).toHaveBeenCalledWith('bank');
  });
});

/* ─── B: Bank mode ──────────────────────────────────────────────────────────── */

describe('bank mode', () => {
  it('shows Bank Name, Account Number, and IFSC fields', () => {
    render(<BankOrUpiSection {...baseProps} />);
    expect(screen.getByPlaceholderText(/hdfc bank/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/account number/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/HDFC0001234/i)).toBeInTheDocument();
  });

  it('renders children slot (cheque upload area)', () => {
    render(
      <BankOrUpiSection {...baseProps}>
        <div data-testid="cheque-slot">Cheque upload</div>
      </BankOrUpiSection>,
    );
    expect(screen.getByTestId('cheque-slot')).toBeInTheDocument();
  });

  it('does not show Scan QR button in bank mode', () => {
    render(<BankOrUpiSection {...baseProps} />);
    expect(screen.queryByRole('button', { name: /scan qr/i })).not.toBeInTheDocument();
  });
});

/* ─── C: UPI mode — QR scan only, NO manual text entry ─────────────────────── */

describe('upi mode — no manual entry', () => {
  it('does NOT show a manual UPI ID text input', () => {
    render(<BankOrUpiSection {...upiProps} />);
    // Previously the input had placeholder "9876543210@paytm" — must be absent
    expect(screen.queryByPlaceholderText(/9876543210@paytm/i)).not.toBeInTheDocument();
  });

  it('does NOT show an editable text field for UPI entry', () => {
    render(<BankOrUpiSection {...upiProps} />);
    // No <input> with type text/email should be present in UPI mode
    const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])');
    expect(inputs).toHaveLength(0);
  });

  it('does NOT show inline UPI validation error for an invalid UPI string', () => {
    // Validation errors are no longer shown inline since there is no manual input
    render(<BankOrUpiSection {...upiProps} upiId="notaupi" />);
    expect(screen.queryByText(/invalid upi/i)).not.toBeInTheDocument();
  });

  it('shows Scan QR Code button', () => {
    render(<BankOrUpiSection {...upiProps} />);
    expect(screen.getByRole('button', { name: /scan qr/i })).toBeInTheDocument();
  });

  it('hides bank fields in UPI mode', () => {
    render(<BankOrUpiSection {...upiProps} />);
    expect(screen.queryByPlaceholderText(/hdfc bank/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/account number/i)).not.toBeInTheDocument();
  });

  it('hides children slot (cheque upload) in UPI mode', () => {
    render(
      <BankOrUpiSection {...upiProps}>
        <div data-testid="cheque-slot">Cheque upload</div>
      </BankOrUpiSection>,
    );
    expect(screen.queryByTestId('cheque-slot')).not.toBeInTheDocument();
  });
});

/* ─── C: UPI mode — scanned UPI display ────────────────────────────────────── */

describe('upi mode — scanned UPI display', () => {
  it('does NOT show scanned UPI display when upiId is empty', () => {
    render(<BankOrUpiSection {...upiProps} upiId="" />);
    expect(screen.queryByTestId('scanned-upi-display')).not.toBeInTheDocument();
  });

  it('shows scanned UPI display when upiId prop is set', () => {
    render(<BankOrUpiSection {...upiProps} upiId="user@paytm" />);
    expect(screen.getByTestId('scanned-upi-display')).toBeInTheDocument();
  });

  it('shows the scanned UPI ID value in the display', () => {
    render(<BankOrUpiSection {...upiProps} upiId="9876543210@paytm" />);
    expect(screen.getByText('9876543210@paytm')).toBeInTheDocument();
  });

  it('calls onUpiChange("") when clear button on scanned UPI is clicked', async () => {
    const onUpiChange = vi.fn();
    render(<BankOrUpiSection {...upiProps} upiId="user@paytm" onUpiChange={onUpiChange} />);
    const clearBtn = screen.getByTestId('clear-scanned-upi');
    await userEvent.click(clearBtn);
    expect(onUpiChange).toHaveBeenCalledWith('');
  });
});

/* ─── E: Account Holder Name field ─────────────────────────────────────────── */

describe('account holder name field', () => {
  it('renders Account Holder Name input in bank mode', () => {
    render(<BankOrUpiSection {...baseProps} />);
    expect(screen.getByTestId('account-holder-name-input')).toBeInTheDocument();
  });

  it('shows placeholder "As printed on the passbook"', () => {
    render(<BankOrUpiSection {...baseProps} />);
    expect(screen.getByPlaceholderText(/as printed on the passbook/i)).toBeInTheDocument();
  });

  it('reflects the accountHolderName prop value', () => {
    render(<BankOrUpiSection {...baseProps} accountHolderName="Suresh Kumar" />);
    expect(screen.getByTestId('account-holder-name-input')).toHaveValue('Suresh Kumar');
  });

  it('calls onFieldChange("accountHolderName") when typed', async () => {
    const onFieldChange = vi.fn().mockReturnValue((_e: unknown) => {});
    render(<BankOrUpiSection {...baseProps} onFieldChange={onFieldChange} />);
    await userEvent.type(screen.getByTestId('account-holder-name-input'), 'A');
    expect(onFieldChange).toHaveBeenCalledWith('accountHolderName');
  });

  it('does NOT render Account Holder Name input in UPI mode', () => {
    render(<BankOrUpiSection {...baseProps} paymentMode="upi" />);
    expect(screen.queryByTestId('account-holder-name-input')).not.toBeInTheDocument();
  });
});

/* ─── D: QR scanner lifecycle ───────────────────────────────────────────────── */

describe('QR scanner', () => {
  it('does not show camera view initially', () => {
    render(<BankOrUpiSection {...upiProps} />);
    expect(screen.queryByTestId('qr-camera-view')).not.toBeInTheDocument();
  });

  it('shows camera view when Scan QR Code is clicked', async () => {
    render(<BankOrUpiSection {...upiProps} />);
    await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));
    await waitFor(() => {
      expect(screen.getByTestId('qr-camera-view')).toBeInTheDocument();
    });
  });

  it('shows Stop Scanning button when camera is active', async () => {
    render(<BankOrUpiSection {...upiProps} />);
    await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop scanning/i })).toBeInTheDocument();
    });
  });

  it('hides camera view when Stop Scanning is clicked', async () => {
    render(<BankOrUpiSection {...upiProps} />);
    await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));
    await waitFor(() => screen.getByRole('button', { name: /stop scanning/i }));
    await userEvent.click(screen.getByRole('button', { name: /stop scanning/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('qr-camera-view')).not.toBeInTheDocument();
    });
  });

  it('calls getUserMedia with back-camera preference when scanning starts', async () => {
    render(<BankOrUpiSection {...upiProps} />);
    await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));
    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({ video: expect.objectContaining({ facingMode: 'environment' }) }),
      );
    });
  });

  it('calls onPaymentGeoTrigger when QR scan detects a valid UPI ID', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Override jsqr to return a QR code with valid UPI on next call
    const jsqrModule = await import('jsqr');
    vi.mocked(jsqrModule.default).mockReturnValueOnce({
      data: 'upi://pay?pa=user@paytm&pn=Merchant&mc=0000',
      location: {} as any,
      binaryData: [],
      chunks: [],
      version: 1,
    });

    const onPaymentGeoTrigger = vi.fn();
    const onUpiChange = vi.fn();
    render(
      <BankOrUpiSection
        {...upiProps}
        onUpiChange={onUpiChange}
        onPaymentGeoTrigger={onPaymentGeoTrigger}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));

    // Advance past the 300ms interval
    await act(async () => { vi.advanceTimersByTime(400); });

    await waitFor(() => {
      expect(onPaymentGeoTrigger).toHaveBeenCalledOnce();
    });

    vi.useRealTimers();
  });

  it('calls onUpiChange with extracted UPI ID when QR scan succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const jsqrModule = await import('jsqr');
    vi.mocked(jsqrModule.default).mockReturnValueOnce({
      data: 'upi://pay?pa=user@paytm',
      location: {} as any,
      binaryData: [],
      chunks: [],
      version: 1,
    });

    const onUpiChange = vi.fn();
    render(
      <BankOrUpiSection
        {...upiProps}
        onUpiChange={onUpiChange}
        onPaymentGeoTrigger={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));
    await act(async () => { vi.advanceTimersByTime(400); });

    await waitFor(() => {
      expect(onUpiChange).toHaveBeenCalledWith('user@paytm');
    });

    vi.useRealTimers();
  });
});

/* ─── G: Optional manual UPI entry (salesApp.upiManualEntry) ────────────────── */

describe('UPI manual entry — salesApp.upiManualEntry', () => {
  describe('enabled (upiManualEntry === true)', () => {
    beforeEach(() => {
      getGifsySettingsMock.mockReturnValue({ salesApp: { upiEnabled: true, upiManualEntry: true } });
    });

    it('renders a manual UPI text input in UPI mode', () => {
      render(<BankOrUpiSection {...upiProps} />);
      expect(screen.getByTestId('manual-upi-input')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/yourname@bank/i)).toBeInTheDocument();
    });

    it('calls onUpiChange when typing into the manual input', async () => {
      const onUpiChange = vi.fn();
      render(<BankOrUpiSection {...upiProps} onUpiChange={onUpiChange} />);
      await userEvent.type(screen.getByTestId('manual-upi-input'), 'x');
      expect(onUpiChange).toHaveBeenCalledWith('x');
    });

    it('fires onPaymentGeoTrigger exactly once on the first keystroke of a fresh entry', async () => {
      const onPaymentGeoTrigger = vi.fn();
      render(<BankOrUpiSection {...upiProps} onPaymentGeoTrigger={onPaymentGeoTrigger} />);
      await userEvent.type(screen.getByTestId('manual-upi-input'), 'abc');
      expect(onPaymentGeoTrigger).toHaveBeenCalledOnce();
    });

    it('does NOT show the "Manual entry is not permitted." copy', () => {
      render(<BankOrUpiSection {...upiProps} />);
      expect(screen.queryByText(/manual entry is not permitted/i)).not.toBeInTheDocument();
    });

    it('keeps the Scan QR Code button available alongside manual entry', () => {
      render(<BankOrUpiSection {...upiProps} />);
      expect(screen.getByRole('button', { name: /scan qr/i })).toBeInTheDocument();
    });

    it('disables the manual input when the field is re-KYC locked', () => {
      render(<BankOrUpiSection {...upiProps} upiId="user@paytm" disabledFields={{ upiId: true }} />);
      expect(screen.getByTestId('manual-upi-input')).toBeDisabled();
    });

    it('sets mobile-friendly attributes + a required label on the manual input', () => {
      render(<BankOrUpiSection {...upiProps} />);
      const input = screen.getByTestId('manual-upi-input');
      expect(input).toHaveAttribute('autocapitalize', 'none');
      expect(input).toHaveAttribute('autocorrect', 'off');
      expect(input).toHaveAttribute('spellcheck', 'false');
      expect(input).toHaveAttribute('inputmode', 'email');
      expect(input).toHaveAttribute('autocomplete', 'off');
      expect(input).toHaveAttribute('maxlength', '100');
      expect(screen.getByLabelText('UPI ID *')).toBe(input);
      // The "*" is conveyed to assistive tech too.
      expect(input).toHaveAttribute('aria-required', 'true');
    });

    /* Controlled harness: the parent owns upiId (as KYC / payout-capture do), so a scan or a
       keystroke round-trips through the prop exactly like production. */
    function Controlled({ initial = '', onGeo }: { initial?: string; onGeo: () => void }) {
      const [upi, setUpi] = React.useState(initial);
      return <BankOrUpiSection {...upiProps} upiId={upi} onUpiChange={setUpi} onPaymentGeoTrigger={onGeo} />;
    }

    it('QR scan then a manual edit fires onPaymentGeoTrigger ONCE in total', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const jsqrModule = await import('jsqr');
      vi.mocked(jsqrModule.default).mockReturnValueOnce({
        data: 'upi://pay?pa=user@paytm',
        location: {} as any,
        binaryData: [],
        chunks: [],
        version: 1,
      });
      const onGeo = vi.fn();
      render(<Controlled onGeo={onGeo} />);

      await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));
      await act(async () => { vi.advanceTimersByTime(400); });
      await waitFor(() => expect(screen.getByTestId('manual-upi-input')).toHaveValue('user@paytm'));
      expect(onGeo).toHaveBeenCalledTimes(1);
      vi.useRealTimers();

      await userEvent.type(screen.getByTestId('manual-upi-input'), 'x');
      expect(screen.getByTestId('manual-upi-input')).toHaveValue('user@paytmx');
      expect(onGeo).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire geo when editing a UPI ID already present at mount', async () => {
      const onGeo = vi.fn();
      render(<Controlled initial="user@paytm" onGeo={onGeo} />);
      await userEvent.type(screen.getByTestId('manual-upi-input'), 'x');
      expect(screen.getByTestId('manual-upi-input')).toHaveValue('user@paytmx');
      expect(onGeo).not.toHaveBeenCalled();
    });

    it('re-arms after clearing: clear then type fires geo again', async () => {
      const onGeo = vi.fn();
      render(<Controlled onGeo={onGeo} />);
      const input = screen.getByTestId('manual-upi-input');
      await userEvent.type(input, 'a');
      expect(onGeo).toHaveBeenCalledTimes(1);
      await userEvent.clear(input);
      expect(input).toHaveValue('');
      await userEvent.type(input, 'b');
      expect(onGeo).toHaveBeenCalledTimes(2);
    });

    it('typing while the camera is scanning stops the scan', async () => {
      render(<Controlled onGeo={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));
      await waitFor(() => expect(screen.getByTestId('qr-camera-view')).toBeInTheDocument());
      await userEvent.type(screen.getByTestId('manual-upi-input'), 'a');
      await waitFor(() => expect(screen.queryByTestId('qr-camera-view')).not.toBeInTheDocument());
    });

    /* G6 — the fire-once geo guard seeds from `paymentGeoCaptured` when the parent provides it. */
    it('G6: a PRE-FILLED UPI with paymentGeoCaptured=false still fires geo ONCE on the first keystroke', async () => {
      const onGeo = vi.fn();
      function PrefilledNoGeo() {
        const [upi, setUpi] = React.useState('owner@okaxis'); // e.g. parent-prefilled child
        return (
          <BankOrUpiSection {...upiProps} upiId={upi} onUpiChange={setUpi}
            onPaymentGeoTrigger={onGeo} paymentGeoCaptured={false} />
        );
      }
      render(<PrefilledNoGeo />);
      await userEvent.type(screen.getByTestId('manual-upi-input'), 'xy');
      expect(screen.getByTestId('manual-upi-input')).toHaveValue('owner@okaxisxy');
      expect(onGeo).toHaveBeenCalledTimes(1);
    });

    it('G6: a pre-filled UPI with paymentGeoCaptured=true (e.g. re-KYC carried geo) does NOT re-fire geo on edit', async () => {
      const onGeo = vi.fn();
      function GeoAlready() {
        const [upi, setUpi] = React.useState('owner@okaxis');
        return (
          <BankOrUpiSection {...upiProps} upiId={upi} onUpiChange={setUpi}
            onPaymentGeoTrigger={onGeo} paymentGeoCaptured />
        );
      }
      render(<GeoAlready />);
      await userEvent.type(screen.getByTestId('manual-upi-input'), 'a');
      expect(screen.getByTestId('manual-upi-input')).toHaveValue('owner@okaxisa');
      expect(onGeo).not.toHaveBeenCalled();
    });

    /* G4 — a QR decode already in flight when the scan stops / typing begins is DROPPED. */
    async function startScanAndKickDecode(onStop: () => void) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const jsqrModule = await import('jsqr');
      vi.mocked(jsqrModule.default).mockReturnValue({
        data: 'upi://pay?pa=late@paytm',
        location: {} as any,
        binaryData: [],
        chunks: [],
        version: 1,
      });
      await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));
      await waitFor(() => expect(screen.getByTestId('qr-camera-view')).toBeInTheDocument());
      await act(async () => {}); // let getUserMedia/play resolve → the poll interval is armed
      // One poll tick kicks off a decode (its dynamic import resolves asynchronously); the
      // stop/typing happens in the SAME synchronous turn, i.e. while that decode is in flight.
      act(() => {
        vi.advanceTimersByTime(310);
        onStop();
      });
      await act(async () => { await vi.dynamicImportSettled(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      return jsqrModule;
    }

    it('G4: Stop Scanning while a decode is in flight → the late result is ignored (no value, no QR, no geo)', async () => {
      const onUpiChange = vi.fn();
      const onMethod = vi.fn();
      const onGeo = vi.fn();
      render(
        <BankOrUpiSection {...upiProps} onUpiChange={onUpiChange}
          onUpiCaptureMethodChange={onMethod} onPaymentGeoTrigger={onGeo} />,
      );
      const jsqrModule = await startScanAndKickDecode(() => {
        fireEvent.click(screen.getByRole('button', { name: /stop scanning/i }));
      });
      // The decode DID run to completion (non-vacuous) — its result was dropped.
      expect(jsqrModule.default).toHaveBeenCalled();
      expect(onUpiChange).not.toHaveBeenCalled();
      expect(onMethod).not.toHaveBeenCalledWith('QR');
      expect(onGeo).not.toHaveBeenCalled();
      expect(screen.queryByTestId('qr-camera-view')).not.toBeInTheDocument();
      vi.mocked(jsqrModule.default).mockReset();
      vi.mocked(jsqrModule.default).mockReturnValue(null);
    });

    it('G4: typing while a decode is in flight → the typed value survives and the method stays MANUAL', async () => {
      const onMethod = vi.fn();
      function Typed() {
        const [upi, setUpi] = React.useState('');
        return <BankOrUpiSection {...upiProps} upiId={upi} onUpiChange={setUpi} onUpiCaptureMethodChange={onMethod} />;
      }
      render(<Typed />);
      const jsqrModule = await startScanAndKickDecode(() => {
        fireEvent.change(screen.getByTestId('manual-upi-input'), { target: { value: 'typed@okaxis' } });
      });
      expect(jsqrModule.default).toHaveBeenCalled();
      expect(screen.getByTestId('manual-upi-input')).toHaveValue('typed@okaxis');
      expect(onMethod).toHaveBeenCalledWith('MANUAL');
      expect(onMethod).not.toHaveBeenCalledWith('QR');
      vi.mocked(jsqrModule.default).mockReset();
      vi.mocked(jsqrModule.default).mockReturnValue(null);
    });
  });

  describe('disabled (upiManualEntry falsy — default, byte-identical to today)', () => {
    beforeEach(() => {
      // Explicit: upiEnabled on, upiManualEntry absent → manual entry off.
      getGifsySettingsMock.mockReturnValue({ salesApp: { upiEnabled: true } });
    });

    it('does NOT render a manual UPI input', () => {
      render(<BankOrUpiSection {...upiProps} />);
      expect(screen.queryByTestId('manual-upi-input')).not.toBeInTheDocument();
    });

    it('SHOWS the "Manual entry is not permitted." copy', () => {
      render(<BankOrUpiSection {...upiProps} />);
      expect(screen.getByText(/manual entry is not permitted/i)).toBeInTheDocument();
    });
  });
});

/* ─── F: Per-tenant UPI gate (salesApp.upiEnabled) ──────────────────────────── */

describe('UPI gate — salesApp.upiEnabled', () => {
  describe('disabled (upiEnabled === false, the default)', () => {
    beforeEach(() => {
      getGifsySettingsMock.mockReturnValue({ salesApp: { upiEnabled: false } });
    });

    it('does NOT render the Bank/UPI mode toggle', () => {
      render(<BankOrUpiSection {...baseProps} />);
      expect(screen.queryByTestId('payment-mode-toggle')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /upi id/i })).not.toBeInTheDocument();
    });

    it('renders the bank-details fields only', () => {
      render(<BankOrUpiSection {...baseProps} />);
      expect(screen.getByTestId('account-holder-name-input')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/hdfc bank/i)).toBeInTheDocument();
    });

    it('does NOT offer the Scan QR affordance', () => {
      render(<BankOrUpiSection {...baseProps} />);
      expect(screen.queryByRole('button', { name: /scan qr/i })).not.toBeInTheDocument();
    });

    it('renders bank panel even when the controlled mode is upi', () => {
      render(<BankOrUpiSection {...upiProps} />);
      // Bank fields show; UPI QR panel does not.
      expect(screen.getByPlaceholderText(/hdfc bank/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /scan qr/i })).not.toBeInTheDocument();
    });

    it('forces the parent payment mode to bank when it is not already bank', () => {
      const onPaymentModeChange = vi.fn();
      render(<BankOrUpiSection {...upiProps} onPaymentModeChange={onPaymentModeChange} />);
      expect(onPaymentModeChange).toHaveBeenCalledWith('bank');
    });

    it('does NOT force the mode when already bank (no loop)', () => {
      const onPaymentModeChange = vi.fn();
      render(<BankOrUpiSection {...baseProps} onPaymentModeChange={onPaymentModeChange} />);
      expect(onPaymentModeChange).not.toHaveBeenCalled();
    });
  });

  describe('enabled (upiEnabled === true)', () => {
    beforeEach(() => {
      getGifsySettingsMock.mockReturnValue({ salesApp: { upiEnabled: true } });
    });

    it('renders the Bank/UPI mode toggle with the UPI option', () => {
      render(<BankOrUpiSection {...baseProps} />);
      expect(screen.getByTestId('payment-mode-toggle')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /upi id/i })).toBeInTheDocument();
    });

    it('offers the Scan QR affordance in UPI mode', () => {
      render(<BankOrUpiSection {...upiProps} />);
      expect(screen.getByRole('button', { name: /scan qr/i })).toBeInTheDocument();
    });

    it('does NOT force the mode to bank', () => {
      const onPaymentModeChange = vi.fn();
      render(<BankOrUpiSection {...upiProps} onPaymentModeChange={onPaymentModeChange} />);
      expect(onPaymentModeChange).not.toHaveBeenCalled();
    });
  });
});

/* ─── H: UPI capture-method provenance (VPA safeguards) ─────────────────────── */

describe('onUpiCaptureMethodChange — QR / MANUAL / null', () => {
  /* Controlled harness: parent owns upiId so scans/keystrokes round-trip like production. */
  function Controlled({ initial = '', onMethod }: { initial?: string; onMethod: (m: 'QR' | 'MANUAL' | null) => void }) {
    const [upi, setUpi] = React.useState(initial);
    return <BankOrUpiSection {...upiProps} upiId={upi} onUpiChange={setUpi} onUpiCaptureMethodChange={onMethod} />;
  }

  async function scanQr(vpa: string) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const jsqrModule = await import('jsqr');
    vi.mocked(jsqrModule.default).mockReturnValueOnce({
      data: `upi://pay?pa=${vpa}`,
      location: {} as any,
      binaryData: [],
      chunks: [],
      version: 1,
    });
    await userEvent.click(screen.getByRole('button', { name: /scan qr/i }));
    await act(async () => { vi.advanceTimersByTime(400); });
    vi.useRealTimers();
  }

  it('emits QR after a successful scan (QR-only tenant)', async () => {
    const onMethod = vi.fn();
    render(<Controlled onMethod={onMethod} />);
    await scanQr('user@paytm');
    await waitFor(() => expect(screen.getByTestId('scanned-upi-display')).toBeInTheDocument());
    expect(onMethod).toHaveBeenLastCalledWith('QR');
    expect(onMethod).not.toHaveBeenCalledWith('MANUAL');
  });

  it('emits null when a scanned ID is cleared via the clear button', async () => {
    const onMethod = vi.fn();
    render(<Controlled onMethod={onMethod} />);
    await scanQr('user@paytm');
    await waitFor(() => expect(screen.getByTestId('clear-scanned-upi')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('clear-scanned-upi'));
    expect(onMethod).toHaveBeenLastCalledWith(null);
  });

  describe('manual entry tenant', () => {
    beforeEach(() => {
      getGifsySettingsMock.mockReturnValue({ salesApp: { upiEnabled: true, upiManualEntry: true } });
    });

    it('emits MANUAL when typing into the manual input', async () => {
      const onMethod = vi.fn();
      render(<Controlled onMethod={onMethod} />);
      await userEvent.type(screen.getByTestId('manual-upi-input'), 'shop@upi');
      expect(onMethod).toHaveBeenLastCalledWith('MANUAL');
      expect(onMethod).not.toHaveBeenCalledWith('QR');
    });

    it('emits null when the typed value is cleared', async () => {
      const onMethod = vi.fn();
      render(<Controlled onMethod={onMethod} />);
      const input = screen.getByTestId('manual-upi-input');
      await userEvent.type(input, 'a');
      expect(onMethod).toHaveBeenLastCalledWith('MANUAL');
      await userEvent.clear(input);
      expect(onMethod).toHaveBeenLastCalledWith(null);
    });

    it('emits QR on scan, then MANUAL once the scanned value is hand-edited', async () => {
      const onMethod = vi.fn();
      render(<Controlled onMethod={onMethod} />);
      await scanQr('user@paytm');
      await waitFor(() => expect(screen.getByTestId('manual-upi-input')).toHaveValue('user@paytm'));
      expect(onMethod).toHaveBeenLastCalledWith('QR');
      await userEvent.type(screen.getByTestId('manual-upi-input'), 'x');
      expect(onMethod).toHaveBeenLastCalledWith('MANUAL');
    });
  });

  it('is optional — omitting it does not throw on scan or clear', async () => {
    function NoCb() {
      const [upi, setUpi] = React.useState('');
      return <BankOrUpiSection {...upiProps} upiId={upi} onUpiChange={setUpi} />;
    }
    render(<NoCb />);
    await scanQr('user@paytm');
    await waitFor(() => expect(screen.getByTestId('clear-scanned-upi')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('clear-scanned-upi'));
    expect(screen.queryByTestId('scanned-upi-display')).not.toBeInTheDocument();
  });

  /* U3: only a value decoded from a QR scan IN THIS SESSION is labelled "UPI ID Scanned"; a
     pre-filled UPI (re-KYC / group prefill) gets the neutral "UPI ID" label. */
  describe('scanned-display label honesty', () => {
    it('a PRE-FILLED UPI (not scanned this session) is labelled "UPI ID", not "UPI ID Scanned"', () => {
      render(<Controlled initial="prefilled@okaxis" onMethod={vi.fn()} />);
      expect(screen.getByTestId('scanned-upi-display')).toHaveTextContent('prefilled@okaxis');
      expect(screen.getByTestId('scanned-upi-label')).toHaveTextContent(/^UPI ID$/);
      expect(screen.queryByText('UPI ID Scanned')).not.toBeInTheDocument();
    });

    it('a value scanned THIS session is labelled "UPI ID Scanned"', async () => {
      render(<Controlled onMethod={vi.fn()} />);
      await scanQr('user@paytm');
      await waitFor(() => expect(screen.getByTestId('scanned-upi-label')).toHaveTextContent('UPI ID Scanned'));
    });

    it('re-scanning over a pre-filled value flips the label to "UPI ID Scanned"', async () => {
      render(<Controlled initial="prefilled@okaxis" onMethod={vi.fn()} />);
      expect(screen.getByTestId('scanned-upi-label')).toHaveTextContent(/^UPI ID$/);
      await scanQr('fresh@paytm');
      await waitFor(() => expect(screen.getByTestId('scanned-upi-display')).toHaveTextContent('fresh@paytm'));
      expect(screen.getByTestId('scanned-upi-label')).toHaveTextContent('UPI ID Scanned');
    });
  });
});
