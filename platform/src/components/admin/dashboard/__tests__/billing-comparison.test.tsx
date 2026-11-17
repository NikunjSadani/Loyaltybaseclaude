/// <reference types="vitest/globals" />
/**
 * BillingComparison — MTD vs last month / 3-month average to the same day (compact row on the billing card).
 *  BC1 data state: arrows + signs + screen-reader words (not colour only), "to day N"
 *  BC2 request carries month / program / outletType / managerId
 *  BC3 unavailable → "available from <Month YYYY>" (months computed relative to now)
 *  BC4 NO_DAY_LEVEL_DATA / NO_KPI → renders nothing
 *  BC5 NO_DAY_DATA_FOR_MONTH / KPI_NOT_IN_DAY_DATA → one honest line
 *  BC6 zero base → "nothing billed … to compare"; zero delta → "no change"
 *  BC7 loading → status line; error → alert + Retry recovers
 *  BC8 slower-than-usual: 0 → plain text; N → modal with paging, Retry, Download Excel; hidden when last month unavailable
 *  BC9 shorter prior month → label names both days
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import {
  BillingComparison, BILLING_COMPARISON_URL, BILLING_SLOWER_EXPORT_URL, BILLING_SLOWER_URL,
  comparisonMonthWords, deltaText, type BillingComparisonData,
} from '../BillingComparison';
import { istMonthKey } from '@/lib/ist-date';

const T = { timeout: 5000 };
const CUR = istMonthKey(new Date());
function shift(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function payload(over: Partial<BillingComparisonData> = {}): BillingComparisonData {
  return {
    month: CUR,
    kpi: { code: 'SAMT', label: 'Sales', unit: 'INR' },
    reason: null,
    compareDay: 17,
    current: { mtd: 1_124_000, outlets: 300 },
    lastMonth: { available: true, availableFrom: null, reason: null, month: shift(CUR, -1), compareDay: 17, mtd: 1_000_000, deltaPct: 12.4 },
    threeMonthAvg: {
      available: true, availableFrom: null, reason: null, months: [shift(CUR, -1), shift(CUR, -2), shift(CUR, -3)],
      compareDays: [17, 17, 17], avgMtd: 1_160_000, deltaPct: -3.1,
    },
    slowerThanUsual: { count: 60, thresholdPct: 80 },
    ...over,
  };
}

function slowerPage(page: number, total = 60) {
  return {
    rows: Array.from({ length: 2 }, (_, i) => ({
      outletCode: `S-${page}-${i}`, outletName: `Shop ${page}-${i}`, program: 'Gold', soName: 'Sunil', asmName: null,
      currentMtd: 12_345.6, lastMonthMtd: 1_23_456, ratioPct: 10,
    })),
    total, page, pageSize: 25,
  };
}

function mockFetch(summary: () => unknown, opts: { failSummary?: () => boolean; failList?: () => boolean } = {}) {
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith(BILLING_SLOWER_EXPORT_URL)) {
      return { ok: true, status: 202, json: async () => ({ success: true, data: { exportRequestId: 'x1', message: 'Queued for you.' } }) };
    }
    if (u.startsWith(BILLING_SLOWER_URL)) {
      if (opts.failList?.()) return { ok: false, status: 500, json: async () => ({ message: 'List exploded' }) };
      const page = Number(new URL(u, 'http://x').searchParams.get('page') ?? '1');
      return { ok: true, status: 200, json: async () => ({ success: true, data: slowerPage(page) }) };
    }
    if (u.startsWith(BILLING_COMPARISON_URL)) {
      if (opts.failSummary?.()) return { ok: false, status: 500, json: async () => ({ message: 'Server exploded' }) };
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
});

describe('helpers', () => {
  it('deltaText: arrow + sign + words; zero = no change', () => {
    expect(deltaText(12.4)).toEqual({ arrow: '▲', text: '+12.4%', words: 'up 12.4%', dir: 'up' });
    expect(deltaText(-3.1)).toEqual({ arrow: '▼', text: '−3.1%', words: 'down 3.1%', dir: 'down' });
    expect(deltaText(0)).toMatchObject({ text: 'no change', dir: 'flat' });
  });
  it('comparisonMonthWords', () => {
    expect(comparisonMonthWords('2026-12')).toBe('December 2026');
    expect(comparisonMonthWords('bad')).toBe('bad');
  });
});

describe('BillingComparison', () => {
  it('BC1: shows both comparisons with arrow, sign and screen-reader words', async () => {
    mockFetch(() => payload());
    render(<BillingComparison month={CUR} />);
    const lm = await screen.findByTestId('billing-vs-last-month', {}, T);
    expect(lm).toHaveTextContent('vs last month (to day 17):');
    expect(lm).toHaveTextContent('▲ +12.4%');
    expect(within(lm).getByText('up 12.4%')).toHaveClass('sr-only');
    const avg = await screen.findByTestId('billing-vs-3-month-avg', {}, T);
    expect(avg).toHaveTextContent('vs 3-month average (to day 17):');
    expect(avg).toHaveTextContent('▼ −3.1%');
    expect(within(avg).getByText('down 3.1%')).toBeInTheDocument();
    expect(lm.getAttribute('title')).toContain('This month ₹11.2L');
  });

  it('BC2: the request carries every filter', async () => {
    const fn = mockFetch(() => payload());
    render(<BillingComparison month="2026-10" program="Gold" outletType="RETAIL" managerId="m1" />);
    await screen.findByTestId('billing-vs-last-month', {}, T);
    const u = new URL(calls(fn, BILLING_COMPARISON_URL)[0], 'http://x');
    expect(u.pathname).toBe(BILLING_COMPARISON_URL);
    expect(Object.fromEntries(u.searchParams)).toEqual({ month: '2026-10', program: 'Gold', outletType: 'RETAIL', managerId: 'm1' });
  });

  it('BC3: unavailable comparisons say from which month; no slower line without last month', async () => {
    const next = shift(CUR, 1);
    const plus3 = shift(CUR, 3);
    mockFetch(() =>
      payload({
        lastMonth: { available: false, availableFrom: next, reason: 'NO_DAY_DATA', month: shift(CUR, -1), compareDay: 17, mtd: null, deltaPct: null },
        threeMonthAvg: { available: false, availableFrom: plus3, reason: 'NO_DAY_DATA', months: [], compareDays: [], avgMtd: null, deltaPct: null },
        slowerThanUsual: { count: 0, thresholdPct: 80 },
      }),
    );
    render(<BillingComparison month={CUR} />);
    expect(await screen.findByTestId('billing-vs-last-month', {}, T)).toHaveTextContent(
      `Comparison with last month available from ${comparisonMonthWords(next)}`,
    );
    expect(screen.getByTestId('billing-vs-3-month-avg')).toHaveTextContent(`3-month average available from ${comparisonMonthWords(plus3)}`);
    expect(screen.queryByTestId('billing-slower-than-usual')).toBeNull();
  });

  it.each(['NO_DAY_LEVEL_DATA', 'NO_KPI'] as const)('BC4: %s → renders nothing', async (reason) => {
    const fn = mockFetch(() => payload({ reason, kpi: reason === 'NO_KPI' ? null : payload().kpi }));
    const { container } = render(<BillingComparison month={CUR} />);
    await waitFor(() => expect(calls(fn, BILLING_COMPARISON_URL).length).toBe(1), T);
    await waitFor(() => expect(screen.queryByTestId('billing-comparison-loading')).toBeNull(), T);
    expect(container).toBeEmptyDOMElement();
  });

  it('BC5: no day data for the month / KPI not in day data → one honest line', async () => {
    mockFetch(() => payload({ reason: 'NO_DAY_DATA_FOR_MONTH', compareDay: null }));
    const { unmount } = render(<BillingComparison month={CUR} />);
    expect(await screen.findByTestId('billing-comparison-no-month-data', {}, T)).toHaveTextContent(
      `No day-by-day sales for ${comparisonMonthWords(CUR)} yet`,
    );
    expect(screen.queryByTestId('billing-vs-last-month')).toBeNull();
    unmount();
    mockFetch(() => payload({ reason: 'KPI_NOT_IN_DAY_DATA' }));
    render(<BillingComparison month={CUR} />);
    expect(await screen.findByTestId('billing-comparison-kpi-missing', {}, T)).toHaveTextContent("doesn't include Sales");
  });

  it('BC6: zero base → nothing to compare (never a fake %); zero delta → no change', async () => {
    mockFetch(() =>
      payload({
        lastMonth: { ...payload().lastMonth, mtd: 0, deltaPct: null },
        threeMonthAvg: { ...payload().threeMonthAvg, deltaPct: 0 },
      }),
    );
    render(<BillingComparison month={CUR} />);
    const lm = await screen.findByTestId('billing-vs-last-month', {}, T);
    expect(lm).toHaveTextContent('nothing billed last month to this day to compare');
    expect(lm).not.toHaveTextContent('%');
    expect(await screen.findByTestId('billing-vs-3-month-avg', {}, T)).toHaveTextContent('no change');
  });

  it('BC7: loading status, then error with Retry that recovers', async () => {
    let fail = true;
    const fn = mockFetch(() => payload(), { failSummary: () => fail });
    render(<BillingComparison month={CUR} />);
    expect(screen.getByTestId('billing-comparison-loading')).toHaveAttribute('role', 'status');
    const alert = await screen.findByTestId('billing-comparison-error', {}, T);
    expect(alert).toHaveTextContent('Server exploded');
    expect(screen.queryByTestId('billing-vs-last-month')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByTestId('billing-comparison-retry'));
    expect(await screen.findByTestId('billing-vs-last-month', {}, T)).toHaveTextContent('+12.4%');
    expect(calls(fn, BILLING_COMPARISON_URL)).toHaveLength(2);
  });

  it('BC8a: no slower outlets → plain text, not a button', async () => {
    mockFetch(() => payload({ slowerThanUsual: { count: 0, thresholdPct: 80 } }));
    render(<BillingComparison month={CUR} />);
    const el = await screen.findByTestId('billing-slower-than-usual', {}, T);
    expect(el.tagName).toBe('P');
    expect(el).toHaveTextContent('No outlets billing slower than usual (below 80% of their pace last month)');
  });

  it('BC8b: slower outlets → modal with paging, Retry on error and Download Excel', async () => {
    let failList = false;
    const fn = mockFetch(() => payload(), { failList: () => failList });
    render(<BillingComparison month={CUR} program="Gold" managerId="m1" managerName="Asha" />);
    const btn = await screen.findByTestId('billing-slower-than-usual', {}, T);
    expect(btn).toHaveTextContent('60 outlets billing slower than usual (below 80% of their pace last month)');
    fireEvent.click(btn);
    await screen.findByTestId('billing-slower-drilldown', {}, T);
    expect(await screen.findByText('Shop 1-0', {}, T)).toBeInTheDocument();
    expect(await screen.findByTestId('billing-slower-count', {}, T)).toHaveTextContent('Showing 1–25 of 60 outlets');
    expect(screen.getByText('Manager: Asha (and team)', { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText('₹12,346').length).toBeGreaterThan(0);
    expect(screen.getAllByText('₹1,23,456').length).toBeGreaterThan(0);
    const first = new URL(calls(fn, BILLING_SLOWER_URL)[0], 'http://x');
    expect(Object.fromEntries(first.searchParams)).toMatchObject({ month: CUR, program: 'Gold', managerId: 'm1', page: '1', pageSize: '25' });

    // Next page
    fireEvent.click(screen.getByTestId('billing-slower-next'));
    expect(await screen.findByText('Shop 2-0', {}, T)).toBeInTheDocument();

    // Error on the next page → Retry recovers
    failList = true;
    fireEvent.click(screen.getByTestId('billing-slower-next'));
    expect(await screen.findByTestId('billing-slower-error', {}, T)).toHaveTextContent('List exploded');
    expect(screen.getByTestId('billing-slower-next')).toBeInTheDocument(); // paging keeps the last total
    failList = false;
    fireEvent.click(screen.getByTestId('billing-slower-retry'));
    expect(await screen.findByText('Shop 3-0', {}, T)).toBeInTheDocument();

    // Download Excel → the export URL with the filters
    fireEvent.click(screen.getByTestId('billing-slower-download'));
    await waitFor(() => expect(calls(fn, BILLING_SLOWER_EXPORT_URL).length).toBe(1), T);
    const ex = new URL(calls(fn, BILLING_SLOWER_EXPORT_URL)[0], 'http://x');
    expect(Object.fromEntries(ex.searchParams)).toEqual({ month: CUR, program: 'Gold', managerId: 'm1' });
  });

  it('BC9: a shorter prior month names both days', async () => {
    mockFetch(() => payload({ compareDay: 31, lastMonth: { ...payload().lastMonth, compareDay: 30 }, threeMonthAvg: { ...payload().threeMonthAvg, compareDays: [30, 31, 28] } }));
    render(<BillingComparison month={CUR} />);
    expect(await screen.findByTestId('billing-vs-last-month', {}, T)).toHaveTextContent('vs last month (to day 31; day 30 last month):');
    expect(screen.getByTestId('billing-vs-3-month-avg')).toHaveTextContent('to day 31, or the last day of a shorter month');
  });
});
