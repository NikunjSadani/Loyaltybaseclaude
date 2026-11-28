/// <reference types="vitest/globals" />
/**
 * /gifsy/notification-templates — MOVED to Clients → <client> → Notifications (2026-11-28).
 * The old route shows a short "moved" page with one link per client to /gifsy/clients/<slug>#notifications
 * (owner-only), and the sidebar no longer carries a "Notifications" item.
 * (The editor's behaviour is covered by components/operator/__tests__/notification-templates-editor.test.tsx.)
 * Run: npx vitest run src/app/gifsy/notification-templates/__tests__/notification-templates-page.test.tsx
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/gifsy/notification-templates',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
const roleRef = { current: 'GIFSY_ADMIN' };
vi.mock('@/lib/auth-client', () => ({
  logout: vi.fn(),
  getToken: () => null,
  PORTAL_ROLES: { gifsy: ['GIFSY_ADMIN', 'GIFSY_STAFF'] },
  getStoredUser: () => ({ role: roleRef.current }),
}));
vi.mock('@/components/auth/require-auth', () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/operator/brand-switcher', () => ({ BrandSwitcher: () => null }));
vi.mock('@/components/operator/operator-banner', () => ({ OperatorBanner: () => null }));
vi.mock('@/components/exports/downloads-nav-badge', () => ({ DownloadsNavBadge: () => null }));

import NotificationTemplatesMovedPage from '../page';
import GifsyLayout from '../../layout';

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); roleRef.current = 'GIFSY_ADMIN'; });

describe('/gifsy/notification-templates (moved)', () => {
  it('shows the "moved" note and links every client to its #notifications section', async () => {
    const fetchMock = vi.fn(() => ok({ clients: [
      { slug: 'bajaj', internalName: 'Bajaj Consumer Care', displayName: 'Bajaj' },
      { slug: 'deoleo', internalName: 'Deoleo India' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationTemplatesMovedPage />);
    expect(await screen.findByText('Notification templates moved')).toBeInTheDocument();
    expect(screen.getByTestId('nt-moved').textContent).toMatch(/Clients → <client> → Notifications/);
    expect(await screen.findByTestId('nt-moved-link-bajaj')).toHaveAttribute('href', '/gifsy/clients/bajaj#notifications');
    expect(screen.getByTestId('nt-moved-link-bajaj')).toHaveTextContent('Bajaj');
    expect(screen.getByTestId('nt-moved-link-deoleo')).toHaveAttribute('href', '/gifsy/clients/deoleo#notifications');
    expect(screen.getByTestId('nt-moved-link-deoleo')).toHaveTextContent('Deoleo India');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/gifsy/clients');
  });

  it('a failed client list says so with a link to Clients (never blank)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'boom' }) })));
    render(<NotificationTemplatesMovedPage />);
    const err = await screen.findByTestId('nt-moved-error');
    expect(err).toHaveTextContent('boom');
    expect(err.querySelector('a')).toHaveAttribute('href', '/gifsy/clients');
  });

  it('owner-only: a non-GIFSY_ADMIN sees no client list and nothing is fetched', async () => {
    roleRef.current = 'GIFSY_STAFF';
    const fetchMock = vi.fn(() => ok({ clients: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationTemplatesMovedPage />);
    expect(await screen.findByTestId('nt-moved-owner-only')).toBeInTheDocument();
    expect(screen.queryByTestId('nt-moved')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the Gifsy sidebar has no "Notifications" item (and no link to the old route); Clients stays', async () => {
    render(<GifsyLayout><div /></GifsyLayout>);
    expect(await screen.findByRole('link', { name: /Clients/ })).toHaveAttribute('href', '/gifsy/clients');
    expect(screen.queryByRole('link', { name: /Notifications/ })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/gifsy/notification-templates"]')).toBeNull();
  });
});
