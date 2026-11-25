/// <reference types="vitest/globals" />
/**
 * Admin layout — no silent fallback (owner rule): when the feature-flags read FAILS (network / 5xx) a visible notice
 * with Retry is shown; a 403 (a role that may not read the flags, e.g. MIS_USER) stays quiet.
 * Run: npx vitest run src/app/admin/__tests__/admin-layout-features-error.test.tsx
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
const failureRef: { current: 'forbidden' | 'unavailable' | undefined } = { current: undefined };
const retrySpy = vi.fn();
vi.mock('@/lib/tenant-features', async (orig) => {
  const actual = await orig<typeof import('@/lib/tenant-features')>();
  return {
    ...actual,
    useTenantFeatures: (endpoint: string) => {
      endpointRef.current = endpoint;
      return { features: actual.normalizeFeatures(featuresRef.current), loading: false, error: !!failureRef.current, failure: failureRef.current, retry: retrySpy };
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

import { fireEvent } from '@testing-library/react';
import AdminLayout from '../layout';

beforeEach(() => {
  featuresRef.current = {};
  failureRef.current = undefined;
  roleRef.current = 'CLIENT_ADMIN';
  retrySpy.mockClear();
});

describe('Admin layout — flags read failure notice', () => {
  it('flags loaded → no notice', () => {
    render(<AdminLayout><div /></AdminLayout>);
    expect(screen.queryByTestId('admin-features-error')).not.toBeInTheDocument();
  });

  it('read FAILED (unavailable) → visible notice with Retry, which re-reads', () => {
    failureRef.current = 'unavailable';
    render(<AdminLayout><div /></AdminLayout>);
    const notice = screen.getByTestId('admin-features-error');
    expect(notice).toHaveTextContent("Couldn't load this client's settings — some menu items may be missing.");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retrySpy).toHaveBeenCalledTimes(1);
  });

  it.each([['MIS_USER'], ['GIFSY_STAFF']])('403 (forbidden) for %s → quiet, no notice', (role) => {
    roleRef.current = role;
    failureRef.current = 'forbidden';
    render(<AdminLayout><div /></AdminLayout>);
    expect(screen.queryByTestId('admin-features-error')).not.toBeInTheDocument();
  });
});
