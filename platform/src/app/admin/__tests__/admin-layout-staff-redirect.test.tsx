/// <reference types="vitest/globals" />
/**
 * GIFSY_STAFF bounce on a HARD LOAD of /admin/* (audit fix for the #418 change). useAssumedContext
 * returns the server default (un-assumed) during the hydration render, so the layout's
 * "un-assumed staff → /gifsy" effect must wait for `ready`:
 *   - an ASSUMED staff (stored hint) is NOT redirected on SSR + hydrate;
 *   - an UN-assumed staff IS still redirected once ready.
 * Uses the REAL use-assumed-context (only the server reconcile is held pending).
 * Run: npx vitest run src/app/admin/__tests__/admin-layout-staff-redirect.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { act } from '@testing-library/react';

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/dashboard',
  useRouter: () => ({ replace, push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/api-client', () => ({
  api: { get: vi.fn(() => new Promise(() => {})), put: vi.fn() },
}));
// Server reconcile never resolves → the decision rests on the stored hint alone (the hard-load case).
vi.mock('@/lib/auth-actions', () => ({ getAssumedContext: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/lib/tenant-features', async (orig) => {
  const actual = await orig<typeof import('@/lib/tenant-features')>();
  return { ...actual, useTenantFeatures: () => ({ features: actual.normalizeFeatures({}), loading: false }) };
});
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => ({ role: 'GIFSY_STAFF', name: 'Staff', userId: 'u', canManageSchemes: true }),
  adminRoleLabel: (r: string) => r,
}));
vi.mock('@/lib/auth-client', () => ({
  logout: vi.fn(),
  PORTAL_ROLES: { admin: ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER', 'GIFSY_STAFF'] },
  getStoredUser: () => ({ role: 'GIFSY_STAFF' }),
  getAssumedBrand: () => (typeof window === 'undefined' ? null : localStorage.getItem('assumedBrand')),
  clearAssumedContext: vi.fn(),
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

let root: Root | null = null;
beforeEach(() => { replace.mockClear(); localStorage.clear(); });
afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  document.body.innerHTML = '';
});

async function hardLoad() {
  const el = <AdminLayout><div>page</div></AdminLayout>;
  const container = document.createElement('div');
  container.innerHTML = renderToString(el);
  document.body.appendChild(container);
  const errors: unknown[] = [];
  const consoleErr = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
  await act(async () => {
    root = hydrateRoot(container, el, { onRecoverableError: (e) => { errors.push(e); } });
  });
  consoleErr.mockRestore();
  return errors;
}

describe('Admin layout — GIFSY_STAFF redirect waits for the assumed context (hard load)', () => {
  it('an ASSUMED staff (stored hint) is NOT bounced to /gifsy on a hard refresh', async () => {
    localStorage.setItem('assumedBrand', 'Bajaj');
    const errors = await hardLoad();
    expect(errors).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
  });

  it('an UN-assumed staff IS still bounced to /gifsy once ready', async () => {
    const errors = await hardLoad();
    expect(errors).toEqual([]);
    expect(replace).toHaveBeenCalledWith('/gifsy');
  });
});
