/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — campaign list page + /gifsy nav gating + GIFSY_ADMIN route guard.
 * Run: npx vitest run src/app/gifsy/voucher-dispersal/__tests__/list-and-nav.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/gifsy/voucher-dispersal',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));

const roleRef = { current: 'GIFSY_ADMIN' };
vi.mock('@/lib/auth-client', () => ({
  logout: vi.fn(),
  PORTAL_ROLES: { gifsy: ['GIFSY_ADMIN', 'GIFSY_STAFF'] },
  getStoredUser: () => ({ role: roleRef.current }),
}));
vi.mock('@/components/auth/require-auth', () => ({
  RequireAuth: ({ children, allowedRoles }: { children: React.ReactNode; allowedRoles?: string[] }) =>
    <div data-testid="require-auth" data-roles={(allowedRoles ?? []).join(',')}>{children}</div>,
}));
vi.mock('@/components/operator/brand-switcher', () => ({ BrandSwitcher: () => null }));
vi.mock('@/components/operator/operator-banner', () => ({ OperatorBanner: () => null }));
vi.mock('@/components/exports/downloads-nav-badge', () => ({ DownloadsNavBadge: () => null }));

import ListPage from '../page';
import VdLayout from '../layout';
import GifsyLayout from '../../layout';

const ok = (data: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
const fail = (status: number, error: string) => ({ ok: false, status, json: () => Promise.resolve({ success: false, error }) });

const CAMPAIGNS = [
  {
    campaign: { id: 'c1', name: 'Diwali thank-you', programLabel: 'Bajaj Loyalty', billedToClientName: 'Bajaj', status: 'COMPLETED_WITH_ERRORS', budgetRupees: 10000, createdAt: '2026-11-10T10:00:00Z' },
    summary: { bought: 18, pending: 0, buyFailed: 2, messageSent: 18, delivered: 16, read: 9, messageFailed: 2, spentRupees: 9000 },
  },
  {
    campaign: { id: 'c2', name: 'Draft one', programLabel: 'Gifsy Rewards', billedToClientId: null, status: 'PREVIEWED', budgetRupees: 500 },
    summary: {},
  },
];

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); roleRef.current = 'GIFSY_ADMIN'; });

describe('Voucher Dispersal list', () => {
  it('renders campaigns with status chips, totals and billed-to / programme', { timeout: 20000 }, async () => {
    const fetchMock = vi.fn(() => Promise.resolve(ok(CAMPAIGNS)));
    vi.stubGlobal('fetch', fetchMock);
    render(<ListPage />);
    expect(await screen.findByText('Diwali thank-you')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/voucher-dispersal/campaigns', {});
    expect(screen.getByTestId('vd-status-c1')).toHaveTextContent('Completed with errors');
    const c1 = screen.getByTestId('vd-campaign-c1');
    expect(c1).toHaveTextContent('Programme: Bajaj Loyalty · Billed to: Bajaj');
    expect(c1).toHaveTextContent('Buy failed2');
    expect(c1).toHaveTextContent('Msg failed2');
    expect(c1).toHaveTextContent('₹9,000 / ₹10,000');
    // Unconfirmed campaign: honest "nothing bought" + resume link, billed-to dash.
    const c2 = screen.getByTestId('vd-campaign-c2');
    expect(c2).toHaveTextContent('Billed to: —');
    expect(c2).toHaveTextContent('Not confirmed — nothing has been bought.');
    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute('href', '/gifsy/voucher-dispersal/new?campaign=c2');
    expect(screen.getByRole('link', { name: /New campaign/ })).toHaveAttribute('href', '/gifsy/voucher-dispersal/new');
  });

  it('unknown status shows the raw value (no setup wording); missing numbers show "—"; billed-to id fallback', { timeout: 20000 }, async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(ok([
      { campaign: { id: 'c3', name: 'Odd one', programLabel: 'X', billedToClientId: 'bajaj', status: 'PAUSED' }, summary: { bought: 4 } },
    ]))));
    render(<ListPage />);
    const c3 = await screen.findByTestId('vd-campaign-c3');
    expect(screen.getByTestId('vd-status-c3')).toHaveTextContent('Unknown status: PAUSED');
    expect(c3).not.toHaveTextContent('nothing has been bought');
    expect(c3).toHaveTextContent('Billed to: bajaj');
    expect(c3).toHaveTextContent('Bought4');
    expect(c3).toHaveTextContent('Delivered—');
    expect(c3).toHaveTextContent('— / —');
  });

  it('a failed refresh keeps the list and says so', { timeout: 20000 }, async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(CAMPAIGNS))
      .mockResolvedValueOnce(fail(502, 'Bad gateway'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ListPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(await screen.findByTestId('vd-refresh-error')).toHaveTextContent('Bad gateway');
    expect(screen.getByText('Diwali thank-you')).toBeInTheDocument();
  });

  it('empty state', { timeout: 20000 }, async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(ok([]))));
    render(<ListPage />);
    expect(await screen.findByTestId('vd-empty')).toHaveTextContent('No campaigns yet');
  });

  it('error state shows the server text and retries', { timeout: 20000 }, async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fail(403, 'Access denied. Required: GIFSY_ADMIN.'))
      .mockResolvedValueOnce(ok(CAMPAIGNS));
    vi.stubGlobal('fetch', fetchMock);
    render(<ListPage />);
    expect(await screen.findByTestId('vd-error')).toHaveTextContent('Access denied. Required: GIFSY_ADMIN.');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Diwali thank-you')).toBeInTheDocument();
  });

  it('Download template fetches the template file and saves it', { timeout: 20000 }, async () => {
    const fetchMock = vi.fn((url: string) =>
      url.endsWith('/template.xlsx')
        ? Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, blob: () => Promise.resolve(new Blob(['x'])) })
        : Promise.resolve(ok([])),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ListPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download template' }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'voucher-dispersal-template.xlsx'));
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/admin/voucher-dispersal/template.xlsx')).toBe(true);
  });
});

describe('Voucher Dispersal gating', () => {
  it('route guard admits GIFSY_ADMIN only', () => {
    render(<VdLayout><div>inner</div></VdLayout>);
    expect(screen.getByTestId('require-auth')).toHaveAttribute('data-roles', 'GIFSY_ADMIN');
  });

  it('nav shows Voucher Dispersal in the platform console for GIFSY_ADMIN', { timeout: 20000 }, async () => {
    render(<GifsyLayout><div /></GifsyLayout>);
    expect(await screen.findByRole('link', { name: /Voucher Dispersal/ })).toHaveAttribute('href', '/gifsy/voucher-dispersal');
  });

  it('nav hides it from GIFSY_STAFF (launchpad only)', { timeout: 20000 }, async () => {
    roleRef.current = 'GIFSY_STAFF';
    render(<GifsyLayout><div data-testid="child" /></GifsyLayout>);
    await screen.findByText('Choose a brand');
    expect(screen.queryByRole('link', { name: /Voucher Dispersal/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
  });
});
