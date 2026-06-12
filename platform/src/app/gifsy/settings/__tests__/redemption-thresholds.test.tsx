/// <reference types="vitest/globals" />
/**
 * TDD — Redemption threshold settings
 *
 * Gifsy admin should be able to set tenant-level minimum redemption thresholds:
 *   - Minimum amount for bank/DBT transfer
 *   - Minimum amount for free-amount voucher redemption
 *
 * For Deoleo the default is ₹250 (both fields).
 *
 * U1: Settings page renders a "Redemption Thresholds" section
 * U2: Section contains an input with data-testid="settings-min-bank-transfer"
 * U3: Section contains an input with data-testid="settings-min-voucher"
 * U4: Default value shown in each input is 250 (Deoleo default)
 * U5: Saving persists the updated value — getGifsySettings() reflects the new amount
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import GifsySettingsPage from '../page';
import { getGifsySettings } from '@/lib/gifsy-settings';

describe('U — Redemption Threshold Settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('U1: page has a "Redemption Thresholds" section', () => {
    render(<GifsySettingsPage />);
    expect(
      screen.getByText(/redemption threshold/i),
    ).toBeInTheDocument();
  });

  it('U2: section contains min bank-transfer input', () => {
    render(<GifsySettingsPage />);
    expect(screen.getByTestId('settings-min-bank-transfer')).toBeInTheDocument();
  });

  it('U3: section contains min voucher input', () => {
    render(<GifsySettingsPage />);
    expect(screen.getByTestId('settings-min-voucher')).toBeInTheDocument();
  });

  it('U4: default value shown for both inputs is 250 (Deoleo default)', () => {
    render(<GifsySettingsPage />);
    const bankInput    = screen.getByTestId('settings-min-bank-transfer') as HTMLInputElement;
    const voucherInput = screen.getByTestId('settings-min-voucher')       as HTMLInputElement;
    expect(Number(bankInput.value)).toBe(250);
    expect(Number(voucherInput.value)).toBe(250);
  });

  it('U5: saving the section persists values to GifsySettings', async () => {
    render(<GifsySettingsPage />);
    const bankInput = screen.getByTestId('settings-min-bank-transfer') as HTMLInputElement;

    // Change min bank transfer to 500
    fireEvent.change(bankInput, { target: { value: '500' } });

    // Click the Save button in the Redemption Thresholds section
    const saveBtn = screen.getByTestId('settings-redemption-save');
    fireEvent.click(saveBtn);

    // After save, getGifsySettings() should reflect the new value
    await waitFor(() => {
      expect(getGifsySettings().minBankTransferAmount).toBe(500);
    });
  });
});
