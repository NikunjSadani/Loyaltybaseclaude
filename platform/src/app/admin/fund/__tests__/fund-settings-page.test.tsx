/**
 * /admin/fund/settings (re-audit B1): an assumed Gifsy operator — incl. GIFSY_STAFF, who never sees the console client
 * page — gets the Fund settings section for the session's client (slug from GET /api/fund/settings); a client admin is
 * pointed back to the read-only view and no console call is made.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a>,
}));
const roleRef = vi.hoisted(() => ({ current: 'GIFSY_STAFF' }));
vi.mock('@/lib/auth-client', () => ({ getStoredUser: () => ({ id: 'u', name: 'N', role: roleRef.current, phone: '' }) }));
vi.mock('@/components/operator/fund-console-section', () => ({
  FundConsoleSection: ({ slug }: { slug: string }) => <div data-testid="console-section">section for {slug}</div>,
}));

import FundSettingsPage from '../settings/page';

function stubFetch(status = 200, body: unknown = { success: true, data: { clientId: 'bajaj' } }) {
  const fn = vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('/admin/fund/settings', () => {
  it('GIFSY_STAFF (assumed) gets the Fund settings section for the session client', async () => {
    roleRef.current = 'GIFSY_STAFF';
    const fn = stubFetch();
    render(<FundSettingsPage />);
    expect(await screen.findByTestId('console-section')).toHaveTextContent('section for bajaj');
    expect(fn).toHaveBeenCalledWith('/api/fund/settings');
  });

  it('a client admin is pointed back to the read-only view; nothing is fetched', async () => {
    roleRef.current = 'CLIENT_ADMIN';
    const fn = stubFetch();
    render(<FundSettingsPage />);
    expect(await screen.findByText(/These settings are managed by Gifsy/)).toBeInTheDocument();
    expect(screen.queryByTestId('console-section')).not.toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });

  it('a server error (e.g. no access) is shown, not a blank page', async () => {
    roleRef.current = 'GIFSY_ADMIN';
    stubFetch(403, { success: false, error: 'Forbidden: missing permission payouts:read' });
    render(<FundSettingsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('missing permission payouts:read');
  });
});
