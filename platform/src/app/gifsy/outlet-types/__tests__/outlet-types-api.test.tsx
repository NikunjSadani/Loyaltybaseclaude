/// <reference types="vitest/globals" />
/**
 * GOTAPI — Gifsy Outlet Types page API wiring
 *
 * GOTAPI1: shows static fallback types immediately (before fetch)
 * GOTAPI2: replaces types with API data after fetch resolves
 * GOTAPI3: keeps static fallback when fetch fails
 * GOTAPI4: fetch is called with the outlet-type-configs endpoint
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import OutletTypesPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const MOCK_API_TYPES = [
  {
    outletTypeCode: 'MODERN_TRADE',
    outletTypeName: 'Modern Trade',
    displayName: null,
    isEnabled: true,
  },
  {
    outletTypeCode: 'KIRANA',
    outletTypeName: 'Kirana',
    displayName: 'API Kirana Store',
    isEnabled: true,
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('GOTAPI — Gifsy Outlet Types API wiring', () => {
  it('GOTAPI1: shows static fallback types immediately before fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}), // never resolves
    }));
    render(<OutletTypesPage />);
    // Static fallback data is shown immediately
    expect(screen.getByText('SSS')).toBeInTheDocument();
  });

  it('GOTAPI2: replaces types with API data after fetch resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: MOCK_API_TYPES }),
    }));
    render(<OutletTypesPage />);
    // API data appears after fetch resolves
    expect(await screen.findByText('Modern Trade')).toBeInTheDocument();
    expect(await screen.findByText('API Kirana Store')).toBeInTheDocument();
  });

  it('GOTAPI3: keeps static fallback when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<OutletTypesPage />);
    // Static data still visible after error
    expect(screen.getByText('SSS')).toBeInTheDocument();
    expect(screen.getByText('Wholesaler')).toBeInTheDocument();
  });

  it('GOTAPI4: fetch is called with the outlet-type-configs endpoint', () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    });
    vi.stubGlobal('fetch', mockFetch);
    render(<OutletTypesPage />);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/outlet-type-configs')
    );
  });
});
