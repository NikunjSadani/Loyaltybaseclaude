/// <reference types="vitest/globals" />
/**
 * Admin Finance Dashboard — REAL data wiring.
 *
 * Every number on the page is wired to GET /api/admin/dashboard/finance. These
 * tests prove:
 *  - RD1: a points-liability ₹ value renders from the fetched payload
 *  - RD2: the breakage % renders
 *  - RD3: a TDS outstanding ₹ value renders (194R tenant + 194C platform labelled)
 *  - RD4: a fund balance ₹ value renders
 *  - RD5: NO fabricated fallback — when the fetch rejects, an error state shows and
 *         the real payload numbers are NOT in the document.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import FinanceDashboardPage from '../page';

const PAYLOAD = {
  scope: { tenant: 'Deoleo', generatedAt: '2026-06-27T08:30:00.000Z', fy: '2025-26' },
  liability: {
    redeemablePoints: 50_000,
    lockedPoints: 12_000,
    conversionRate: 10,
    redeemableRupees: 5_000,
    lockedRupees: 1_200,
  },
  breakage: {
    period: '2026-06',
    expiredPoints: 2_000,
    issuedPoints: 40_000,
    breakagePct: 5,
    expiredRupees: 200,
  },
  tds: {
    fy: '2025-26',
    sec194R: { liabilityRupees: 10_000, depositedRupees: 4_000, outstandingRupees: 6_000 },
    sec194C: { liabilityRupees: 25_000, depositedRupees: 5_000, outstandingRupees: 20_000 },
  },
  fund: {
    totalReceivedRupees: 100_000,
    totalUtilisedRupees: 70_000,
    closingBalanceRupees: 30_000,
    pendingLiabilityRupees: 8_000,
    availableRupees: 22_000,
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

describe('Admin Finance Dashboard — real data', () => {
  it('RD1: renders a points-liability ₹ value from the payload', async () => {
    mockFetchOk();
    render(<FinanceDashboardPage />);
    // redeemable ₹5,000 (appears on the stat card and the detail block)
    expect((await screen.findAllByText('₹5,000.00')).length).toBeGreaterThan(0);
    // locked points line is unique to the detail block
    expect(screen.getByText('12,000 points')).toBeInTheDocument();
  });

  it('RD2: renders the breakage %', async () => {
    mockFetchOk();
    render(<FinanceDashboardPage />);
    // breakage 5.0% renders (stat card + breakage panel)
    expect((await screen.findAllByText('5.0%')).length).toBeGreaterThan(0);
    expect(screen.getByText('2,000 expired / 40,000 issued')).toBeInTheDocument();
  });

  it('RD3: renders a TDS outstanding value, with 194R tenant + 194C platform labelled', async () => {
    mockFetchOk();
    render(<FinanceDashboardPage />);
    // 194C outstanding ₹20,000 (unique value)
    expect(await screen.findByText('₹20,000.00')).toBeInTheDocument();
    // both sections present and labelled
    expect(screen.getByText('Section 194R')).toBeInTheDocument();
    expect(screen.getByText('Section 194C')).toBeInTheDocument();
    expect(screen.getByText('Tenant')).toBeInTheDocument();
    expect(screen.getByText('Platform')).toBeInTheDocument();
  });

  it('RD4: renders a fund balance value', async () => {
    mockFetchOk();
    render(<FinanceDashboardPage />);
    // available ₹22,000 is unique to the fund ledger (and the headline card)
    expect((await screen.findAllByText('₹22,000.00')).length).toBeGreaterThan(0);
    expect(screen.getByText('Total Received')).toBeInTheDocument();
  });

  it('RD5: on fetch failure shows an error state and NO real payload numbers', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceDashboardPage />);

    // explicit error state appears
    expect(await screen.findByTestId('finance-dashboard-error')).toBeInTheDocument();

    // no real data leaked into the error view
    expect(screen.queryByText('₹5,000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('₹20,000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('5.0%')).not.toBeInTheDocument();
    expect(screen.queryByText('₹22,000.00')).not.toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
