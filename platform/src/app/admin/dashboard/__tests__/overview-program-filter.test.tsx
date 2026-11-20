/// <reference types="vitest/globals" />
/**
 * Admin Overview — program filter + billing card wiring.
 *  - OV1: no program chosen → kpis requested with NO param; tiles render as today; no dropdown for 1 program;
 *    billing card hidden when the tenant has no enabled KPI (F3)
 *  - OV2: 2+ programs → dropdown; choosing one refetches kpis AND billing progress with `program`
 *  - OV3: notProgramScoped → "Tenant-wide — not split by program" note on that tile only when a program is selected
 *  - OV4: kpis fetch failure → visible error (no fabricated numbers)
 *  - OV5: a stored program from another dashboard is used on first load
 *  - OV6 (F1): with a program active the filter stays visible even when /kpis failed
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import DashboardPage from '../page';
import { dashboardProgramStorageKey } from '@/lib/dashboard-program';

const DASHBOARD_PROGRAM_STORAGE_KEY = dashboardProgramStorageKey('bajaj', 'u1');

const KPIS = {
  activePartners: 4321,
  pendingKyc: 12,
  pendingVisibility: 7,
  totalRedeemablePoints: 25_000_000,
  payoutSummary: { PAID: { count: 3, amountPaise: 30_000_000 } },
};

const BILLING = {
  month: '2026-11',
  kpi: null,
  asOf: null,
  daysElapsed: 1,
  daysInMonth: 30,
  pacePct: 3,
  outletsInScope: 0,
  outletsWithoutTarget: 0,
  totals: { targetSum: 0, achievedSum: 0 },
  behindPace: { count: 0, targetSum: 0, achievedSum: 0 },
  buckets: [],
  availablePrograms: [] as string[],
  availableOutletTypes: [],
  availableManagers: [],
};

function mockFetch(kpis: Record<string, unknown>, opts: { failKpis?: boolean; billingPrograms?: string[] } = {}) {
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/auth/me')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'u1', clientId: 'bajaj' } }) };
    }
    if (u.startsWith('/api/admin/dashboard/kpis')) {
      if (opts.failKpis) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: kpis }) };
    }
    if (u.startsWith('/api/admin/dashboard/billing-progress')) {
      return {
        ok: true, status: 200,
        json: async () => ({ success: true, data: { ...BILLING, availablePrograms: opts.billingPrograms ?? [] } }),
      };
    }
    throw new Error(`unexpected ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const urls = (fn: ReturnType<typeof vi.fn>, prefix: string) =>
  fn.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(prefix));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
  window.history.replaceState(null, '', '/');
});

describe('Admin Overview — program filter', () => {
  it('OV1: no program → kpis with no param, tiles as today, no dropdown for a single program', async () => {
    const fn = mockFetch({ ...KPIS, availablePrograms: ['Only'], notProgramScoped: [] });
    render(<DashboardPage />);
    expect(await screen.findByText('4,321')).toBeInTheDocument();
    expect(await screen.findByText('₹2.50 Cr')).toBeInTheDocument();
    expect(await screen.findByText('₹3.0L')).toBeInTheDocument();
    expect(urls(fn, '/api/admin/dashboard/kpis')).toEqual(['/api/admin/dashboard/kpis']);
    expect(screen.queryByTestId('overview-program-filter')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tenant-wide-note')).not.toBeInTheDocument();
    // F3: the tenant has no enabled KPI (billing kpi null) → the billing card is hidden entirely
    await waitFor(() => expect(urls(fn, '/api/admin/dashboard/billing-progress').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByTestId('billing-progress-card')).not.toBeInTheDocument());
  });

  it('OV1b: older API without availablePrograms still renders today\'s tiles', async () => {
    mockFetch(KPIS);
    render(<DashboardPage />);
    expect(await screen.findByText('4,321')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-program-filter')).not.toBeInTheDocument();
  });

  it('OV2: choosing a program refetches kpis and billing progress with `program`', async () => {
    const fn = mockFetch(
      { ...KPIS, availablePrograms: ['Gold', 'Silver'], notProgramScoped: [] },
      { billingPrograms: ['Gold', 'Silver'] },
    );
    render(<DashboardPage />);
    const select = await screen.findByTestId('overview-program-filter');
    fireEvent.change(select, { target: { value: 'Silver' } });
    await waitFor(() =>
      expect(urls(fn, '/api/admin/dashboard/kpis')).toContain('/api/admin/dashboard/kpis?program=Silver'),
    );
    await waitFor(() =>
      expect(urls(fn, '/api/admin/dashboard/billing-progress?').some((u) => u.includes('program=Silver'))).toBe(true),
    );
    expect(window.sessionStorage.getItem(DASHBOARD_PROGRAM_STORAGE_KEY)).toBe('Silver');
    expect(await screen.findByText('4,321')).toBeInTheDocument();
    // ONE program dropdown on the page — the billing card follows it.
    expect(screen.getAllByRole('combobox', { name: 'Program' })).toHaveLength(1);
    expect(screen.queryByTestId('billing-program-filter')).not.toBeInTheDocument();
  });

  it('OV3: notProgramScoped shows the tenant-wide note only with a program selected', async () => {
    mockFetch({ ...KPIS, availablePrograms: ['Gold', 'Silver'], notProgramScoped: ['totalRedeemablePoints'] });
    render(<DashboardPage />);
    await screen.findByText('4,321');
    expect(screen.queryByTestId('tenant-wide-note')).not.toBeInTheDocument();
    fireEvent.change(await screen.findByTestId('overview-program-filter'), { target: { value: 'Gold' } });
    const notes = await screen.findAllByTestId('tenant-wide-note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent('Tenant-wide — not split by program');
  });

  it('OV4: kpis failure → visible error, values stay "—"', async () => {
    mockFetch(KPIS, { failKpis: true });
    render(<DashboardPage />);
    expect(await screen.findByTestId('overview-kpis-error')).toHaveTextContent('Couldn\'t load key metrics');
    expect(screen.queryByText('4,321')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('OV6: with a program active the filter stays visible even when /kpis failed', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    mockFetch(KPIS, { failKpis: true, billingPrograms: ['Gold', 'Silver'] });
    render(<DashboardPage />);
    expect(await screen.findByTestId('overview-kpis-error')).toBeInTheDocument();
    const select = (await screen.findByTestId('overview-program-filter')) as HTMLSelectElement;
    expect(select.value).toBe('Gold');
    fireEvent.change(select, { target: { value: '' } }); // the person can always get back to All programs
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('D1 OV7: the first kpis fetch starts while /api/auth/me is still pending', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/auth/me')) return new Promise(() => {}); // never answers
      if (u.startsWith('/api/admin/dashboard/kpis')) return { ok: true, status: 200, json: async () => ({ success: true, data: KPIS }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: BILLING }) };
    });
    vi.stubGlobal('fetch', fn);
    render(<DashboardPage />);
    expect(await screen.findByText('4,321')).toBeInTheDocument();
    expect(urls(fn, '/api/admin/dashboard/kpis')[0]).toBe('/api/admin/dashboard/kpis');
  });

  it('D1 OV8: nothing stored → exactly one kpis fetch and no /api/auth/me call', async () => {
    const fn = mockFetch({ ...KPIS, availablePrograms: ['Gold', 'Silver'], notProgramScoped: [] });
    render(<DashboardPage />);
    await screen.findByText('4,321');
    await new Promise((r) => setTimeout(r, 30));
    expect(urls(fn, '/api/admin/dashboard/kpis')).toEqual(['/api/admin/dashboard/kpis']);
    expect(urls(fn, '/api/auth/me')).toEqual([]);
  });

  it('OV5: a program chosen on another dashboard is used on first load', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    const fn = mockFetch({ ...KPIS, availablePrograms: ['Gold', 'Silver'], notProgramScoped: [] }, { billingPrograms: ['Gold', 'Silver'] });
    render(<DashboardPage />);
    await screen.findByText('4,321');
    await waitFor(() => expect(urls(fn, '/api/admin/dashboard/kpis')).toContain('/api/admin/dashboard/kpis?program=Gold'));
    expect(((await screen.findByTestId('overview-program-filter')) as HTMLSelectElement).value).toBe('Gold');
  });

  it('OV-VIS: the tile = every capture still waiting (all months) with the month share; waiting on reps apart; picker refetches', async () => {
    const fn = mockFetch({
      ...KPIS,
      pendingVisibility: 10,
      visibility: {
        month: '2026-11', waiting: 7, waitingAllMonths: 10, waitingEarlierMonths: 3,
        needsRetake: 2, rejected: 1, waitingOnReps: 3, closedNotApproved: 4,
      },
    });
    render(<DashboardPage />);
    expect(await screen.findByTestId('kpi-visibility-retake')).toHaveTextContent('Waiting on reps (window still open), Nov 2026: 3');
    expect(screen.getByTestId('kpi-visibility-waiting')).toHaveTextContent(
      'Waiting for review, all months · 3 from earlier months · 7 from Nov 2026',
    );
    expect(screen.getByTestId('kpi-visibility-closed')).toHaveTextContent('Not approved — window closed: 4');
    // Default month → the request is unchanged (no visibilityMonth param).
    expect(urls(fn, '/api/admin/dashboard/kpis')).toEqual(['/api/admin/dashboard/kpis']);
    const select = screen.getByLabelText('Visibility approvals month') as HTMLSelectElement;
    const older = Array.from(select.options).map((o) => o.value).find((v) => v !== '2026-11')!;
    fireEvent.change(select, { target: { value: older } });
    await waitFor(() =>
      expect(urls(fn, '/api/admin/dashboard/kpis')).toContain(`/api/admin/dashboard/kpis?visibilityMonth=${older}`),
    );
  });

  it('OV-VIS2: AMOUNT_UPLOAD / visibility off (visibility null) → the tile is exactly as before', async () => {
    mockFetch({ ...KPIS, visibility: null });
    render(<DashboardPage />);
    expect(await screen.findByText('4,321')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-visibility-month')).not.toBeInTheDocument();
  });
});
