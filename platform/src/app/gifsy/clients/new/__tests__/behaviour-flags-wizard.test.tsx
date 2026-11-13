/// <reference types="vitest/globals" />
/**
 * New-client wizard — Behaviour flags (B2).
 *
 * W1: an untouched wizard POSTs the module features ONLY (no behaviour keys) — identical to before
 * W2: switching outletMasterGeo ON adds ONLY `outletMasterGeo: true` to the POSTed features
 * W3: same for allowPayoutWithoutPan
 */

import React, { act } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ getToken: () => null }));

import OnboardClientPage from '../page';

function stubFetch(postSpy: (body: Record<string, unknown>) => void) {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      postSpy(JSON.parse(init.body as string));
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true, data: { id: 'newco' } }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { clients: [] } }) });
  }));
}

async function walkToFeatures() {
  await act(async () => { render(<OnboardClientPage />); });
  fireEvent.change(screen.getByPlaceholderText('e.g. reliance-retail'), { target: { value: 'newco' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. Reliance Retail Ltd.'), { target: { value: 'NewCo Ltd' } });
  fireEvent.click(screen.getByRole('button', { name: /Next/ })); // → branding
  fireEvent.click(screen.getByRole('button', { name: /Next/ })); // → features
  await screen.findByText('Behaviour flags');
}

async function submitFromFeatures() {
  fireEvent.click(screen.getByRole('button', { name: /Next/ })); // → review
  fireEvent.click(await screen.findByRole('button', { name: /Onboard Client/ }));
}

describe('New-client wizard — behaviour flags', () => {
  it('W4: Cancel on the allowPayoutWithoutPan confirm leaves it OFF; turning it OFF again needs no confirm', async () => {
    const postSpy = vi.fn();
    stubFetch(postSpy);
    await walkToFeatures();
    const sw = screen.getByTestId('wizard-behaviour-flag-allowPayoutWithoutPan');
    fireEvent.click(sw);
    fireEvent.click(within(await screen.findByTestId('behaviour-flag-confirm')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument());
    expect(sw).toHaveAttribute('aria-checked', 'false');
    // ON (confirmed) then OFF (no dialog)
    fireEvent.click(sw);
    fireEvent.click(within(await screen.findByTestId('behaviour-flag-confirm')).getByRole('button', { name: 'Yes, allow payouts without PAN' }));
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw);
    expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument();
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('W5: other behaviour flags flip immediately in the wizard (no confirm)', async () => {
    stubFetch(vi.fn());
    await walkToFeatures();
    const sw = screen.getByTestId('wizard-behaviour-flag-soDeclarationKyc');
    fireEvent.click(sw);
    expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument();
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  beforeEach(() => { vi.clearAllMocks(); });

  it('W1: untouched → POSTed features carry no behaviour keys', async () => {
    const postSpy = vi.fn();
    stubFetch(postSpy);
    await walkToFeatures();
    await submitFromFeatures();
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const features = postSpy.mock.calls[0][0].features as Record<string, unknown>;
    expect(features).not.toHaveProperty('outletMasterGeo');
    expect(features).not.toHaveProperty('soDeclarationKyc');
    expect(features).not.toHaveProperty('allowPayoutWithoutPan');
    expect(features.kycApprovalFlow).toBe(true); // module set unchanged
  });

  it('W2: switching outletMasterGeo ON sends only that behaviour key', async () => {
    const postSpy = vi.fn();
    stubFetch(postSpy);
    await walkToFeatures();
    const sw = screen.getByTestId('wizard-behaviour-flag-outletMasterGeo');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await submitFromFeatures();
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const features = postSpy.mock.calls[0][0].features as Record<string, unknown>;
    expect(features.outletMasterGeo).toBe(true);
    expect(features).not.toHaveProperty('soDeclarationKyc');
  });

  it('W3: switching allowPayoutWithoutPan ON sends only that behaviour key', async () => {
    const postSpy = vi.fn();
    stubFetch(postSpy);
    await walkToFeatures();
    expect(screen.getByText('Allow payouts without PAN')).toBeInTheDocument();
    const sw = screen.getByTestId('wizard-behaviour-flag-allowPayoutWithoutPan');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    // Switching ON asks first (same dialog as the client page); nothing flips until confirmed.
    const dialog = await screen.findByTestId('behaviour-flag-confirm');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, allow payouts without PAN' }));
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    await submitFromFeatures();
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const features = postSpy.mock.calls[0][0].features as Record<string, unknown>;
    expect(features.allowPayoutWithoutPan).toBe(true);
    expect(features).not.toHaveProperty('outletMasterGeo');
    expect(features).not.toHaveProperty('soDeclarationKyc');
  });
});
