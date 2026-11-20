/// <reference types="vitest/globals" />
/**
 * React #418 regression for the ADMIN shell: the Visibility (POSM) nav item depends on the
 * localStorage-cached GifsySettings and the header shows today's date — both client-only. The
 * layout is server-rendered, hydrated over that exact HTML, and must hydrate with NO recoverable
 * error, then show the Visibility item (when the cached switch is ON) and the date right after.
 * Uses the REAL gifsy-settings store + use-today-label (only network / session hooks are mocked).
 * Run: npx vitest run src/app/admin/__tests__/admin-layout-hydration.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { act } from '@testing-library/react';

// A returning GIFSY_ADMIN whose cached settings have Visibility ON (seeded before modules load).
vi.hoisted(() => {
  localStorage.setItem('gifsy_settings_v1', JSON.stringify({ visibilityEnabled: true }));
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/dashboard',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/api-client', () => ({
  api: { get: vi.fn(() => new Promise(() => {})), put: vi.fn() },
}));
vi.mock('@/lib/tenant-features', async (orig) => {
  const actual = await orig<typeof import('@/lib/tenant-features')>();
  return { ...actual, useTenantFeatures: () => ({ features: actual.normalizeFeatures({}), loading: false }) };
});
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => ({ role: 'GIFSY_ADMIN', name: 'Test', userId: 'u', canManageSchemes: true }),
  adminRoleLabel: (r: string) => r,
}));
vi.mock('@/lib/use-assumed-context', () => ({ useAssumedContext: () => ({ brand: 'Bajaj', assumed: true }) }));
vi.mock('@/lib/auth-client', () => ({
  logout: vi.fn(),
  PORTAL_ROLES: { admin: ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER', 'GIFSY_STAFF'] },
  getStoredUser: () => ({ role: 'GIFSY_ADMIN' }),
}));
vi.mock('@/components/operator/operator-banner', () => ({ OperatorBanner: () => null }));
vi.mock('@/components/layout/site-footer', () => ({ SiteFooter: () => null }));
vi.mock('@/components/exports/downloads-nav-badge', () => ({ DownloadsNavBadge: () => null }));
vi.mock('@/components/notifications/notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/rbac/admin-route-guard', () => ({
  AdminRouteGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/auth/require-auth', () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import AdminLayout from '../layout';
import { hydrateGifsySettings } from '@/lib/gifsy-settings';
import { getTodayLabelSnapshot } from '@/lib/use-today-label';

let root: Root | null = null;
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  document.body.innerHTML = '';
});

describe('Admin layout — hydration-safe (React #418)', () => {
  it('hydrates without a mismatch, then shows the Visibility item and the date', async () => {
    const el = <AdminLayout><div>page</div></AdminLayout>;
    const serverHtml = renderToString(el);
    // SSR = the server default: Visibility OFF (item absent) and no date (height-holding nbsp).
    expect(serverHtml).not.toContain('Visibility (POSM)');
    expect(serverHtml).not.toContain(getTodayLabelSnapshot());

    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const errors: unknown[] = [];
    const consoleErr = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
    await act(async () => {
      root = hydrateRoot(container, el, { onRecoverableError: (e) => { errors.push(e); } });
    });
    consoleErr.mockRestore();

    expect(errors).toEqual([]);
    const link = container.querySelector('a[href="/admin/visibility"]');
    expect(link?.textContent).toContain('Visibility (POSM)');
    expect(container.querySelector('[data-testid="admin-header-date"]')?.textContent).toBe(getTodayLabelSnapshot());

    // Store updates keep propagating to the hydrated shell (e.g. the switch turned OFF elsewhere).
    act(() => {
      hydrateGifsySettings({ visibilityEnabled: false } as Parameters<typeof hydrateGifsySettings>[0]);
    });
    expect(container.querySelector('a[href="/admin/visibility"]')).toBeNull();
  });
});
