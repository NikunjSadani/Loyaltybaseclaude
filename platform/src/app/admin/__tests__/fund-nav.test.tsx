/// <reference types="vitest/globals" />
/**
 * Admin nav — "Fund Reconciliation" (FUND-RECONCILIATION-DESIGN.md). Top-level item shown to GIFSY_ADMIN +
 * CLIENT_ADMIN only (same two roles as admin/fund/layout.tsx).
 * Run: npx vitest run src/app/admin/__tests__/fund-nav.test.tsx
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

const fundLink = () => screen.queryByRole('link', { name: /Fund Reconciliation/ });

beforeEach(() => {
  featuresRef.current = { walletModule: true };
  roleRef.current = 'CLIENT_ADMIN';
});

describe('Admin nav — Fund Reconciliation', () => {
  it.each([['CLIENT_ADMIN'], ['GIFSY_ADMIN']])('shown to %s (no feature flag needed)', (role) => {
    roleRef.current = role;
    featuresRef.current = {};
    render(<AdminLayout><div /></AdminLayout>);
    expect(fundLink()).toHaveAttribute('href', '/admin/fund');
  });

  it.each([['MIS_USER'], ['GIFSY_STAFF']])('hidden from %s', (role) => {
    roleRef.current = role;
    render(<AdminLayout><div /></AdminLayout>);
    expect(fundLink()).not.toBeInTheDocument();
  });
});
