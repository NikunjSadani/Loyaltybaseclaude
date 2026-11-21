/// <reference types="vitest/globals" />
/**
 * Admin nav — "This Month's Offers" (OFFER-TILES-PLAN F5 + D1). Shown ONLY when the tenant
 * feature `offerTiles` is ON *and* the role is GIFSY_ADMIN or CLIENT_ADMIN (same two roles as the
 * BE @Roles + the admin/offers/layout.tsx guard). Default OFF ⇒ Deoleo's nav is unchanged.
 * Run: npx vitest run src/app/admin/__tests__/offers-nav.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/dashboard',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const featuresRef: { current: Record<string, unknown> } = { current: {} };
vi.mock('@/lib/tenant-features', async (orig) => {
  const actual = await orig<typeof import('@/lib/tenant-features')>();
  return {
    ...actual,
    useTenantFeatures: () => ({ features: actual.normalizeFeatures(featuresRef.current), loading: false }),
  };
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

const offersLink = () => screen.queryByRole('link', { name: /This Month's Offers/ });

beforeEach(() => {
  featuresRef.current = {};
  roleRef.current = 'CLIENT_ADMIN';
});

describe("Admin nav — This Month's Offers", () => {
  it('hidden when the tenant flag is OFF (default) — Deoleo byte-identical', () => {
    render(<AdminLayout><div /></AdminLayout>);
    expect(offersLink()).not.toBeInTheDocument();
  });

  it.each([['CLIENT_ADMIN'], ['GIFSY_ADMIN']])('shown to %s when offerTiles is ON', (role) => {
    roleRef.current = role;
    featuresRef.current = { offerTiles: true };
    render(<AdminLayout><div /></AdminLayout>);
    expect(offersLink()).toHaveAttribute('href', '/admin/offers');
  });

  it.each([['MIS_USER'], ['GIFSY_STAFF']])('hidden from %s even when offerTiles is ON', (role) => {
    roleRef.current = role;
    featuresRef.current = { offerTiles: true };
    render(<AdminLayout><div /></AdminLayout>);
    expect(offersLink()).not.toBeInTheDocument();
  });
});
