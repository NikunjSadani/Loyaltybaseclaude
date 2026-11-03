/// <reference types="vitest/globals" />
/**
 * OutletTrendComparisonCard — the Bajaj single-outlet "Trend Comparison" card that REPLACES the
 * historical Target-vs-Achievement graph on the outlet-detail page.
 *
 * OT1: buckets derived correctly from a chronological trend series (pure deriveOutletTrendBuckets).
 * OT2: null % when a month has no target (target 0 → pct null).
 * OT3: renders the three column headers + the Achievement / Target / % achievement rows with
 *      the ₹ values and the per-bucket percentages.
 * OT4: the % achievement cells are colour-coded (≥100 emerald, ≥80 amber, …).
 * OT5: the card self-hides (renders null) when the outlet has no target this month.
 * OT6: empty state when the outlet has a target but no trend history.
 * OT7: the KPI dropdown lists the outlet-targets KPI columns and defaults to the primary ('').
 *
 * Run: npx vitest run src/components/sales/__tests__/outlet-trend-comparison-card.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OutletTrendComparisonCard, deriveOutletTrendBuckets } from '../OutletTrendComparisonCard';

// A 6-month chronological series (oldest → newest). Pcts: 50/60/70/80/90/110.
const TREND = [
  { month: '2026-04', target: 100000, achieved: 50000 },
  { month: '2026-05', target: 100000, achieved: 60000 },
  { month: '2026-06', target: 100000, achieved: 70000 },
  { month: '2026-07', target: 100000, achieved: 80000 },
  { month: '2026-08', target: 200000, achieved: 180000 },
  { month: '2026-09', target: 200000, achieved: 220000 },
];

const TARGET_TREND_RESPONSE = {
  success: true,
  data: { kpiCode: 'PRIMARY', kpiName: 'Primary Sales', unit: 'INR', rollup: 'SUM', trend: TREND },
};

// outlet-targets: a row for OUT1 with a target this month → the card's show/hide gate passes.
const OUTLET_TARGETS = {
  success: true,
  data: {
    kpiColumns: [
      { code: 'PRIMARY', name: 'Primary Sales', unit: 'INR', isPrimary: true },
      { code: 'VOL', name: 'Volume', unit: 'Litre', isPrimary: false },
    ],
    rows: [{ outletCode: 'OUT1', kpis: { PRIMARY: { target: 200000, achieved: 220000, pace: null } } }],
  },
};

function mockOk(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlet-targets')) return mockOk(OUTLET_TARGETS);
    if (typeof url === 'string' && url.includes('/api/sales/target-trend')) return mockOk(TARGET_TREND_RESPONSE);
    return mockOk({ success: true, data: {} });
  });
});

describe('deriveOutletTrendBuckets', () => {
  it('OT1: current = last month, lastMonth = second-to-last, last3Months = mean of last 3', () => {
    const b = deriveOutletTrendBuckets(TREND);
    expect(b.current).toEqual({ achieved: 220000, target: 200000, pct: 110 });
    expect(b.lastMonth).toEqual({ achieved: 180000, target: 200000, pct: 90 });
    // mean achieved (80k+180k+220k)/3 = 160000; mean target (100k+200k+200k)/3 = 166666.67;
    // mean of non-null pcts [80,90,110] = 93.33 → 93.
    expect(b.last3Months.achieved).toBe(160000);
    expect(Math.round(b.last3Months.target as number)).toBe(166667);
    expect(b.last3Months.pct).toBe(93);
  });

  it('OT2: a month with no target yields a null % (and is excluded from the 3-month mean pct)', () => {
    const series = [
      { month: '2026-07', target: 0, achieved: 5000 },      // no target → pct null
      { month: '2026-08', target: 100000, achieved: 80000 }, // 80%
      { month: '2026-09', target: 100000, achieved: 90000 }, // 90%
    ];
    const b = deriveOutletTrendBuckets(series);
    expect(b.current.pct).toBe(90);
    expect(b.lastMonth.pct).toBe(80);
    // last3 pcts = [null, 80, 90] → mean of non-null = 85.
    expect(b.last3Months.pct).toBe(85);
  });

  it('OT1b: empty series → all-null buckets', () => {
    const b = deriveOutletTrendBuckets([]);
    expect(b.current).toEqual({ achieved: null, target: null, pct: null });
    expect(b.lastMonth).toEqual({ achieved: null, target: null, pct: null });
    expect(b.last3Months).toEqual({ achieved: null, target: null, pct: null });
  });
});

describe('OutletTrendComparisonCard', () => {
  it('OT3: renders the headers, the three rows, the ₹ values and the per-bucket pcts', async () => {
    render(<OutletTrendComparisonCard outletCode="OUT1" />);
    await waitFor(() => expect(screen.getByText('Achievement')).toBeInTheDocument());

    // Column headers
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Last month')).toBeInTheDocument();
    expect(screen.getByText('Last 3 months')).toBeInTheDocument();
    // Rows
    expect(screen.getByText('Target')).toBeInTheDocument();
    expect(screen.getByText('% achievement')).toBeInTheDocument();

    // Achievement: current ₹2.2L, last month ₹1.8L, 3-mo mean ₹1.6L.
    expect(screen.getByText('₹2.2L')).toBeInTheDocument();
    expect(screen.getByText('₹1.8L')).toBeInTheDocument();
    expect(screen.getByText('₹1.6L')).toBeInTheDocument();
    // Target: current ₹2L (also last-month ₹2L), 3-mo mean ₹1.7L.
    expect(screen.getAllByText('₹2L').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('₹1.7L')).toBeInTheDocument();
    // Percentages
    expect(screen.getByText('110%')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('93%')).toBeInTheDocument();
  });

  it('OT4: the % cells are colour-coded by band', async () => {
    render(<OutletTrendComparisonCard outletCode="OUT1" />);
    await waitFor(() => expect(screen.getByText('110%')).toBeInTheDocument());
    expect(screen.getByText('110%').className).toMatch(/text-emerald-600/); // ≥100
    expect(screen.getByText('90%').className).toMatch(/text-amber-600/);     // ≥80
    expect(screen.getByText('93%').className).toMatch(/text-amber-600/);     // ≥80
  });

  it('OT5: self-hides when the outlet has no target this month', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/sales/outlet-targets')) {
        return mockOk({ success: true, data: { kpiColumns: [{ code: 'PRIMARY', name: 'Primary Sales', unit: 'INR', isPrimary: true }], rows: [] } });
      }
      if (typeof url === 'string' && url.includes('/api/sales/target-trend')) return mockOk(TARGET_TREND_RESPONSE);
      return mockOk({ success: true, data: {} });
    });
    const { container } = render(<OutletTrendComparisonCard outletCode="OUT1" />);
    // No gating row ever present → the card never renders.
    await waitFor(() => expect(screen.queryByTestId('outlet-trend-comparison-card')).not.toBeInTheDocument());
    expect(container.querySelector('[data-testid="outlet-trend-comparison-card"]')).toBeNull();
  });

  it('OT6: empty state when the outlet has a target but no trend history', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/sales/outlet-targets')) return mockOk(OUTLET_TARGETS);
      if (typeof url === 'string' && url.includes('/api/sales/target-trend')) {
        return mockOk({ success: true, data: { kpiCode: 'PRIMARY', kpiName: 'Primary Sales', unit: 'INR', rollup: 'SUM', trend: [] } });
      }
      return mockOk({ success: true, data: {} });
    });
    render(<OutletTrendComparisonCard outletCode="OUT1" />);
    await waitFor(() => expect(screen.getByText(/No target history yet for this outlet/i)).toBeInTheDocument());
  });

  it('OT7: the KPI dropdown lists the outlet-targets KPI columns and defaults to the primary', async () => {
    render(<OutletTrendComparisonCard outletCode="OUT1" />);
    const kpiSelect = (await screen.findByLabelText('KPI')) as HTMLSelectElement;
    await waitFor(() => expect(within(kpiSelect).getByRole('option', { name: 'Volume' })).toBeInTheDocument());
    expect(within(kpiSelect).getByRole('option', { name: 'Primary KPI' })).toBeInTheDocument();
    expect(within(kpiSelect).getByRole('option', { name: 'Primary Sales' })).toBeInTheDocument();
    expect(kpiSelect.value).toBe('');
  });
});
