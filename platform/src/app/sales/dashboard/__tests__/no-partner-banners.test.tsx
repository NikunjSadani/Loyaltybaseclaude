/**
 * Sales dashboard banners (owner 2026-11-21): read from the SALES path /api/sales/banners — never the partner endpoint
 * (partner roles only → 403 + console error) — through the session cache (60 s), rendered only when there are any.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  // `prefetch` is a next/link prop, not a DOM attribute — dropped so React's console warning cannot mask a real error.
  default: ({ href, children, prefetch: _p, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: unknown }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/schemes', () => ({
  schemeApi: { listSalesEligible: () => Promise.resolve({ success: true, data: { schemes: [] } }) },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import SalesDashboardPage from '../page';
import { __resetSessionCacheForTests } from '@/lib/session-cache';
import { SALES_BANNERS_TTL_MS } from '@/lib/banner';

const GENERIC = { success: true, data: { outlets: [], submissions: [], period: null, outletCount: 0, kpis: [], trend: [] } };
let bannersResponse: () => Promise<unknown>;
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const bannerCalls = () => urls().filter((u) => u.includes('/api/sales/banners')).length;

beforeEach(() => {
  __resetSessionCacheForTests();
  fetchMock.mockReset();
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
  bannersResponse = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { banners: [] } }) });
  fetchMock.mockImplementation((u: unknown) =>
    String(u).includes('/api/sales/banners')
      ? bannersResponse()
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(GENERIC) }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('sales dashboard banners', () => {
  it('no banners (prod today): one /api/sales/banners call, never the partner endpoint, nothing rendered, no console error', async () => {
    const err = vi.spyOn(console, 'error');
    render(<SalesDashboardPage />);
    expect(await screen.findByText('View all')).toBeInTheDocument(); // the Tasks card rendered → all reads settled
    expect(urls().some((u) => u.includes('/api/partner/banners'))).toBe(false);
    expect(bannerCalls()).toBe(1);
    expect(document.querySelectorAll('.rounded-2xl.p-4.text-white')).toHaveLength(0);
    expect(err).not.toHaveBeenCalled();
  });

  it('renders the banners the sales endpoint returns, in order', async () => {
    bannersResponse = () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ success: true, data: { banners: [
        { id: 'a', type: 'text', title: 'Diwali push', body: 'Double points', ctaLabel: '', ctaUrl: '', videoUrl: '', bgColor: 'navy', priority: 0, startDate: '', endDate: '' },
        { id: 'b', type: 'text', title: 'Second', body: '', ctaLabel: 'Open', ctaUrl: 'https://example.com', videoUrl: '', bgColor: 'red', priority: 1, startDate: '', endDate: '' },
      ] } }),
    });
    render(<SalesDashboardPage />);
    expect(await screen.findByText('Diwali push')).toBeInTheDocument();
    expect(screen.getByText('Double points')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('https://example.com');
    const titles = [...document.querySelectorAll('.rounded-2xl.p-4.text-white p.font-bold')].map((p) => p.textContent);
    expect(titles).toEqual(['Diwali push', 'Second']);
  });

  it('a return within 60 s makes NO new banners request (session cache)', async () => {
    const first = render(<SalesDashboardPage />);
    await screen.findByText('View all');
    expect(bannerCalls()).toBe(1);
    first.unmount();
    cleanup();
    render(<SalesDashboardPage />);
    await screen.findByText('View all');
    expect(bannerCalls()).toBe(1);
    expect(SALES_BANNERS_TTL_MS).toBe(60_000);
  });

  it('ONE cache layer: a return after 60 s re-reads the banners (not held for the 2-min dashboard reuse)', async () => {
    const first = render(<SalesDashboardPage />);
    await screen.findByText('View all');
    expect(bannerCalls()).toBe(1);
    first.unmount();
    cleanup();
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + SALES_BANNERS_TTL_MS + 1_000);
    render(<SalesDashboardPage />);
    await screen.findByText('View all');
    await vi.waitFor(() => expect(bannerCalls()).toBe(2));
  });

  it('a non-http(s) CTA is never a link — the label shows as plain text', async () => {
    bannersResponse = () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ success: true, data: { banners: [
        { id: 'x', type: 'text', title: 'Evil', body: '', ctaLabel: 'Tap', ctaUrl: 'javascript:alert(1)', videoUrl: '', bgColor: 'red', priority: 0, startDate: '', endDate: '' },
      ] } }),
    });
    render(<SalesDashboardPage />);
    expect(await screen.findByText('Tap')).toBeInTheDocument();
    expect(screen.getByText('Tap').closest('a')).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('a refused / failed banners read never breaks the dashboard and never shows a "couldn\'t load" notice', async () => {
    const err = vi.spyOn(console, 'error');
    bannersResponse = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    render(<SalesDashboardPage />);
    expect(await screen.findByText('View all')).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load/i)).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });
});
