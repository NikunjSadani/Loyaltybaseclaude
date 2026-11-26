/// <reference types="vitest/globals" />
/**
 * Admin nav — "Off-portal Payments" (off-portal payments register). Shown to GIFSY_ADMIN and CLIENT_ADMIN (the
 * backend read roles + admin/off-portal-payments/layout.tsx); hidden from GIFSY_STAFF and MIS_USER.
 * Run: npx vitest run src/app/admin/__tests__/off-portal-nav.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/dashboard',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/tenant-features', async (orig) => {
  const actual = await orig<typeof import('@/lib/tenant-features')>();
  return { ...actual, useTenantFeatures: () => ({ features: actual.normalizeFeatures({}), loading: false }) };
});
const roleRef = { current: 'CLIENT_ADMIN' };
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => ({
    role: roleRef.current, clientId: 't', name: 'Test', userId: 'u',
    canManageSchemes: roleRef.current === 'GIFSY_ADMIN' || roleRef.current === 'GIFSY_STAFF',
  }),
  adminRoleLabel: (r: string) => r,
}));
vi.mock('@/lib/gifsy-settings', () => ({ useGifsySettings: () => ({ visibilityEnabled: false }) }));
vi.mock('@/lib/use-assumed-context', () => ({ useAssumedContext: () => ({ brand: 'Bajaj', assumed: true, ready: true }) }));
vi.mock('@/lib/auth-client', () => ({
  logout: vi.fn(),
  PORTAL_ROLES: { admin: ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER', 'GIFSY_STAFF'] },
  getStoredUser: () => ({ role: roleRef.current }),
}));
vi.mock('@/components/operator/operator-banner', () => ({ OperatorBanner: () => null }));
vi.mock('@/components/layout/site-footer', () => ({ SiteFooter: () => null }));
vi.mock('@/components/rbac/admin-route-guard', () => ({
  AdminRouteGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/auth/require-auth', () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import AdminLayout from '../layout';
import { requiredPermissionForPath } from '@/lib/rbac/route-permissions';

const link = () => screen.queryByRole('link', { name: /Off-portal Payments/ });

beforeEach(() => { roleRef.current = 'CLIENT_ADMIN'; });

describe('Admin nav — Off-portal Payments', () => {
  it.each([['CLIENT_ADMIN'], ['GIFSY_ADMIN']])('shown to %s', (role) => {
    roleRef.current = role;
    render(<AdminLayout><div /></AdminLayout>);
    expect(link()).toHaveAttribute('href', '/admin/off-portal-payments');
  });

  it.each([['GIFSY_STAFF'], ['MIS_USER']])('hidden from %s', (role) => {
    roleRef.current = role;
    render(<AdminLayout><div /></AdminLayout>);
    expect(link()).not.toBeInTheDocument();
  });

  describe('B7 — presence gate for CLIENT_ADMIN', () => {
    const presence = (res: { ok: boolean; status: number; body: unknown } | 'throw') =>
      vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('/off-portal-payments/presence')) {
          if (res === 'throw') throw new TypeError('network');
          return { ok: res.ok, status: res.status, json: () => Promise.resolve(res.body) };
        }
        return { ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) };
      });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('hidden when the client has no off-portal payments', async () => {
      vi.stubGlobal('fetch', presence({ ok: true, status: 200, body: { success: true, data: { hasEntries: false, canWrite: false } } }));
      render(<AdminLayout><div /></AdminLayout>);
      await waitFor(() => expect(link()).not.toBeInTheDocument());
    });

    it('shown when the client has entries', async () => {
      const fn = presence({ ok: true, status: 200, body: { success: true, data: { hasEntries: true, canWrite: false } } });
      vi.stubGlobal('fetch', fn);
      render(<AdminLayout><div /></AdminLayout>);
      await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes('/presence'))).toBe(true));
      expect(link()).toHaveAttribute('href', '/admin/off-portal-payments');
    });

    it.each([['an error reply', { ok: false, status: 500, body: { success: false, error: 'boom' } }], ['a network failure', 'throw' as const]])(
      'fail-open: shown after %s',
      async (_l, res) => {
        const fn = presence(res);
        vi.stubGlobal('fetch', fn);
        render(<AdminLayout><div /></AdminLayout>);
        await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes('/presence'))).toBe(true));
        await new Promise((r) => setTimeout(r, 0));
        expect(link()).toHaveAttribute('href', '/admin/off-portal-payments');
      },
    );

    it('GIFSY_ADMIN always sees it, with no presence request', async () => {
      roleRef.current = 'GIFSY_ADMIN';
      const fn = presence({ ok: true, status: 200, body: { success: true, data: { hasEntries: false, canWrite: true } } });
      vi.stubGlobal('fetch', fn);
      render(<AdminLayout><div /></AdminLayout>);
      expect(link()).toHaveAttribute('href', '/admin/off-portal-payments');
      expect(fn.mock.calls.some((c) => String(c[0]).includes('/presence'))).toBe(false);
    });
  });

  it('route permission is payouts:read', () => {
    expect(requiredPermissionForPath('/admin/off-portal-payments')).toBe('payouts:read');
  });
});
