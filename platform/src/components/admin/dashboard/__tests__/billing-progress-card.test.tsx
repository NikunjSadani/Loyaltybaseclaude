/// <reference types="vitest/globals" />
/**
 * Monthly billing progress card (Overview).
 *  - BP1: data state — title, subtitle (as-of), headline, pace line, buckets with Indian/compact ₹
 *  - (BP2/BP3 superseded by BP14 — no KPI hides the card — and BP13 — no sales for the month)
 *  - BP4: empty (no outlets with a target) → honest empty state + no-target line
 *  - BP5: first request carries the current IST month and NO program / outletType / managerId
 *  - BP6: bucket click → drill-down fetch with the right params + paging + exact ₹ formatting
 *  - BP7: behind-pace / no-target open their lists; Download Excel hits the export URL
 *  - BP8: fetch failure → error state, no numbers
 *  - BP9: Indian number formatting helpers
 *  - BP10 (N1): "N outlets aren't covered by the <KPI> target" → NOT_COVERED list
 *  - BP11 (N7/N8): target rows outside the live roster line; KYC-pending + "outlets with a target" copy
 *  - BP12 (F1): a selected program shows "· Program: X" in the subtitle
 *  - BP13 (F2): no sales for the month → "No sales uploaded for <Month> yet" instead of buckets / pace
 *  - BP14 (F3): no enabled KPI → the card is hidden
 *  - BP15 (F4): drill-down error → no range line, Retry, paging keeps the last total, Download stays on
 *  - BP16 (F5): behind-pace caption; past month → "missed target"; future month → empty state
 *  - BP17 (F7): phone columns (Program / Type / ASM hidden below sm), units + manager in the modal
 *  - BP18 (F8): colours — distinct light-grey Not started, green Achieved, blue ramp with ≥ 3:1 contrast
 *  - BP19 (F9): exact ₹ figures in each bucket's aria-label
 *  - BP20 (N3): totals % floors below 100 (never a misleading 100.0%)
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import {
  BillingProgressCard, BUCKET_COLORS, fmtBillingAmount, fmtBillingExact, monthOptions, monthWords, pctOf, shiftMonth,
  type BillingProgressData,
} from '../BillingProgressCard';
import { useDashboardProgram, dashboardProgramStorageKey } from '@/lib/dashboard-program';

const DASHBOARD_PROGRAM_STORAGE_KEY = dashboardProgramStorageKey('bajaj', 'u1');
import { formatISTDate, istMonthKey } from '@/lib/ist-date';

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
    monthStatus: 'CURRENT',
    daysElapsed: 16,
    daysInMonth: 30,
    pacePct: 53,
    paceAsOf: '2026-11-16',
    outletsInScope: 300,
    outletsWithoutTarget: 42,
    outletsNotCovered: 0,
    targetsOutsideRoster: 0,
    totals: { targetSum: 12_345_678, achievedSum: 5_432_100 },
    behindPace: { count: 180, targetSum: 8_000_000, achievedSum: 2_000_000 },
    buckets: [
      { key: 'NOT_STARTED', label: 'Not started', count: 120, pctOfOutlets: 40, targetSum: 1_234_567, achievedSum: 0 },
      { key: 'P0_20', label: 'Under 20%', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 90_000 },
      { key: 'P20_40', label: '20–39%', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 270_000 },
      { key: 'P40_60', label: '40–59%', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 450_000 },
      { key: 'P60_80', label: '60–79%', count: 30, pctOfOutlets: 10, targetSum: 900_000, achievedSum: 630_000 },
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
function mockFetch(
  summary: () => unknown,
  opts: { failSummary?: boolean; failOutlets?: () => boolean } = {},
) {
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/auth/me')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'u1', clientId: 'bajaj' } }) };
    }
    if (u.startsWith('/api/admin/dashboard/billing-progress/outlets/export')) {
      return { ok: true, status: 202, json: async () => ({ success: true, data: { exportRequestId: 'x1', message: 'Queued for you.' } }) };
    }
    if (u.startsWith('/api/admin/dashboard/billing-progress/outlets')) {
      if (opts.failOutlets?.()) return { ok: false, status: 500, json: async () => ({ message: 'List exploded' }) };
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
    expect(await screen.findByTestId('billing-pace-caption')).toHaveTextContent(
      'Behind pace = billed less than 53% of target by 16 Nov 2026',
    );
    const ns = await screen.findByTestId('billing-bucket-NOT_STARTED');
    expect(ns).toHaveTextContent('Not started');
    expect(ns).toHaveTextContent('120 outlets');
    expect(ns).toHaveTextContent('40% of outlets');
    expect(ns).toHaveTextContent('Target ₹12.3L · Billed ₹0');
    expect(ns).toHaveAttribute('aria-label', expect.stringContaining('Not started: 120 outlets'));
    expect(await screen.findByTestId('billing-kyc-note')).toHaveTextContent('Includes outlets whose KYC is still pending.');
    expect(await screen.findByTestId('billing-totals-label')).toHaveTextContent('Billed vs target (outlets with a target)');
    expect(await screen.findByTestId('billing-no-target')).toHaveTextContent(
      '42 active outlets have no Sales target this month',
    );
    // No program dropdown on the card (it follows the page-level filter); managers grouped by level.
    expect(screen.queryByTestId('billing-program-filter')).not.toBeInTheDocument();
    const mgr = await screen.findByTestId('billing-manager');
    expect(mgr.querySelector('optgroup[label="Area Sales Manager"]')).not.toBeNull();
  });

  it('BP14 (F3): no enabled KPI at all → the whole card is hidden', async () => {
    const fn = mockFetch(() => payload({ kpi: null, outletsInScope: 0, outletsWithoutTarget: 0 }));
    render(<Harness />);
    await waitFor(() => expect(calls(fn, '/api/admin/dashboard/billing-progress?').length).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('billing-progress-card')).not.toBeInTheDocument());
    expect(screen.queryByTestId('billing-totals')).not.toBeInTheDocument();
  });

  it('BP13 (F2): asOf null → "No sales uploaded for <Month> yet" replaces buckets + pace; target + side lines stay', async () => {
    mockFetch(() => payload({
      asOf: null, daysElapsed: null, pacePct: null, paceAsOf: null,
      outletsNotCovered: 3,
      totals: { targetSum: 12_345_678, achievedSum: 0 },
      behindPace: { count: 0, targetSum: 0, achievedSum: 0 },
    }));
    render(<Harness />);
    expect(await screen.findByTestId('billing-no-sales')).toHaveTextContent(`No sales uploaded for ${monthWords(CUR_MONTH)} yet`);
    expect(await screen.findByTestId('billing-target-total')).toHaveTextContent('₹1.23Cr');
    expect(screen.queryByTestId('billing-bucket-NOT_STARTED')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-pace')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-behind-pace')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-totals')).not.toBeInTheDocument(); // no fake "₹0 billed"
    expect(await screen.findByTestId('billing-no-target')).toHaveTextContent('42 active outlets have no Sales target');
    expect(await screen.findByTestId('billing-not-covered')).toHaveTextContent("3 outlets aren't covered by the Sales target");
    expect(screen.getByTestId('billing-progress-subtitle')).not.toHaveTextContent('Data as of');
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
    await waitFor(() =>
      expect(calls(fn, '/api/admin/dashboard/billing-progress?')).toContain(
        `/api/admin/dashboard/billing-progress?month=${CUR_MONTH}&program=Gold`,
      ),
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

  it('BP10 (N1): not-covered line opens the NOT_COVERED list', async () => {
    const fn = mockFetch(() => payload({ outletsNotCovered: 7 }));
    render(<Harness />);
    const line = await screen.findByTestId('billing-not-covered');
    expect(line).toHaveTextContent("7 outlets aren't covered by the Sales target");
    fireEvent.click(line);
    await waitFor(() =>
      expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets?').some((u) => u.includes('bucket=NOT_COVERED'))).toBe(true),
    );
  });

  it('BP10b: no not-covered line when every outlet is covered', async () => {
    mockFetch(() => payload());
    render(<Harness />);
    await screen.findByTestId('billing-totals');
    expect(screen.queryByTestId('billing-not-covered')).not.toBeInTheDocument();
  });

  it('BP11 (N7): target rows outside the live roster → an honest line (tenant-wide under filters)', async () => {
    mockFetch(() => payload({ targetsOutsideRoster: 4 }));
    render(<Harness />);
    expect(await screen.findByTestId('billing-outside-roster')).toHaveTextContent(
      '4 target rows for this month belong to outlets that aren\'t in the live roster (deleted, parked or not interested) and aren\'t counted here.',
    );
    fireEvent.change(await screen.findByTestId('billing-outlet-type'), { target: { value: 'RETAIL' } });
    await waitFor(() => expect(screen.getByTestId('billing-outside-roster')).toHaveTextContent('(tenant-wide)'));
  });

  it('BP12 (F1): a selected program shows "· Program: X" in the subtitle', async () => {
    window.sessionStorage.setItem(DASHBOARD_PROGRAM_STORAGE_KEY, 'Gold');
    mockFetch(() => payload());
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('billing-progress-subtitle')).toHaveTextContent('· Program: Gold'));
    expect(screen.getByTestId('billing-progress-subtitle')).toHaveTextContent(
      "Against each outlet's Sales target · Program: Gold · Data as of 16 Nov 2026",
    );
  });

  it('BP15 (F4): drill-down error → no range line, Retry, last total kept for paging, Download stays enabled', async () => {
    let fail = false;
    const fn = mockFetch(() => payload(), { failOutlets: () => fail });
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('billing-bucket-NOT_STARTED'));
    expect(await screen.findByTestId('billing-drilldown-count')).toHaveTextContent('Showing 1–25 of 60 outlets');
    fail = true;
    fireEvent.click(await screen.findByTestId('billing-drilldown-next'));
    expect(await screen.findByTestId('billing-drilldown-error')).toHaveTextContent('List exploded');
    expect(screen.queryByTestId('billing-drilldown-count')).not.toBeInTheDocument();
    // Paging still knows there are 3 pages; Download is not tied to the (failed) list.
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
    expect(screen.getByTestId('billing-download-excel')).not.toBeDisabled();
    fail = false;
    fireEvent.click(await screen.findByTestId('billing-drilldown-retry'));
    expect(await screen.findByText('Shop 2-0')).toBeInTheDocument();
    expect(await screen.findByTestId('billing-drilldown-count')).toHaveTextContent('Showing 26–50 of 60 outlets');
    expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets?').filter((u) => u.includes('page=2')).length).toBe(2);
  });

  it('BP15b (F4): the range line follows the page the server returned, not the one requested', async () => {
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'u1', clientId: 'bajaj' } }) };
      if (u.startsWith('/api/admin/dashboard/billing-progress/outlets')) {
        // The server clamps / returns page 1 whatever was asked.
        return { ok: true, status: 200, json: async () => ({ success: true, data: { ...rowsPage(1), page: 1 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: payload() }) };
    });
    vi.stubGlobal('fetch', fn);
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('billing-bucket-NOT_STARTED'));
    await screen.findByText('Shop 1-0');
    fireEvent.click(await screen.findByTestId('billing-drilldown-next'));
    await waitFor(() => expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets?').some((u) => u.includes('page=2'))).toBe(true));
    await waitFor(() => expect(screen.getByTestId('billing-drilldown-count')).toHaveTextContent('Showing 1–25 of 60 outlets'));
  });

  it('BP16 (F5): past month → "missed target" wording and list title', async () => {
    const past = shiftMonth(CUR_MONTH, -1);
    const fn = mockFetch(() => payload({ month: past, monthStatus: 'PAST', daysElapsed: 30, pacePct: 100, paceAsOf: `${past}-30` }));
    render(<Harness />);
    expect(await screen.findByTestId('billing-pace')).toHaveTextContent('Full month · 180 outlets missed target');
    expect(screen.queryByTestId('billing-pace-caption')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('billing-behind-pace'));
    expect(await screen.findByText(`Missed target — ${monthWords(past)}`)).toBeInTheDocument();
    await waitFor(() =>
      expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets?').some((u) => u.includes('bucket=BEHIND_PACE'))).toBe(true),
    );
  });

  it('D4: past month whose data stops early → "Data up to <date>" + behind pace, not "Full month · missed target"', async () => {
    const past = shiftMonth(CUR_MONTH, -1);
    const fn = mockFetch(() => payload({
      month: past, monthStatus: 'PAST', fullMonth: false, asOf: `${past}-10`,
      daysElapsed: 10, pacePct: 33, paceAsOf: `${past}-10`,
    }));
    render(<Harness />);
    const pace = await screen.findByTestId('billing-pace');
    expect(pace).toHaveTextContent(`Data up to ${formatISTDate(`${past}-10`)} (33% of month) · 180 outlets behind pace`);
    expect(pace).not.toHaveTextContent('Full month');
    expect(await screen.findByTestId('billing-pace-caption')).toHaveTextContent(
      `Behind pace = billed less than 33% of target by ${formatISTDate(`${past}-10`)}`,
    );
    fireEvent.click(await screen.findByTestId('billing-behind-pace'));
    expect(await screen.findByText(`Behind pace — ${monthWords(past)}`)).toBeInTheDocument();
    await waitFor(() => expect(calls(fn, '/api/admin/dashboard/billing-progress/outlets?').length).toBe(1));
  });

  it('D6: a no-KPI tenant never flashes "Couldn\'t load" while refetching (card stays hidden)', async () => {
    let fail = false;
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'u1', clientId: 'bajaj' } }) };
      if (fail) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: payload({ kpi: null }) }) };
    });
    vi.stubGlobal('fetch', fn);
    function Two() {
      const ps = useDashboardProgram();
      return (
        <>
          <button type="button" data-testid="go" onClick={() => ps.setProgram('Gold')}>go</button>
          <BillingProgressCard programState={ps} />
        </>
      );
    }
    render(<Two />);
    await waitFor(() => expect(calls(fn, '/api/admin/dashboard/billing-progress?').length).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('billing-progress-card')).not.toBeInTheDocument());
    fail = true;
    fireEvent.click(screen.getByTestId('go'));
    await waitFor(() => expect(calls(fn, '/api/admin/dashboard/billing-progress?').length).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('billing-progress-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-progress-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-progress-loading')).not.toBeInTheDocument();
  });

  it('D7: NOT_COVERED rows show the REAL stored values with a "not counted" note', async () => {
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/auth/me')) return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'u1', clientId: 'bajaj' } }) };
      if (u.startsWith('/api/admin/dashboard/billing-progress/outlets')) {
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, data: { rows: [{
            outletCode: 'S1', outletName: 'Silver Shop', program: 'Silver', outletType: 'RETAIL', soName: null, asmName: null,
            target: 300_000, achieved: 120_000, pct: null, note: 'Not counted — outside this target’s scope',
          }], total: 1, page: 1, pageSize: 25 } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: payload({ outletsNotCovered: 1 }) }) };
    });
    vi.stubGlobal('fetch', fn);
    render(<Harness />);
    fireEvent.click(await screen.findByTestId('billing-not-covered'));
    expect(await screen.findByText('Silver Shop')).toBeInTheDocument();
    expect(await screen.findByText('₹3,00,000')).toBeInTheDocument();
    expect(await screen.findByText('₹1,20,000')).toBeInTheDocument();
    expect(await screen.findByTestId('billing-row-note-S1')).toHaveTextContent('Not counted — outside this target’s scope');
  });

  it('D9: a disabled zero-count bucket does not invite "Show outlets"', async () => {
    mockFetch(() => payload({
      buckets: payload().buckets.map((b) => (b.key === 'P60_80' ? { ...b, count: 0, pctOfOutlets: 0, targetSum: 0, achievedSum: 0 } : b)),
    }));
    render(<Harness />);
    const zero = await screen.findByTestId('billing-bucket-P60_80');
    expect(zero).toBeDisabled();
    expect(zero.getAttribute('aria-label')).not.toMatch(/Show outlets/);
    expect(await screen.findByTestId('billing-bucket-P0_20')).toHaveAttribute('aria-label', expect.stringMatching(/Show outlets$/));
  });

  it('BP16b (F5): future month → empty state, no pace and no buckets', async () => {
    const next = shiftMonth(CUR_MONTH, 1);
    mockFetch(() => payload({ month: next, monthStatus: 'FUTURE', asOf: null, daysElapsed: null, pacePct: null, paceAsOf: null }));
    render(<Harness />);
    expect(await screen.findByTestId('billing-future-month')).toHaveTextContent(`${monthWords(next)} hasn't started yet`);
    expect(screen.queryByTestId('billing-pace')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-bucket-NOT_STARTED')).not.toBeInTheDocument();
  });

  it('BP17 (F7): phone layout — key columns first, Program / Type / ASM hidden below sm; units + manager shown', async () => {
    mockFetch(() => payload());
    render(<Harness />);
    fireEvent.change(await screen.findByTestId('billing-manager'), { target: { value: 'm1' } });
    await screen.findByTestId('billing-totals');
    fireEvent.click(await screen.findByTestId('billing-bucket-NOT_STARTED'));
    await screen.findByText('Shop 1-0');
    const heads = (await screen.findAllByRole('columnheader')).map((h) => h.textContent?.trim());
    expect(heads.slice(0, 4)).toEqual(['Outlet', '%', 'Billed (₹)', 'Target (₹)']);
    for (const name of ['Program', 'Type', 'ASM']) {
      const th = screen.getByRole('columnheader', { name });
      expect(th.className).toContain('hidden');
      expect(th.className).toContain('sm:table-cell');
    }
    expect(screen.getByRole('columnheader', { name: 'SO' }).className).not.toContain('hidden');
    expect(await screen.findByText(/Manager: Asha ASM/)).toBeInTheDocument();
  });

  it('BP18 (F8): colours — light-grey Not started (with border/pattern), green Achieved, readable blue ramp', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrastVsWhite = (hex: string) => 1.05 / (lum(hex) + 0.05);
    const ns = BUCKET_COLORS.NOT_STARTED;
    expect(lum(ns)).toBeGreaterThan(0.6); // light grey
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(ns.slice(i, i + 2), 16));
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(16); // grey, not a hue
    const ach = BUCKET_COLORS.ACHIEVED;
    const [ar, ag, ab] = [1, 3, 5].map((i) => parseInt(ach.slice(i, i + 2), 16));
    expect(ag).toBeGreaterThan(ar);
    expect(ag).toBeGreaterThan(ab); // green
    const ramp = (['P0_20', 'P20_40', 'P40_60', 'P60_80', 'P80_100'] as const).map((k) => BUCKET_COLORS[k]);
    for (const c of ramp) {
      expect(contrastVsWhite(c)).toBeGreaterThanOrEqual(3); // WCAG non-text contrast, incl. the old faint 1–20% swatch
      const [cr, , cb] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      expect(cb).toBeGreaterThan(cr); // blue
    }
    for (let i = 1; i < ramp.length; i++) expect(lum(ramp[i])).toBeLessThan(lum(ramp[i - 1])); // ordered ramp
    // D9: neighbours are visibly different (≥ 1.25:1 between adjacent steps — incl. 60–79% vs 80–99%).
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (let i = 1; i < ramp.length; i++) expect(ratio(ramp[i], ramp[i - 1])).toBeGreaterThanOrEqual(1.25);
  });

  it('BP18b (F8): the Not started swatch carries a border so the light grey reads on white', async () => {
    mockFetch(() => payload());
    render(<Harness />);
    const sw = await screen.findByTestId('billing-swatch-NOT_STARTED');
    expect(sw.getAttribute('style') ?? '').toMatch(/border/);
  });

  it('BP19 (F9): each bucket aria-label carries the EXACT rupee figures', async () => {
    mockFetch(() => payload());
    render(<Harness />);
    const ns = await screen.findByTestId('billing-bucket-NOT_STARTED');
    expect(ns).toHaveAttribute('aria-label', expect.stringContaining('target ₹12,34,567'));
    expect(ns).toHaveAttribute('aria-label', expect.stringContaining('billed ₹0'));
    expect(await screen.findByTestId('billing-bucket-ACHIEVED')).toHaveAttribute(
      'aria-label', expect.stringContaining('target ₹9,00,000, billed ₹9,50,000'),
    );
  });

  it('BP20 (N3): totals % floors below 100 — never shows 100.0% for an unmet total', () => {
    expect(pctOf(99_960, 100_000)).toBe('99.9%');
    expect(pctOf(100_000, 100_000)).toBe('100.0%');
    expect(pctOf(250, 100)).toBe('250.0%');
    expect(pctOf(5, 0)).toBe('—');
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
