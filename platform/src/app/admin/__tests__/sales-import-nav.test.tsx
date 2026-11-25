/// <reference types="vitest/globals" />
/**
 * Admin nav — "Sales Import" (SALES-IMPORT-PIPELINE-PLAN §11 F-2). Shown ONLY when the tenant feature `salesImport`
 * is ON *and* the role is GIFSY_ADMIN, GIFSY_STAFF (owner 2026-11-25) or CLIENT_ADMIN. Default OFF ⇒ Deoleo's nav is
 * unchanged. The flags come from /api/admin/settings/features (readable by an assumed staff without tenancy:read).
 * Run: npx vitest run src/app/admin/__tests__/sales-import-nav.test.tsx
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
const endpointRef: { current: string | null } = { current: null };
vi.mock('@/lib/tenant-features', async (orig) => {
  const actual = await orig<typeof import('@/lib/tenant-features')>();
  return {
    ...actual,
    useTenantFeatures: (endpoint: string) => {
      endpointRef.current = endpoint;
      return { features: actual.normalizeFeatures(featuresRef.current), loading: false };
    },
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

const link = () => screen.queryByRole('link', { name: /Sales Import/ });

beforeEach(() => {
  featuresRef.current = {};
  roleRef.current = 'CLIENT_ADMIN';
});

describe('Admin nav — Sales Import', () => {
  it('hidden when the tenant flag is OFF (default) — Deoleo byte-identical', () => {
    render(<AdminLayout><div /></AdminLayout>);
    expect(link()).not.toBeInTheDocument();
  });

  it('reads the flags from the flags-only endpoint (not /config)', () => {
    roleRef.current = 'GIFSY_STAFF';
    render(<AdminLayout><div /></AdminLayout>);
    expect(endpointRef.current).toBe('/api/admin/settings/features');
  });

  it.each([['CLIENT_ADMIN'], ['GIFSY_ADMIN'], ['GIFSY_STAFF']])('shown to %s when salesImport is ON', (role) => {
    roleRef.current = role;
    featuresRef.current = { salesImport: true };
    render(<AdminLayout><div /></AdminLayout>);
    expect(link()).toHaveAttribute('href', '/admin/sales-import');
  });

  it('hidden from GIFSY_STAFF when salesImport is OFF', () => {
    roleRef.current = 'GIFSY_STAFF';
    featuresRef.current = { salesImport: false };
    render(<AdminLayout><div /></AdminLayout>);
    expect(link()).not.toBeInTheDocument();
  });

  it.each([['MIS_USER']])('hidden from %s even when salesImport is ON', (role) => {
    roleRef.current = role;
    featuresRef.current = { salesImport: true };
    render(<AdminLayout><div /></AdminLayout>);
    expect(link()).not.toBeInTheDocument();
  });

  it('the existing Sales Data item is unaffected', () => {
    render(<AdminLayout><div /></AdminLayout>);
    expect(screen.getByRole('link', { name: /Sales Data/ })).toHaveAttribute('href', '/admin/sales');
  });
});
