/// <reference types="vitest/globals" />
/**
 * OTP SMS templates card (B11) — dedicated GIFSY_ADMIN-only endpoint.
 *
 * OT1: shows the STORED row as-is (Deoleo-style); empty purposes say "Using the global template";
 *      Save disabled until an edit
 * OT2: editing ONE purpose sends { clientId: <loaded tenant>, changes: { <only that purpose> } }
 * OT3: a non-24-hex id blocks Save client-side
 * OT4: a server refusal (409 brand changed) surfaces its message and keeps the draft
 * OT5: a failed READ shows the error + Retry and offers no inputs/Save; Retry recovers
 */

import React, { act } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getMock = vi.fn();
const putMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...a: unknown[]) => getMock(...a),
    put: (...a: unknown[]) => putMock(...a),
  },
}));

import { OtpTemplatesCard } from '../otp-templates-card';

const LOGIN = '6a391d46aaaaaaaaaaaaaaaa';
const KYC   = '6a391cf2bbbbbbbbbbbbbbbb';
const NEW   = '0123456789abcdef01234567';
const DEOLEO = { login: LOGIN, redemptionSelf: LOGIN, kycConsent: KYC, redemptionSales: '' };

async function renderCard(templates: unknown, clientId = 'deoleo') {
  getMock.mockResolvedValue({ success: true, data: { clientId, templates, stored: true } });
  await act(async () => { render(<OtpTemplatesCard />); });
  await screen.findByTestId('otp-tpl-login');
}

describe('OtpTemplatesCard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('OT1: shows the stored row as-is, marks empty purposes as global, Save disabled until an edit', async () => {
    await renderCard(DEOLEO);
    expect(getMock).toHaveBeenCalledWith('/api/admin/settings/otp-templates');
    expect(await screen.findByTestId('otp-tpl-login')).toHaveValue(LOGIN);
    expect(await screen.findByTestId('otp-tpl-kycConsent')).toHaveValue(KYC);
    expect(await screen.findByTestId('otp-tpl-redemptionSales')).toHaveValue('');
    expect(await screen.findByTestId('otp-tpl-redemptionSales-global')).toBeInTheDocument();
    expect(screen.queryByTestId('otp-tpl-login-global')).toBeNull();
    expect(await screen.findByTestId('otp-templates-save')).toBeDisabled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('OT2: editing one purpose sends only that change, bound to the loaded tenant', async () => {
    putMock.mockResolvedValue({ success: true, data: { clientId: 'deoleo', templates: { ...DEOLEO, redemptionSales: NEW } } });
    await renderCard(DEOLEO);
    fireEvent.change(screen.getByTestId('otp-tpl-redemptionSales'), { target: { value: ` ${NEW} ` } });
    fireEvent.click(screen.getByTestId('otp-templates-save'));
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    expect(putMock.mock.calls[0]).toEqual([
      '/api/admin/settings/otp-templates',
      { clientId: 'deoleo', changes: { redemptionSales: NEW } },
    ]);
    await waitFor(() => expect(screen.getByTestId('otp-templates-save')).toBeDisabled());
    // Login template untouched on screen.
    expect(await screen.findByTestId('otp-tpl-login')).toHaveValue(LOGIN);
  });

  it('OT3: a non-24-hex id blocks Save', async () => {
    await renderCard({ login: '', redemptionSelf: '', kycConsent: '', redemptionSales: '' });
    fireEvent.change(screen.getByTestId('otp-tpl-login'), { target: { value: 'my-template' } });
    expect(screen.getByTestId('otp-tpl-login')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('otp-templates-save')).toBeDisabled();
  });

  it('OT4: a 409 (brand changed in another tab) shows the server message and keeps the draft', async () => {
    putMock.mockResolvedValue({ success: false, status: 409, error: 'The brand changed in another tab since this card loaded — reload the page and try again.' });
    await renderCard(DEOLEO);
    fireEvent.change(screen.getByTestId('otp-tpl-redemptionSales'), { target: { value: NEW } });
    fireEvent.click(screen.getByTestId('otp-templates-save'));
    await waitFor(() => expect(screen.getByTestId('otp-templates-error')).toHaveTextContent('brand changed'));
    expect(await screen.findByTestId('otp-tpl-redemptionSales')).toHaveValue(NEW);
  });

  it('OT5: a failed READ shows error + Retry, no inputs/Save; Retry recovers', async () => {
    getMock.mockResolvedValueOnce({ success: false, error: 'Internal server error' });
    await act(async () => { render(<OtpTemplatesCard />); });
    await screen.findByTestId('otp-templates-load-error');
    expect(screen.queryByTestId('otp-tpl-login')).toBeNull();
    expect(screen.queryByTestId('otp-templates-save')).toBeNull();

    getMock.mockResolvedValueOnce({ success: true, data: { clientId: 'deoleo', templates: DEOLEO, stored: true } });
    fireEvent.click(screen.getByTestId('otp-templates-retry'));
    await screen.findByTestId('otp-tpl-login');
    expect(await screen.findByTestId('otp-tpl-login')).toHaveValue(LOGIN);
    expect(screen.queryByTestId('otp-templates-load-error')).toBeNull();
  });
});
