/// <reference types="vitest/globals" />
/**
 * BrandSwitcher (panel variant) — the RBAC Option-X P5 GIFSY_STAFF launchpad.
 *
 * Fed by GET /api/gifsy/my-assumable-clients (the CALLER's granted brands). The panel
 * handles the three staff cases explicitly:
 *
 * BSP1: exactly one granted brand → a one-click "Work in {brand}" that assumes it
 * BSP2: multiple granted brands → a picker listing each brand
 * BSP3: zero granted brands → a clear empty state ("No brands assigned yet")
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeAll, afterEach } from 'vitest';

const assumeTenant = vi.fn().mockResolvedValue({ brandName: 'X' });
vi.mock('@/lib/auth-client', () => ({
  getToken: () => null,
  assumeTenant: (...args: unknown[]) => assumeTenant(...args),
}));

import { BrandSwitcher } from '../brand-switcher';

// pick() navigates via window.location.href — make it a settable no-op so jsdom's
// "navigation not implemented" doesn't surface during the assume assertion.
beforeAll(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
});

function stub(clients: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: async () => ({ success: true, data: { clients } }),
  }));
}

afterEach(() => { vi.unstubAllGlobals(); assumeTenant.mockClear(); });

describe('BrandSwitcher panel — GIFSY_STAFF launchpad', () => {
  it('BSP1: a single granted brand → one-click "Work in {brand}" assumes it', async () => {
    stub([{ id: 'c1', slug: 'acme', internalName: 'Acme Foods', status: 'ACTIVE' }]);
    render(<BrandSwitcher variant="panel" />);

    const btn = await screen.findByRole('button', { name: /work in Acme Foods/i });
    fireEvent.click(btn);

    await waitFor(() => expect(assumeTenant).toHaveBeenCalledWith('acme'));
  });

  it('BSP2: multiple granted brands → a picker listing each brand', async () => {
    stub([
      { id: 'c1', slug: 'acme',   internalName: 'Acme Foods', status: 'ACTIVE' },
      { id: 'c2', slug: 'globex', internalName: 'Globex',     status: 'ONBOARDING' },
    ]);
    render(<BrandSwitcher variant="panel" />);

    expect(await screen.findByText(/choose a brand to work in/i)).toBeInTheDocument();
    // Each granted brand is its own pick button.
    expect(screen.getByRole('button', { name: /Acme Foods/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Globex/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Globex/i }));
    await waitFor(() => expect(assumeTenant).toHaveBeenCalledWith('globex'));
  });

  it('BSP3: zero granted brands → an empty state', async () => {
    stub([]);
    render(<BrandSwitcher variant="panel" />);

    expect(await screen.findByText(/no brands assigned yet/i)).toBeInTheDocument();
    expect(screen.getByText(/ask your admin/i)).toBeInTheDocument();
  });

  it('BSP4: an INACTIVE granted brand is not offered', async () => {
    stub([
      { id: 'c1', slug: 'acme', internalName: 'Acme Foods', status: 'ACTIVE' },
      { id: 'c9', slug: 'dead', internalName: 'Dead Co',    status: 'INACTIVE' },
    ]);
    render(<BrandSwitcher variant="panel" />);

    // With INACTIVE filtered out only ONE remains → the single-brand one-click view.
    expect(await screen.findByRole('button', { name: /work in Acme Foods/i })).toBeInTheDocument();
    expect(screen.queryByText('Dead Co')).not.toBeInTheDocument();
  });
});
