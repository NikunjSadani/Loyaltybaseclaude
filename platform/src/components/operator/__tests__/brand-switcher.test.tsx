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
