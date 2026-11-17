/// <reference types="vitest/globals" />
/**
 * Admin Overview — program filter + billing card wiring.
 *  - OV1: no program chosen → kpis requested with NO param; tiles render as today; no dropdown for 1 program
 *  - OV2: 2+ programs → dropdown; choosing one refetches kpis AND billing progress with `program`
 *  - OV3: notProgramScoped → "Tenant-wide — not split by program" note on that tile only when a program is selected
 *  - OV4: kpis fetch failure → visible error (no fabricated numbers)
 *  - OV5: a stored program from another dashboard is used on first load
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import DashboardPage from '../page';
import { DASHBOARD_PROGRAM_STORAGE_KEY } from '@/lib/dashboard-program';

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
    // billing card mounted and its kpi-null state is honest
    expect(await screen.findByTestId('billing-progress-no-kpi')).toBeInTheDocument();
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

  it('OV5: a program chosen on another dashboard is used on first load', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    const fn = mockFetch({ ...KPIS, availablePrograms: ['Gold', 'Silver'], notProgramScoped: [] }, { billingPrograms: ['Gold', 'Silver'] });
    render(<DashboardPage />);
    await screen.findByText('4,321');
    expect(urls(fn, '/api/admin/dashboard/kpis')[0]).toBe('/api/admin/dashboard/kpis?program=Gold');
    expect(((await screen.findByTestId('overview-program-filter')) as HTMLSelectElement).value).toBe('Gold');
  });
});
