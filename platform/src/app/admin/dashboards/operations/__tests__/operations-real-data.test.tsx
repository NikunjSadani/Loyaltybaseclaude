/// <reference types="vitest/globals" />
/**
 * Admin Operations Dashboard — REAL data wiring.
 *
 * Proves the page is fully driven by GET /api/admin/dashboard/operations:
 *  - RD1: payout success rate renders from the fetched payload
 *  - RD2: a ticket metric (MTTR) renders, and a null metric (first-response) shows "—"
 *  - RD3: the visibility card is ABSENT when payload.visibility === null
 *  - RD4: the visibility card is PRESENT when payload.visibility is provided
 *  - RD5: on fetch failure an error state shows and NO fabricated numbers appear
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import OperationsDashboardPage from '../page';

const BASE_PAYLOAD = {
  scope: { tenant: 'Deoleo', generatedAt: '2026-06-27T08:30:00.000Z' },
  payouts: {
    total: 200,
    success: 168,
    failed: 12,
    pending: 20,
    successRatePct: 84.0,
    failureRatePct: 6.0,
    pendingValueRupees: 45000,
    latencyByMode: [
      { mode: 'UPI', avgHours: 2.5, sampleSize: 120 },
      { mode: 'BANK_TRANSFER', avgHours: 11.0, sampleSize: 48 },
    ],
  },
  tickets: {
    open: 37,
    byStatus: [
      { status: 'OPEN', count: 25 },
      { status: 'IN_PROGRESS', count: 10 },
    ],
    byPriority: [{ priority: 'HIGH', count: 8 }],
    byCategory: [{ category: 'PAYOUT', count: 14 }],
    mttrHours: 18.4,
    firstResponseHours: null, // never populated by the live flow → "—"
    slaCompliancePct: 92.5,
    sampleSize: 80,
    ageBuckets: [
      { bucket: '<4h', count: 5 },
      { bucket: '4-24h', count: 12 },
      { bucket: '1-7d', count: 15 },
      { bucket: '>7d', count: 5 },
    ],
  },
  settlement: { avgLatencyHours: 9.2, sampleSize: 60 },
};

const PAYLOAD_VIS_NULL = { ...BASE_PAYLOAD, visibility: null };

const PAYLOAD_VIS_ON = {
  ...BASE_PAYLOAD,
  visibility: {
    enabled: true,
    submitted: 140,
    approved: 110,
    rejected: 20,
    flagged: 10,
    approvalRatePct: 78.6,
    fraudFlagPct: 7.1,
    participationPct: 64.0,
  },
};

function mockFetch(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(payload),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Admin Operations Dashboard — real data', () => {
  it('RD1: renders the payout success rate from the payload', async () => {
    mockFetch(PAYLOAD_VIS_NULL);
    render(<OperationsDashboardPage />);
    expect((await screen.findAllByText('84.0%')).length).toBeGreaterThan(0);
    expect(screen.getByText('168 / 200 transactions')).toBeInTheDocument();
  });

  it('RD2: renders MTTR and shows "—" for the null first-response metric', async () => {
    mockFetch(PAYLOAD_VIS_NULL);
    render(<OperationsDashboardPage />);
    expect(await screen.findByText('18.4h')).toBeInTheDocument();
    // first-response is null → the card under "First Response" shows an em-dash
    expect(screen.getByText('avg time to first reply')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('RD3: hides the visibility card when payload.visibility is null', async () => {
    mockFetch(PAYLOAD_VIS_NULL);
    render(<OperationsDashboardPage />);
    // wait until the page has rendered (success rate present)
    await screen.findByText('168 / 200 transactions');
    expect(screen.queryByTestId('operations-visibility-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Visibility Program Funnel')).not.toBeInTheDocument();
  });

  it('RD4: shows the visibility card with its funnel when visibility is provided', async () => {
    mockFetch(PAYLOAD_VIS_ON);
    render(<OperationsDashboardPage />);
    expect(await screen.findByTestId('operations-visibility-card')).toBeInTheDocument();
    expect(screen.getByText('78.6%')).toBeInTheDocument();       // approval rate
    expect(screen.getByText('of addressable outlets')).toBeInTheDocument();
  });

  it('RD5: on fetch failure shows an error state and NO fabricated numbers', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    render(<OperationsDashboardPage />);

    expect(await screen.findByTestId('operations-dashboard-error')).toBeInTheDocument();
    // none of the real payload literals leak into the error state
    expect(screen.queryByText('84.0%')).not.toBeInTheDocument();
    expect(screen.queryByText('168 / 200 transactions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('operations-visibility-card')).not.toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
