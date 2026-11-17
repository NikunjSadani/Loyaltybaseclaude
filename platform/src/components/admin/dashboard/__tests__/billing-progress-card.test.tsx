/// <reference types="vitest/globals" />
/**
 * Monthly billing progress card (Overview).
 *  - BP1: data state — title, subtitle (as-of), headline, pace line, buckets with Indian/compact ₹
 *  - BP2: kpi null → "No headline target KPI configured for this tenant" (no fake zeros)
 *  - BP3: asOf null → "No sales data uploaded for this month yet"
 *  - BP4: empty (no outlets with a target) → honest empty state + no-target line
 *  - BP5: first request carries the current IST month and NO program / outletType / managerId
 *  - BP6: bucket click → drill-down fetch with the right params + paging + exact ₹ formatting
 *  - BP7: behind-pace / no-target open their lists; Download Excel hits the export URL
 *  - BP8: fetch failure → error state, no numbers
 *  - BP9: Indian number formatting helpers
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import {
  BillingProgressCard, fmtBillingAmount, fmtBillingExact, monthOptions, monthWords, shiftMonth,
  type BillingProgressData,
} from '../BillingProgressCard';
import { useDashboardProgram, DASHBOARD_PROGRAM_STORAGE_KEY } from '@/lib/dashboard-program';
import { istMonthKey } from '@/lib/ist-date';

function Harness() {
  const programState = useDashboardProgram();
  return <BillingProgressCard programState={programState} />;
}

const CUR_MONTH = istMonthKey(new Date());

function payload(over: Partial<BillingProgressData> = {}): BillingProgressData {
  return {
    month: CUR_MONTH,
    kpi: { code: 'SAMT', label: 'Sales', unit: 'INR' },
    asOf: '2026-11-16',
    daysElapsed: 16,
    daysInMonth: 30,
    pacePct: 53,
    outletsInScope: 300,
    outletsWithoutTarget: 42,
    totals: { targetSum: 12_345_678, achievedSum: 5_432_100 },
    behindPace: { count: 180, targetSum: 8_000_000, achievedSum: 2_000_000 },
    buckets: [
      { key: 'NOT_STARTED', label: 'Not started', count: 120, pctOfOutlets: 40, targetSum: 1_234_567, achievedSum: 0 },
      { key: 'P0_20', label: '1–20%', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 90_000 },
      { key: 'P20_40', label: '20–40%', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 270_000 },
      { key: 'P40_60', label: '40–60%', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 450_000 },
      { key: 'P60_80', label: '60–80%', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 630_000 },
      { key: 'P80_100', label: '80–99%', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 810_000 },
      { key: 'ACHIEVED', label: 'Achieved (100%+)', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 950_000 },
    ],
    availablePrograms: ['Gold', 'Silver'],
    availableOutletTypes: ['RETAIL', 'WHOLESALE'],
    availableManagers: [
      { id: 'm1', name: 'Asha ASM', levelCode: 'ASM', levelName: 'Area Sales Manager' },
      { id: 'm2', name: 'Sunil SO', levelCode: 'SO', levelName: 'Sales Officer' },
    ],
    ...over,
  };
}

function rowsPage(page: number, total = 60) {
  return {
    rows: Array.from({ length: 2 }, (_, i) => ({
      outletCode: `OUT-${page}-${i}`,
      outletName: `Shop ${page}-${i}`,
      program: 'Gold',
      outletType: 'RETAIL',
      soName: 'Sunil SO',
      asmName: null,
      target: 1_234_567.4,
      achieved: 0,
      pct: 0,
    })),
    total,
    page,
    pageSize: 25,
  };
}

/** Routes fetches by URL; `summary` decides the billing-progress body. */
function mockFetch(summary: () => unknown, opts: { failSummary?: boolean } = {}) {
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/admin/dashboard/billing-progress/outlets/export')) {
      return { ok: true, status: 202, json: async () => ({ success: true, data: { exportRequestId: 'x1', message: 'Queued for you.' } }) };
    }
    if (u.startsWith('/api/admin/dashboard/billing-progress/outlets')) {
      const page = Number(new URL(u, 'http://x').searchParams.get('page') ?? '1');
      return { ok: true, status: 200, json: async () => ({ success: true, data: rowsPage(page) }) };
    }
    if (u.startsWith('/api/admin/dashboard/billing-progress')) {
      if (opts.failSummary) return { ok: false, status: 500, json: async () => ({ message: 'Server exploded' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: summary() }) };
    }
    throw new Error(`unexpected ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const calls = (fn: ReturnType<typeof vi.fn>, prefix: string) =>
  fn.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(prefix));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
  window.history.replaceState(null, '', '/');
});

describe('BillingProgressCard', () => {
  it('BP1: renders title, as-of subtitle, headline, pace and buckets', async () => {
    mockFetch(() => payload());
    render(<Harness />);
    expect(await screen.findByText(`Monthly billing progress — ${monthWords(CUR_MONTH)}`)).toBeInTheDocument();
    expect(await screen.findByTestId('billing-progress-subtitle')).toHaveTextContent(
      "Against each outlet's Sales target · Data as of 16 Nov 2026",
    );
    expect(await screen.findByTestId('billing-outlets-in-scope')).toHaveTextContent('300');
    expect(await screen.findByTestId('billing-totals')).toHaveTextContent('₹54.3L of ₹1.23Cr (44.0%)');
    expect(await screen.findByTestId('billing-pace')).toHaveTextContent(
      'Day 16 of 30 (53% of month) · 180 outlets behind pace',
    );
    const ns = await screen.findByTestId('billing-bucket-NOT_STARTED');
    expect(ns).toHaveTextContent('Not started');
    expect(ns).toHaveTextContent('120 outlets');
    expect(ns).toHaveTextContent('40% of outlets');
    expect(ns).toHaveTextContent('Target ₹12.3L · Billed ₹0');
    expect(ns).toHaveAttribute('aria-label', expect.stringContaining('Not started: 120 outlets'));
    expect(await screen.findByTestId('billing-no-target')).toHaveTextContent(
      '42 active outlets have no Sales target this month',
    );
    // No program dropdown on the card (it follows the page-level filter); managers grouped by level.
    expect(screen.queryByTestId('billing-program-filter')).not.toBeInTheDocument();
    const mgr = await screen.findByTestId('billing-manager');
    expect(mgr.querySelector('optgroup[label="Area Sales Manager"]')).not.toBeNull();
  });

  it('BP2: kpi null → no-KPI message and no numbers', async () => {
    mockFetch(() => payload({ kpi: null, outletsInScope: 0, outletsWithoutTarget: 0 }));
    render(<Harness />);
    expect(await screen.findByTestId('billing-progress-no-kpi')).toHaveTextContent(
      'No headline target KPI configured for this tenant',
    );
    expect(screen.queryByTestId('billing-totals')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-progress-subtitle')).not.toBeInTheDocument();
  });

  it('BP3: asOf null → "No sales data uploaded for this month yet"', async () => {
    mockFetch(() => payload({ asOf: null }));
    render(<Harness />);
    expect(await screen.findByTestId('billing-progress-subtitle')).toHaveTextContent(
      "Against each outlet's Sales target · No sales data uploaded for this month yet",
    );
  });

  it('BP4: no outlet with a target → honest empty state + no-target line', async () => {
    mockFetch(() => payload({
      outletsInScope: 0,
      outletsWithoutTarget: 5,
      totals: { targetSum: 0, achievedSum: 0 },
      behindPace: { count: 0, targetSum: 0, achievedSum: 0 },
      buckets: payload().buckets.map((b) => ({ ...b, count: 0, pctOfOutlets: 0, targetSum: 0, achievedSum: 0 })),
    }));
    render(<Harness />);
    expect(await screen.findByTestId('billing-progress-empty')).toHaveTextContent(
      `No outlets have a Sales target for ${monthWords(CUR_MONTH)} with these filters.`,
    );
    expect(await screen.findByTestId('billing-no-target')).toHaveTextContent('5 active outlets have no Sales target this month');
    expect(screen.queryByTestId('billing-totals')).not.toBeInTheDocument();
  });

  it('BP5: first request = current IST month, no other filters; changing filters refetches', async () => {
    const fn = mockFetch(() => payload());
    render(<Harness />);
    await screen.findByTestId('billing-totals');
    const first = calls(fn, '/api/admin/dashboard/billing-progress?')[0];
    expect(first).toBe(`/api/admin/dashboard/billing-progress?month=${CUR_MONTH}`);

    const prev = shiftMonth(CUR_MONTH, -1);
    fireEvent.change(await screen.findByTestId('billing-month'), { target: { value: prev } });
    await waitFor(() =>
      expect(calls(fn, '/api/admin/dashboard/billing-progress?').some((u) => u.includes(`month=${prev}`))).toBe(true),
    );
    fireEvent.change(await screen.findByTestId('billing-manager'), { target: { value: 'm1' } });
    await waitFor(() =>
      expect(calls(fn, '/api/admin/dashboard/billing-progress?').some((u) => u.includes('managerId=m1'))).toBe(true),
    );
  });

  it('BP5b: follows the page-level program (stored selection) — no dropdown of its own', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    const fn = mockFetch(() => payload());
    render(<Harness />);
    await screen.findByTestId('billing-totals');
    expect(calls(fn, '/api/admin/dashboard/billing-progress?')[0]).toBe(
      `/api/admin/dashboard/billing-progress?month=${CUR_MONTH}&program=Gold`,
    );
    fireEvent.click(await screen.findByTestId('billing-bucket-NOT_STARTED'));
    await waitFor(() =>
      expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets?').some((u) => u.includes('program=Gold'))).toBe(true),
    );
  });

  it('BP6: bucket click → drill-down with the right params, paging and exact ₹', async () => {
    const fn = mockFetch(() => payload());
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('billing-bucket-NOT_STARTED'));
    expect(await screen.findByTestId('billing-drilldown')).toBeInTheDocument();
    expect(await screen.findByText(`Not started — ${monthWords(CUR_MONTH)}`)).toBeInTheDocument();
    expect(await screen.findByText('Shop 1-0')).toBeInTheDocument();
    expect((await screen.findAllByText('₹12,34,567')).length).toBeGreaterThan(0);
    expect(await screen.findByTestId('billing-drilldown-count')).toHaveTextContent('Showing 1–25 of 60 outlets');

    const first = calls(fn, '/api/admin/dashboard/billing-progress/outlets?')[0];
    const sp = new URL(first, 'http://x').searchParams;
    expect(sp.get('month')).toBe(CUR_MONTH);
    expect(sp.get('bucket')).toBe('NOT_STARTED');
    expect(sp.get('page')).toBe('1');
    expect(sp.get('pageSize')).toBe('25');
    expect(sp.has('program')).toBe(false);

    fireEvent.click(await screen.findByTestId('billing-drilldown-next'));
    expect(await screen.findByText('Shop 2-0')).toBeInTheDocument();
    expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets?').some((u) => u.includes('page=2'))).toBe(true);
    expect(await screen.findByTestId('billing-drilldown-count')).toHaveTextContent('Showing 26–50 of 60 outlets');
  });

  it('BP7: behind-pace opens its list; Download Excel calls the export endpoint', async () => {
    const fn = mockFetch(() => payload());
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('billing-behind-pace'));
    expect(await screen.findByText(`Behind pace — ${monthWords(CUR_MONTH)}`)).toBeInTheDocument();
    await waitFor(() =>
      expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets?').some((u) => u.includes('bucket=BEHIND_PACE'))).toBe(true),
    );
    await screen.findByText('Shop 1-0');
    fireEvent.click(await screen.findByTestId('billing-download-excel'));
    await waitFor(() => expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets/export').length).toBe(1));
    const exp = new URL(calls(fn, '/api/admin/dashboard/billing-progress/outlets/export')[0], 'http://x').searchParams;
    expect(exp.get('bucket')).toBe('BEHIND_PACE');
    expect(exp.get('month')).toBe(CUR_MONTH);
    expect(await screen.findByTestId('download-queued')).toHaveTextContent('Queued for you.');
  });

  it('BP7b: no-target line opens the NO_TARGET list', async () => {
    const fn = mockFetch(() => payload());
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('billing-no-target'));
    expect(await screen.findByText(`No Sales target — ${monthWords(CUR_MONTH)}`)).toBeInTheDocument();
    await waitFor(() =>
      expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets?').some((u) => u.includes('bucket=NO_TARGET'))).toBe(true),
    );
  });

  it('BP8: fetch failure → error, no numbers', async () => {
    mockFetch(() => payload(), { failSummary: true });
    render(<Harness />);
    expect(await screen.findByTestId('billing-progress-error')).toHaveTextContent('Server exploded');
    expect(screen.queryByTestId('billing-totals')).not.toBeInTheDocument();
  });

  it('BP9: formatting helpers (Indian grouping, compact L/Cr, non-INR ≤ 2 dp)', () => {
    expect(fmtBillingExact(1_234_567.4, 'INR')).toBe('₹12,34,567');
    expect(fmtBillingAmount(12_345_678, 'INR')).toBe('₹1.23Cr');
    expect(fmtBillingAmount(580_000, 'INR')).toBe('₹5.8L');
    expect(fmtBillingAmount(1234.567, 'cases')).toBe('1,234.57 cases');
    expect(fmtBillingExact(1234.567, 'cases')).toBe('1,234.57');
    expect(monthWords('2026-01')).toBe('January 2026');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    const opts = monthOptions(new Date());
    expect(opts).toHaveLength(13);
    expect(opts[0]).toBe(CUR_MONTH);
    expect(opts[12]).toBe(shiftMonth(CUR_MONTH, -12));
  });
});
