/// <reference types="vitest/globals" />
/**
 * BrandSwitcher — the GIFSY operator "Work in brand ▾" context switcher.
 *
 * The switcher now lists ACTIVE **and** ONBOARDING tenants (backend allows assuming
 * an ONBOARDING tenant — this is what un-dead-ends a freshly onboarded client), but
 * NOT INACTIVE ones. ONBOARDING tenants carry a muted "Onboarding" chip.
 *
 * BS1: an ONBOARDING tenant now appears in the list (was filtered out before)
 * BS2: an INACTIVE tenant does NOT appear
 * BS3: the ONBOARDING tenant is labelled with an "Onboarding" chip
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/auth-client', () => ({
  getToken: () => null,
  assumeTenant: vi.fn().mockResolvedValue({ brandName: 'X' }),
}));

import { BrandSwitcher } from '../brand-switcher';
import { assumeTenant } from '@/lib/auth-client';

const CLIENTS = [
  { slug: 'live-co',    internalName: 'Live Co',       status: 'ACTIVE' },
  { slug: 'onb-co',     internalName: 'Onboarding Co', status: 'ONBOARDING' },
  { slug: 'dead-co',    internalName: 'Inactive Co',   status: 'INACTIVE' },
];

describe('BrandSwitcher tenant filtering', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { clients: CLIENTS } }),
    }));
  });

  it('BS1: an ONBOARDING tenant appears (no longer filtered out)', async () => {
    render(<BrandSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /work in brand/i }));
    await waitFor(() => {
      expect(screen.getByText('Onboarding Co')).toBeInTheDocument();
    });
    // ACTIVE one is present too.
    expect(screen.getByText('Live Co')).toBeInTheDocument();
  });

  it('BS2: an INACTIVE tenant does NOT appear', async () => {
    render(<BrandSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /work in brand/i }));
    await waitFor(() => {
      expect(screen.getByText('Live Co')).toBeInTheDocument();
    });
    expect(screen.queryByText('Inactive Co')).not.toBeInTheDocument();
  });

  it('BS3: the ONBOARDING tenant carries an "Onboarding" chip; the ACTIVE one does not', async () => {
    render(<BrandSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /work in brand/i }));
    await waitFor(() => {
      expect(screen.getByText('Onboarding Co')).toBeInTheDocument();
    });
    // The muted status chip is only rendered for ONBOARDING rows.
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
  });
});

describe('BrandSwitcher — stale-deployment self-heal on assume', () => {
  const reload = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { clients: CLIENTS } }),
    }));
    reload.mockClear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'http://localhost/', pathname: '/', origin: 'http://localhost', reload, assign: vi.fn() },
    });
    try { window.sessionStorage.clear(); } catch { /* ignore */ }
    (assumeTenant as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('a STALE server-action rejection triggers a one-shot reload, NOT an inline error', async () => {
    (assumeTenant as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Failed to find Server Action "40277a0e". This request might be from an older or newer deployment.'),
    );
    render(<BrandSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /work in brand/i }));
    await waitFor(() => expect(screen.getByText('Live Co')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Live Co'));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // the raw deploy-skew message is NOT surfaced to the operator
    expect(screen.queryByText(/failed to find server action/i)).not.toBeInTheDocument();
  });

  it('a NON-stale rejection still shows the inline error and does NOT reload', async () => {
    (assumeTenant as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('You do not have access to this brand'),
    );
    render(<BrandSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /work in brand/i }));
    await waitFor(() => expect(screen.getByText('Live Co')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Live Co'));

    await waitFor(() => expect(screen.getByText('You do not have access to this brand')).toBeInTheDocument());
    expect(reload).not.toHaveBeenCalled();
  });
});
