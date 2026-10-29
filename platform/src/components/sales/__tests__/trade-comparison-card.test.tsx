/**
 * TradeComparisonCard — renders the 3-bucket comparison from a stubbed trade-comparison response.
 *
 * TC1: renders the KPI name, the Monthly-sale ₹ values, and the Target-met pct per bucket.
 * TC2: current & lastMonth show the achieved/withTarget ratio; last3Months shows ONLY the pct.
 * TC3: the three column headers render (Current / Last month / Last 3 months).
 * TC4: program + team-member options come from the reused team-view filterOptions/members.
 * TC5: a failed refetch after a type change clears stale data + shows the error (no wrong bucket).
 * TC6: the KPI dropdown lists the response's KPIs and defaults to the primary ('' value).
 * TC7: changing the KPI refetches with ?kpi= and reformats the values by that KPI's unit.
 * TC8: the card header reads "Trend Comparison".
 *
 * Run: npx vitest run src/components/sales/__tests__/trade-comparison-card.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { TradeComparisonCard } from '../trade-comparison-card';

const TEAM_VIEW = {
  success: true,
  data: {
    mode: 'OVERVIEW',
    member: null,
    kpis: [],
    summary: { outlets: 0, kycDone: 0, kycPending: 0, avgScore: null },
    members: [
      { id: 'm1', name: 'Asha Rao', roleLabel: 'SO', employeeCode: 'E1', mobile: '9', teamSize: 2, outlets: 5, kycDone: 3, kycPending: 2, kpiPercents: {}, score: null },
    ],
    filterOptions: { outletTypes: [], programs: ['Gold', 'Silver'], kpis: [] },
  },
};

const KPI_LIST = [
  { code: 'PRIMARY', label: 'Primary Sales', unit: 'INR' },
  { code: 'VOL', label: 'Volume', unit: 'Litre' },
];

const COMPARISON = {
  success: true,
  data: {
    outletType: 'SSS', program: null, kpiCode: 'PRIMARY', kpiName: 'Primary Sales', kpiUnit: 'INR',
    kpis: KPI_LIST,
    buckets: {
      current:     { monthlySale: 120000, targetMet: { achieved: 8, withTarget: 10, pct: 80 } },
      lastMonth:   { monthlySale: 90000,  targetMet: { achieved: 6, withTarget: 10, pct: 60 } },
      last3Months: { monthlySale: 100000, targetMet: { achieved: null, withTarget: null, pct: 70 } },
    },
  },
};

// A second response for the non-INR (Litre) KPI — the backend echoes kpiUnit so the FE formats by it.
const COMPARISON_VOL = {
  success: true,
  data: {
    outletType: 'SSS', program: null, kpiCode: 'VOL', kpiName: 'Volume', kpiUnit: 'Litre',
    kpis: KPI_LIST,
    buckets: {
      current:     { monthlySale: 500, targetMet: { achieved: 2, withTarget: 4, pct: 50 } },
      lastMonth:   { monthlySale: 400, targetMet: { achieved: 1, withTarget: 4, pct: 25 } },
      last3Months: { monthlySale: 450, targetMet: { achieved: null, withTarget: null, pct: 40 } },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/team-view')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(TEAM_VIEW) });
    }
    if (typeof url === 'string' && url.includes('/api/sales/trade-comparison')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(COMPARISON) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

describe('TradeComparisonCard', () => {
  it('TC1: renders the KPI name, ₹ monthly sales, and target-met pct', async () => {
    render(<TradeComparisonCard outletType="SSS" />);
    await waitFor(() => expect(screen.getAllByText('Primary Sales').length).toBeGreaterThan(0));
    expect(screen.getByText('₹1.2L')).toBeInTheDocument();  // current (1,20,000 → compact lakhs)
    expect(screen.getByText('₹90K')).toBeInTheDocument();   // last month (90,000 → compact thousands)
    expect(screen.getByText('₹1L')).toBeInTheDocument();    // last 3 months avg (1,00,000 → compact lakhs)
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
  });

  it('TC2: shows achieved/withTarget for current & last month, pct-only for last 3 months', async () => {
    render(<TradeComparisonCard outletType="SSS" />);
    await waitFor(() => expect(screen.getAllByText('Primary Sales').length).toBeGreaterThan(0));
    expect(screen.getByText('8/10')).toBeInTheDocument();  // current ratio
    expect(screen.getByText('6/10')).toBeInTheDocument();  // last-month ratio
    // last3Months carries null achieved/withTarget → no ratio rendered, only the 70% pct.
    expect(screen.queryByText('7/10')).not.toBeInTheDocument();
  });

  it('TC3: renders the three column headers', async () => {
    render(<TradeComparisonCard outletType="SSS" />);
    await waitFor(() => expect(screen.getByText('Current')).toBeInTheDocument());
    expect(screen.getByText('Last month')).toBeInTheDocument();
    expect(screen.getByText('Last 3 months')).toBeInTheDocument();
    // Row label is now the selected KPI's name (default = primary). It may also appear as a
    // dropdown option, so allow multiple matches.
    expect(screen.getAllByText('Primary Sales').length).toBeGreaterThan(0);
    expect(screen.getByText('Width of achievement')).toBeInTheDocument();
  });

  it('TC4: program + member filter options come from team-view', async () => {
    render(<TradeComparisonCard outletType="SSS" />);
    const programSelect = await screen.findByLabelText('Program');
    await waitFor(() => expect(within(programSelect).getByRole('option', { name: 'Gold' })).toBeInTheDocument());
    expect(within(programSelect).getByRole('option', { name: 'Silver' })).toBeInTheDocument();
    const memberSelect = screen.getByLabelText('Team member');
    expect(within(memberSelect).getByRole('option', { name: /Asha Rao/ })).toBeInTheDocument();
  });

  it('TC5: a failed refetch after a type change clears stale data and shows the error (no wrong bucket)', async () => {
    const { rerender } = render(<TradeComparisonCard outletType="SSS" />);
    // First load succeeds — RLP numbers on screen (compact ₹).
    await waitFor(() => expect(screen.getByText('₹1.2L')).toBeInTheDocument());

    // Backend now errors for the comparison; switch the outlet type → refetch.
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/sales/trade-comparison')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false, error: 'boom' }) });
      }
      if (typeof url === 'string' && url.includes('/api/sales/team-view')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(TEAM_VIEW) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    });
    rerender(<TradeComparisonCard outletType="WHOLESALER" />);

    // The error state shows and the previous (RLP) numbers are GONE — never shown under the new type.
    await waitFor(() => expect(screen.getByText(/Couldn.t load the comparison/i)).toBeInTheDocument());
    expect(screen.queryByText('₹1.2L')).not.toBeInTheDocument();
    expect(screen.queryByText('₹90K')).not.toBeInTheDocument();
  });

  it('TC6: the KPI dropdown lists the response KPIs and defaults to the primary', async () => {
    render(<TradeComparisonCard outletType="SSS" />);
    const kpiSelect = (await screen.findByLabelText('KPI')) as HTMLSelectElement;
    await waitFor(() => expect(within(kpiSelect).getByRole('option', { name: 'Volume' })).toBeInTheDocument());
    expect(within(kpiSelect).getByRole('option', { name: 'Primary KPI' })).toBeInTheDocument();
    expect(within(kpiSelect).getByRole('option', { name: 'Primary Sales' })).toBeInTheDocument();
    // Default selection is the primary (the '' value → the backend's primary default).
    expect(kpiSelect.value).toBe('');
  });

  it('TC7: changing the KPI refetches with ?kpi= and reformats by that KPI unit', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/sales/team-view')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(TEAM_VIEW) });
      }
      if (typeof url === 'string' && url.includes('/api/sales/trade-comparison')) {
        const body = url.includes('kpi=VOL') ? COMPARISON_VOL : COMPARISON;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    });

    render(<TradeComparisonCard outletType="SSS" />);
    await waitFor(() => expect(screen.getByText('₹1.2L')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('KPI'), { target: { value: 'VOL' } });

    // Refetch for VOL: values reformatted with the Litre unit suffix (no ₹).
    await waitFor(() => expect(screen.getByText('500 Litre')).toBeInTheDocument());
    expect(screen.getByText('400 Litre')).toBeInTheDocument();
    expect(screen.getByText('450 Litre')).toBeInTheDocument();
    // The request carried ?kpi=VOL, and the old ₹ figure is gone.
    expect(fetchMock.mock.calls.some(([u]) => typeof u === 'string' && u.includes('kpi=VOL'))).toBe(true);
    expect(screen.queryByText('₹1.2L')).not.toBeInTheDocument();
  });

  it('TC8: the card header reads "Trend Comparison"', async () => {
    render(<TradeComparisonCard outletType="SSS" />);
    expect(await screen.findByText('Trend Comparison')).toBeInTheDocument();
  });
});
