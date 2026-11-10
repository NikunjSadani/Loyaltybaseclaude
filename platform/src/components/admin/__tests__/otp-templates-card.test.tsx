/// <reference types="vitest/globals" />
/**
 * OTP SMS templates card (B11).
 *
 * OT1: a Deoleo-style stored row displays as-is; empty purposes say "Using the global template";
 *      nothing is saved without an edit (Save disabled)
 * OT2: editing one purpose saves the COMPLETE map (unchanged purposes keep their stored ids)
 * OT3: a non-24-hex id blocks Save client-side
 * OT4: a server refusal surfaces its message and keeps the draft
 */

import React, { act } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getMock = vi.fn();
const saveMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => getMock(...a) } }));
vi.mock('@/lib/gifsy-settings', () => ({ saveGifsySettingsDetailed: (...a: unknown[]) => saveMock(...a) }));

import { OtpTemplatesCard } from '../otp-templates-card';

const LOGIN = '6a391d46aaaaaaaaaaaaaaaa';
const KYC   = '6a391cf2bbbbbbbbbbbbbbbb';
const NEW   = '0123456789abcdef01234567';

async function renderCard(otpTemplates: unknown) {
  getMock.mockResolvedValue({ success: true, data: { otpTemplates } });
  await act(async () => { render(<OtpTemplatesCard />); });
  await screen.findByTestId('otp-tpl-login');
}

describe('OtpTemplatesCard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('OT1: shows the stored row as-is, marks empty purposes as global, Save disabled until an edit', async () => {
    await renderCard({ login: LOGIN, redemptionSelf: LOGIN, kycConsent: KYC, redemptionSales: '' });
    expect(getMock).toHaveBeenCalledWith('/api/settings');
    expect(screen.getByTestId('otp-tpl-login')).toHaveValue(LOGIN);
    expect(screen.getByTestId('otp-tpl-kycConsent')).toHaveValue(KYC);
    expect(screen.getByTestId('otp-tpl-redemptionSales')).toHaveValue('');
    expect(screen.getByTestId('otp-tpl-redemptionSales-global')).toBeInTheDocument();
    expect(screen.queryByTestId('otp-tpl-login-global')).toBeNull();
    expect(screen.getByTestId('otp-templates-save')).toBeDisabled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('OT2: editing one purpose saves the complete four-purpose map', async () => {
    saveMock.mockResolvedValue({ ok: true });
    await renderCard({ login: LOGIN, redemptionSelf: LOGIN, kycConsent: KYC, redemptionSales: '' });
    fireEvent.change(screen.getByTestId('otp-tpl-redemptionSales'), { target: { value: ` ${NEW} ` } });
    fireEvent.click(screen.getByTestId('otp-templates-save'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0][0]).toEqual({
      otpTemplates: { login: LOGIN, redemptionSelf: LOGIN, kycConsent: KYC, redemptionSales: NEW },
    });
    await waitFor(() => expect(screen.getByTestId('otp-templates-save')).toBeDisabled());
  });

  it('OT2b: an unset tenant (no row) shows all four empty → global', async () => {
    await renderCard(undefined);
    for (const k of ['login', 'redemptionSelf', 'kycConsent', 'redemptionSales']) {
      expect(screen.getByTestId(`otp-tpl-${k}`)).toHaveValue('');
      expect(screen.getByTestId(`otp-tpl-${k}-global`)).toBeInTheDocument();
    }
  });

  it('OT3: a non-24-hex id blocks Save', async () => {
    await renderCard({ login: '', redemptionSelf: '', kycConsent: '', redemptionSales: '' });
    fireEvent.change(screen.getByTestId('otp-tpl-login'), { target: { value: 'my-template' } });
    expect(screen.getByTestId('otp-tpl-login')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('otp-templates-save')).toBeDisabled();
  });

  it('OT4: a server refusal shows its message and keeps the draft', async () => {
    saveMock.mockResolvedValue({ ok: false, error: 'otpTemplates.login must be a 24-character MSG91 template id' });
    await renderCard({ login: '', redemptionSelf: '', kycConsent: '', redemptionSales: '' });
    fireEvent.change(screen.getByTestId('otp-tpl-login'), { target: { value: NEW } });
    fireEvent.click(screen.getByTestId('otp-templates-save'));
    await waitFor(() => expect(screen.getByTestId('otp-templates-error')).toHaveTextContent('24-character'));
    expect(screen.getByTestId('otp-tpl-login')).toHaveValue(NEW);
  });
});
