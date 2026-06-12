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
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock jsqr — the actual decode is exercised via upi-utils.test.ts
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

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

beforeEach(() => vi.clearAllMocks());
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
