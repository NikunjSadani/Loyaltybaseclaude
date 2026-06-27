/// <reference types="vitest/globals" />
/**
 * Admin KYC Dashboard — REAL data wiring.
 *
 * The page was 100% fabricated (value: 248, SLA_COMPLIANCE = 85.5, hardcoded state/
 * rejection arrays). It is now wired to GET /api/admin/dashboard/kyc. These tests prove:
 *  - RD1: headline coverage % renders from the fetched payload
 *  - RD2: both bottleneck buckets render their count + breached count
 *  - RD3: an SLA compliance % renders
 *  - RD4: at least one coverageBy.state row renders
 *  - RD5: NO fabricated fallback — when the fetch rejects, an error state shows and the
 *         old demo numbers ("248", "85.5") are NOT in the document.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import KycDashboardPage from '../page';

const PAYLOAD = {
  scope: { tenant: 'Deoleo', generatedAt: '2026-06-27T08:30:00.000Z' },
  universe: { addressableOutlets: 1000, notInterested: 60, inactive: 40 },
  headline: {
    coveragePct: 73.4,
    approved: 734,
    inPipeline: 520,
    pendingField: 470,
    awaitingGifsy: 50,
    rejectedOrReupload: 30,
    notStarted: 200,
    approvalRatePct: 88.2,
  },
  funnel: [
    { stage: 'Started', count: 900 },
    { stage: 'Submitted', count: 800 },
    { stage: 'Field Approved', count: 760 },
    { stage: 'Approved', count: 734 },
  ],
  buckets: {
    pendingFieldApproval: { count: 470, withinSla: 300, breached: 170, slaHours: 24 },
    pendingGifsyApproval: { count: 50, withinSla: 45, breached: 5, slaHours: 96 },
  },
  sla: {
    endToEndAvgHours: 60.2,
    fieldChainAvgHours: 18.5,
    gifsyReviewAvgHours: 72.0,
    fieldCompliancePct: 91.3,
    gifsyCompliancePct: 84.0,
    sampleSize: 612,
  },
  quality: {
    topRejectionReasons: [
      { reason: 'Blurry documents', count: 22 },
      { reason: 'GST mismatch', count: 14 },
    ],
    reUploadRatePct: 12.7,
  },
  coverageBy: {
    state: [
      { key: 'Maharashtra', addressable: 300, approved: 240, coveragePct: 80.0 },
      { key: 'Karnataka', addressable: 200, approved: 130, coveragePct: 65.0 },
    ],
    outletType: [
      { key: 'SSS', addressable: 500, approved: 400, coveragePct: 80.0 },
    ],
    program: [
      { key: 'Trade Loyalty', addressable: 1000, approved: 734, coveragePct: 73.4 },
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

describe('Admin KYC Dashboard — real data', () => {
  it('RD1: renders the headline coverage % from the payload', async () => {
    mockFetchOk();
    render(<KycDashboardPage />);
    // coverage % appears on the headline card (and, by definition, as the Approved
    // pipeline bar's share of addressable) — assert ≥1 occurrence
    expect((await screen.findAllByText('73.4%')).length).toBeGreaterThan(0);
    // subtitle proves approved/addressable came from the payload (unique to the card)
    expect(screen.getByText('734 / 1,000 approved')).toBeInTheDocument();
  });

  it('RD2: renders both bottleneck bucket counts and breached counts', async () => {
    mockFetchOk();
    render(<KycDashboardPage />);
    // bucket counts (also shown on the headline cards → expect ≥1 occurrence each)
    expect((await screen.findAllByText('470')).length).toBeGreaterThan(0); // pending field
    expect(screen.getAllByText('50').length).toBeGreaterThan(0);           // awaiting gifsy
    // breached counts (unique to the bucket stacked bars)
    expect(screen.getByText('170 breached')).toBeInTheDocument();
    expect(screen.getByText('5 breached')).toBeInTheDocument();
  });

  it('RD3: renders an SLA compliance %', async () => {
    mockFetchOk();
    render(<KycDashboardPage />);
    expect(await screen.findByText('91.3% within SLA')).toBeInTheDocument();
  });

  it('RD4: renders at least one coverageBy.state row', async () => {
    mockFetchOk();
    render(<KycDashboardPage />);
    expect(await screen.findByText('Maharashtra')).toBeInTheDocument();
    expect(screen.getByText('240 / 300')).toBeInTheDocument();
  });

  it('RD5: on fetch failure shows an error state and NO fabricated demo numbers', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    render(<KycDashboardPage />);

    // explicit error state appears
    expect(await screen.findByTestId('kyc-dashboard-error')).toBeInTheDocument();

    // the old fabricated literals must NOT be present anywhere
    expect(screen.queryByText('248')).not.toBeInTheDocument();
    expect(screen.queryByText(/85\.5/)).not.toBeInTheDocument();
    expect(screen.queryByText('221')).not.toBeInTheDocument();
    // and no real data either (we never got a payload)
    expect(screen.queryByText('73.4%')).not.toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
