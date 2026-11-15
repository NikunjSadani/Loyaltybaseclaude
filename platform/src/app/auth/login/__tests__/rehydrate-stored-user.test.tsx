/// <reference types="vitest/globals" />
/**
 * RSU — the login page's live-cookie re-hydrate (GET /auth/me → localStorage `user`) keeps the
 * partner header identity (businessName/outletName), so a session with a live cookie but empty
 * storage also paints the OUTLET name from the first frame — and stays byte-identical otherwise.
 *
 * RSU1: partner /auth/me with businessName/outletName → stored user keeps both.
 * RSU2: non-partner /auth/me (no such keys) → stored user is exactly id/name/role/phone.
 * RSU3: storedUserFromAuthMe → usePartnerIdentity seeds the header from it (outlet, not person).
 */

import React from 'react';
import { render, renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const apiGet = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { get: (...a: unknown[]) => apiGet(...a) },
  authHeader: () => ({}),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../actions', () => ({ sendOTP: vi.fn(), verifyOTP: vi.fn() }));
vi.mock('@/lib/stale-deploy', () => ({ isStaleDeploymentError: () => false, recoverFromStaleDeployment: vi.fn() }));
vi.mock('@/lib/active-partner-actions', () => ({ setActivePartner: vi.fn() }));

import LoginPage from '../page';
import { storedUserFromAuthMe } from '@/lib/auth-client';
import { usePartnerIdentity } from '@/lib/partner-identity';

let originalLocation: Location;
beforeEach(() => {
  apiGet.mockReset();
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: 'http://localhost/auth/login', search: '' },
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  localStorage.clear();
  vi.unstubAllGlobals();
});

const stored = () => JSON.parse(localStorage.getItem('user') ?? 'null');

describe('RSU — /auth/me re-hydrate keeps the partner header identity', () => {
  it('RSU1: a partner /auth/me stores businessName + outletName with the user', async () => {
    apiGet.mockResolvedValue({
      success: true,
      data: {
        role: 'WHOLESALER',
        user: { id: 'u1', name: 'VIKRAM SINGH', phone: '9', businessName: 'Chakradhar Traders', outletName: 'Chakradhar Marketing' },
      },
    });
    render(<LoginPage />);
    await waitFor(() => expect(stored()).not.toBeNull());
    expect(stored()).toEqual({
      id: 'u1', name: 'VIKRAM SINGH', role: 'WHOLESALER', phone: '9',
      businessName: 'Chakradhar Traders', outletName: 'Chakradhar Marketing',
    });
    expect(window.location.href).toBe('/partner/select');
  });

  it('RSU2: a non-partner /auth/me stores exactly id/name/role/phone (unchanged)', async () => {
    apiGet.mockResolvedValue({
      success: true,
      data: { role: 'SALES_ASM', user: { id: 's1', name: 'Asha', phone: '8', channelPartner: null } },
    });
    render(<LoginPage />);
    await waitFor(() => expect(stored()).not.toBeNull());
    expect(stored()).toEqual({ id: 's1', name: 'Asha', role: 'SALES_ASM', phone: '8' });
  });

  it('RSU3: the re-hydrated user seeds the partner header with the outlet name, not the person', async () => {
    localStorage.setItem('user', JSON.stringify(storedUserFromAuthMe({
      role: 'WHOLESALER',
      user: { id: 'u1', name: 'VIKRAM SINGH', phone: '9', businessName: 'Chakradhar Traders', outletName: 'Chakradhar Marketing' },
    })));
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // /partner/me never resolves
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.outletName).toBe('Chakradhar Marketing'));
    expect(result.current.businessName).toBe('Chakradhar Traders');
    expect(result.current.ownerName).toBe('VIKRAM SINGH');
    expect(result.current.loading).toBe(true);
  });
});
