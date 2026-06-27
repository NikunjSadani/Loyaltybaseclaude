/// <reference types="vitest/globals" />
/**
 * Admin Program Health Dashboard — REAL data wiring.
 *
 * The page is 100% wired to GET /api/admin/dashboard/program-health. These tests prove:
 *  - RD1: the HERO primary-KPI achievement % renders from the fetched payload
 *  - RD2: the participation rate renders from the payload
 *  - RD3: a points-economy value renders from the payload
 *  - RD4: on fetch rejection an error state shows and NO fabricated numbers appear
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import ProgramHealthPage from '../page';

// recharts' ResponsiveContainer measures 0×0 in jsdom and warns; stub it to a plain div
// so the chart children mount without noise. The page's data assertions don't depend on
// the SVG rendering.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 220 }}>{children}</div>
    ),
  };
});

const PAYLOAD = {
  scope: { tenant: 'Deoleo', generatedAt: '2026-06-27T08:30:00.000Z', period: '2026-06' },
  activation: {
    registered: 1000,
    kycApproved: 734,
    firstEarn: 600,
    firstRedeem: 220,
    medianTimeToActivateDays: 4.5,
  },
  participation: {
    addressable: 1000,
    activeEarnersThisMonth: 420,
    activeRatePct: 42.0,
    trend: [
      { month: '2026-01', activeEarners: 100 },
      { month: '2026-02', activeEarners: 180 },
      { month: '2026-03', activeEarners: 250 },
      { month: '2026-04', activeEarners: 320 },
      { month: '2026-05', activeEarners: 390 },
      { month: '2026-06', activeEarners: 420 },
    ],
  },
  pointsEconomy: {
    issued: 1250000,
    redeemed: 480000,
    outstandingLiabilityPoints: 3400000,
    outstandingLiabilityRupees: 340000,
    breakagePct: 3.2,
    expiringIn30dPoints: 95000,
  },
  targetAchievement: {
    period: '2026-06',
    primary: {
      kpiCode: 'VOL',
      kpiName: 'Volume',
      unit: 'cases',
      target: 20000,
      achieved: 14500,
      pct: 72.5,
      isPrimary: true,
    },
    kpis: [
      { kpiCode: 'VOL', kpiName: 'Volume', unit: 'cases', target: 20000, achieved: 14500, pct: 72.5, isPrimary: true },
      { kpiCode: 'NEW', kpiName: 'New Outlets', unit: '', target: 0, achieved: 30, pct: null, isPrimary: false },
    ],
  },
  redemptions: {
    period: '2026-06',
    byMode: [
      { mode: 'UPI', count: 120, points: 60000, valueRupees: 6000 },
      { mode: 'GIFT_CARD', count: 40, points: 20000, valueRupees: 2000 },
    ],
    fulfilment: [
      { status: 'DELIVERED', count: 130 },
      { status: 'PENDING', count: 30 },
    ],
  },
};

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(PAYLOAD),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Admin Program Health Dashboard — real data', () => {
  it('RD1: renders the HERO primary-KPI achievement % from the payload', async () => {
    mockFetchOk();
    render(<ProgramHealthPage />);
    // the primary KPI % is unique to the hero big stat
    const pct = await screen.findByTestId('primary-kpi-pct');
    expect(pct).toHaveTextContent('72.5%');
    // achieved / target proves the rollup numbers came from the payload
    expect(screen.getByTestId('primary-kpi-achieved')).toHaveTextContent('14,500');
  });

  it('RD2: renders the participation rate from the payload', async () => {
    mockFetchOk();
    render(<ProgramHealthPage />);
    const rate = await screen.findByTestId('participation-rate');
    expect(rate).toHaveTextContent('42.0%');
    expect(screen.getByText('420 / 1,000 active earners')).toBeInTheDocument();
  });

  it('RD3: renders a points-economy value from the payload', async () => {
    mockFetchOk();
    render(<ProgramHealthPage />);
    // breakage % is unique to the points-economy section
    expect(await screen.findByText('3.2%')).toBeInTheDocument();
    // issued points
    expect(screen.getByText(/12,50,000/)).toBeInTheDocument();
  });

  it('RD4: on fetch failure shows an error state and NO fabricated numbers', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    render(<ProgramHealthPage />);

    expect(await screen.findByTestId('program-health-error')).toBeInTheDocument();

    // none of the real payload literals should be present (we never received them) and
    // there must be no fabricated fallback numbers either.
    expect(screen.queryByTestId('primary-kpi-pct')).not.toBeInTheDocument();
    expect(screen.queryByText('72.5%')).not.toBeInTheDocument();
    expect(screen.queryByText('42.0%')).not.toBeInTheDocument();
    expect(screen.queryByTestId('participation-rate')).not.toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
