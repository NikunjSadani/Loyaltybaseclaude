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

// GET /campaigns as built: a plain array of campaigns, each carrying `summary` (purchase counts only).
const CAMPAIGNS = [
  {
    id: 'c1', name: 'Diwali thank-you', programLabel: 'Bajaj Loyalty', billedToClient: { id: 'bajaj', name: 'Bajaj' }, status: 'COMPLETED_WITH_ERRORS', budgetRupees: 10000, createdAt: '2026-11-10T10:00:00Z',
    summary: { total: 22, valid: 20, invalid: 1, duplicates: 1, queued: 0, pending: 0, bought: 18, buyFailed: 2, cancelled: 0, spentRupees: 9000 },
  },
  {
    id: 'c2', name: 'Draft one', programLabel: 'Gifsy Rewards', billedToClient: null, status: 'PREVIEWED', budgetRupees: 500,
    summary: {},
  },
];

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); roleRef.current = 'GIFSY_ADMIN'; });

describe('Voucher Dispersal list', () => {
  it('renders campaigns with status chips, totals and billed-to / programme', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(ok(CAMPAIGNS)));
    vi.stubGlobal('fetch', fetchMock);
    render(<ListPage />);
    expect(await screen.findByText('Diwali thank-you')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/voucher-dispersal/campaigns?page=1', {});
    expect(screen.getByTestId('vd-status-c1')).toHaveTextContent('Completed with errors');
    const c1 = screen.getByTestId('vd-campaign-c1');
    expect(c1).toHaveTextContent('Programme: Bajaj Loyalty · Billed to: Bajaj');
    expect(c1).toHaveTextContent('Valid rows20');
    expect(c1).toHaveTextContent('Buy failed2');
    // The list endpoint sends no WhatsApp counts → none are shown here (they are on the campaign page).
    expect(c1).not.toHaveTextContent('Delivered');
    expect(c1).not.toHaveTextContent('Msg failed');
    expect(c1).toHaveTextContent('₹9,000 / ₹10,000');
    // Unconfirmed campaign: honest "nothing bought" + resume link, billed-to dash.
    const c2 = screen.getByTestId('vd-campaign-c2');
    expect(c2).toHaveTextContent('Billed to: —');
    expect(c2).toHaveTextContent('Not confirmed — nothing has been bought.');
    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute('href', '/gifsy/voucher-dispersal/new?campaign=c2');
    expect(screen.getByRole('link', { name: /New campaign/ })).toHaveAttribute('href', '/gifsy/voucher-dispersal/new');
  });

  it('unknown status shows the raw value (no setup wording); missing numbers show "—"; billed-to id fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(ok([
      { id: 'c3', name: 'Odd one', programLabel: 'X', billedToClient: { id: 'bajaj', name: null }, status: 'PAUSED', summary: { bought: 4 } },
    ]))));
    render(<ListPage />);
    const c3 = await screen.findByTestId('vd-campaign-c3');
    expect(screen.getByTestId('vd-status-c3')).toHaveTextContent('Unknown status: PAUSED');
    expect(c3).not.toHaveTextContent('nothing has been bought');
    expect(c3).toHaveTextContent('Billed to: bajaj');
    expect(c3).toHaveTextContent('Bought4');
    expect(c3).toHaveTextContent('Pending—');
    expect(c3).toHaveTextContent('— / —');
  });

  it('a failed refresh keeps the list and says so', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(CAMPAIGNS))
      .mockResolvedValueOnce(fail(502, 'Bad gateway'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ListPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(await screen.findByTestId('vd-refresh-error')).toHaveTextContent('Bad gateway');
    expect(screen.getByText('Diwali thank-you')).toBeInTheDocument();
  });

  it('pages through ?page= (50 per page): Next only when the page is full', async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ ...CAMPAIGNS[0], id: `p${i}`, name: `Campaign ${i}` }));
    const fetchMock = vi.fn((url: string) => Promise.resolve(ok(url.endsWith('page=1') ? full : [CAMPAIGNS[0]])));
    vi.stubGlobal('fetch', fetchMock);
    render(<ListPage />);
    await screen.findByText('Campaign 0');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Diwali thank-you')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/voucher-dispersal/campaigns?page=2', {});
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(ok([]))));
    render(<ListPage />);
    expect(await screen.findByTestId('vd-empty')).toHaveTextContent('No campaigns yet');
  });

  it('error state shows the server text and retries', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fail(403, 'Access denied. Required: GIFSY_ADMIN.'))
      .mockResolvedValueOnce(ok(CAMPAIGNS));
    vi.stubGlobal('fetch', fetchMock);
    render(<ListPage />);
    expect(await screen.findByTestId('vd-error')).toHaveTextContent('Access denied. Required: GIFSY_ADMIN.');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Diwali thank-you')).toBeInTheDocument();
  });

  it('Download template fetches the template file and saves it', async () => {
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

describe('Voucher Dispersal list — clickable cards + Excel per card (2026-11-18)', () => {
  it('the whole card opens the campaign through ONE real link (stretched; nothing interactive nested inside it)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(ok(CAMPAIGNS))));
    render(<ListPage />);
    const link = await screen.findByRole('link', { name: 'Diwali thank-you' });
    expect(link).toHaveAttribute('href', '/gifsy/voucher-dispersal/c1');
    expect(link).toHaveAttribute('data-testid', 'vd-card-link-c1');
    // The stretched pseudo-element covers the card (the card is the positioning context).
    expect(link.className).toMatch(/after:absolute/);
    expect(link.className).toMatch(/after:inset-0/);
    expect(screen.getByTestId('vd-campaign-c1').className).toMatch(/(^|\s)relative(\s|$)/);
    // No interactive element is nested inside the link.
    expect(link.querySelector('a, button')).toBeNull();
    // Setup cards keep going to Continue setup.
    expect(screen.getByRole('link', { name: 'Draft one' })).toHaveAttribute('href', '/gifsy/voucher-dispersal/new?campaign=c2');
  });

  it('"Download Excel" on each confirmed card fetches that campaign report.xlsx; setup cards have none', async () => {
    const fetchMock = vi.fn((url: string) =>
      url.endsWith('/report.xlsx')
        ? Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, blob: () => Promise.resolve(new Blob(['x'])) })
        : Promise.resolve(ok(CAMPAIGNS)),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ListPage />);
    await screen.findByText('Diwali thank-you');
    const c2 = screen.getByTestId('vd-campaign-c2');
    expect(c2.querySelector('[data-testid^="vd-card-download"]')).toBeNull();
    const btn = screen.getByTestId('vd-card-download-c1');
    expect(btn).toHaveAccessibleName('Download Excel report for Diwali thank-you');
    fireEvent.click(btn);
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'voucher-campaign-c1.xlsx'));
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/admin/voucher-dispersal/campaigns/c1/report.xlsx')).toBe(true);
  });

  it('a card with an unconfirmed "Add more people" batch says so (never silent)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(ok([{ ...CAMPAIGNS[0], summary: { ...CAMPAIGNS[0].summary, pendingBatchNumber: 2 } }]))));
    render(<ListPage />);
    expect(await screen.findByTestId('vd-card-pending-batch-c1')).toHaveTextContent('Batch 2 is waiting for confirmation — nothing in it has been bought.');
  });
});

describe('Voucher Dispersal gating', () => {
  it('route guard admits GIFSY_ADMIN only', () => {
    render(<VdLayout><div>inner</div></VdLayout>);
    expect(screen.getByTestId('require-auth')).toHaveAttribute('data-roles', 'GIFSY_ADMIN');
  });

  it('nav shows Voucher Dispersal in the platform console for GIFSY_ADMIN', async () => {
    render(<GifsyLayout><div /></GifsyLayout>);
    expect(await screen.findByRole('link', { name: /Voucher Dispersal/ })).toHaveAttribute('href', '/gifsy/voucher-dispersal');
  });

  it('nav hides it from GIFSY_STAFF (launchpad only)', async () => {
    roleRef.current = 'GIFSY_STAFF';
    render(<GifsyLayout><div data-testid="child" /></GifsyLayout>);
    await screen.findByText('Choose a brand');
    expect(screen.queryByRole('link', { name: /Voucher Dispersal/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
  });
});
