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
 *  - RD6: PHOTO_APPROVAL month-wise funnel — waiting / needs re-take, approval-rate definition, real flags list,
 *         month picker refetches the visibility block only
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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
    expect(await screen.findByText('168 / 200 transactions')).toBeInTheDocument();
  });

  it('RD2: renders MTTR and shows "—" for the null first-response metric', async () => {
    mockFetch(PAYLOAD_VIS_NULL);
    render(<OperationsDashboardPage />);
    expect(await screen.findByText('18.4h')).toBeInTheDocument();
    // first-response is null → the card under "First Response" shows an em-dash
    expect(await screen.findByText('avg time to first reply')).toBeInTheDocument();
    expect((await screen.findAllByText('—')).length).toBeGreaterThan(0);
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
    expect(await screen.findByText('78.6%')).toBeInTheDocument();       // approval rate
    expect(await screen.findByText('of addressable outlets')).toBeInTheDocument();
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

  describe('RD6: PHOTO_APPROVAL month-wise funnel', () => {
    const PHOTO = {
      enabled: true, mode: 'PHOTO_APPROVAL', month: '2026-10',
      submitted: 40, approved: 20, waiting: 10, waitingAllMonths: 13, waitingEarlierMonths: 3,
      needsRetake: 6, rejected: 4, closedNotApproved: 0,
      approvalRatePct: 66.7, flagged: 3, duplicate: 2, outsideFence: 1, fraudFlagPct: 7.5, flagDetailsAvailable: true,
      importedMonth: false,
      participatingOutlets: 40, inScopeOutlets: 50, participationPct: 80 as number | null,
    };
    const FLAGS = {
      month: '2026-10', flagged: 3,
      rows: [
        { captureId: 'c1', outletCode: 'A1', outletName: 'One', windowKey: '2026-10-P1', status: 'APPROVED',
          reasons: ['DUPLICATE_PHOTO'], duplicateOf: [{ outletCode: 'Z9', windowKey: '2026-08-P1' }], outsidePhotos: [] },
        { captureId: 'c2', outletCode: 'A2', outletName: 'Two', windowKey: '2026-10-P1', status: 'WAITING',
          reasons: ['OUTSIDE_FENCE'], duplicateOf: [], outsidePhotos: ['Window 1'] },
      ],
      pagination: { page: 1, pageSize: 50, total: 2, pages: 1 },
    };
    function routeFetch() {
      const fn = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith('/api/admin/dashboard/operations/visibility/flags')) return { ok: true, json: async () => ({ success: true, data: FLAGS }) };
        if (u.startsWith('/api/admin/dashboard/operations/visibility')) {
          return { ok: true, json: async () => ({ success: true, data: { visibility: { ...PHOTO, month: '2026-09', submitted: 5 } } }) };
        }
        return { ok: true, json: async () => ({ ...BASE_PAYLOAD, visibility: PHOTO }) };
      });
      vi.stubGlobal('fetch', fn);
      return fn;
    }

    it('shows waiting and needs re-take separately, the approval-rate definition, and the real flag counts', async () => {
      routeFetch();
      render(<OperationsDashboardPage />);
      const card = await screen.findByTestId('operations-visibility-card');
      expect(within(card).getByText('Waiting for review')).toBeInTheDocument();
      expect(within(card).getByText('Needs re-take')).toBeInTheDocument();
      expect(within(card).getByText('66.7%')).toBeInTheDocument();
      expect(within(card).getByText('20 approved of 30 reviewed')).toBeInTheDocument();
      // The definition is a keyboard / touch toggletip (not a hover-only title).
      fireEvent.click(within(card).getByRole('button', { name: 'About Approval Rate' }));
      expect(within(card).getByText(/Approved ÷ every capture a reviewer has decided this month/)).toBeInTheDocument();
      // Gifsy's whole queue, not only this month.
      expect(within(card).getByTestId('operations-visibility-waiting-all')).toHaveTextContent(
        '13 captures are waiting for review across all months — 3 from months before Oct 2026.',
      );
      expect(within(card).getByText('3 flagged · 2 duplicate · 1 outside fence')).toBeInTheDocument();
      expect(within(card).getByText('40 of 50 in-scope outlets')).toBeInTheDocument();
    });

    it('the flags list shows the reason per capture', async () => {
      routeFetch();
      render(<OperationsDashboardPage />);
      const card = await screen.findByTestId('operations-visibility-card');
      fireEvent.click(within(card).getByRole('button', { name: /see the 3 flagged captures/i }));
      const list = await screen.findByTestId('operations-visibility-flags');
      expect(await within(list).findByText('Duplicate photo')).toBeInTheDocument();
      expect(within(list).getByText(/same photo as Z9 \(Aug 2026\)/)).toBeInTheDocument();
      expect(within(list).getByText('Photo outside the outlet fence')).toBeInTheDocument();
      expect(within(list).getByText(/— Window 1/)).toBeInTheDocument();
    });

    it('client roles (flagDetailsAvailable false): counts only, no outlet list button, no flags request', async () => {
      const fn = vi.fn(async () => ({ ok: true, json: async () => ({ ...BASE_PAYLOAD, visibility: { ...PHOTO, flagDetailsAvailable: false } }) }));
      vi.stubGlobal('fetch', fn);
      render(<OperationsDashboardPage />);
      const card = await screen.findByTestId('operations-visibility-card');
      expect(within(card).getByTestId('operations-visibility-flags-gifsy-only')).toHaveTextContent(
        '3 flagged captures this month. The outlet-level list is available to Gifsy only.',
      );
      expect(within(card).queryByRole('button', { name: /see the 3 flagged captures/i })).not.toBeInTheDocument();
      expect(fn.mock.calls.map((c) => String((c as unknown[])[0])).some((u) => u.includes('/flags'))).toBe(false);
    });

    it('imported month: participation is "Not tracked" with the reason (never divided by the current outlets)', async () => {
      const note = 'Not tracked for imported months — the old app only kept approved visits, so coverage and Missed cannot be worked out.';
      const fn = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...BASE_PAYLOAD, visibility: { ...PHOTO, importedMonth: true, importedMonthNote: note, participationPct: null } }),
      }));
      vi.stubGlobal('fetch', fn);
      render(<OperationsDashboardPage />);
      const card = await screen.findByTestId('operations-visibility-card');
      expect(within(card).getByText('Not tracked')).toBeInTheDocument();
      expect(within(card).getByTestId('operations-visibility-imported')).toHaveTextContent(note);
    });

    it('picking a month refetches only the visibility block for that month', async () => {
      const fn = routeFetch();
      render(<OperationsDashboardPage />);
      await screen.findByTestId('operations-visibility-card');
      const select = screen.getByLabelText('Visibility funnel month') as HTMLSelectElement;
      const other = Array.from(select.options).map((o) => o.value).find((v) => v !== '2026-10')!;
      fireEvent.change(select, { target: { value: other } });
      await waitFor(() =>
        expect(fn.mock.calls.map((c) => String(c[0]))).toContain(`/api/admin/dashboard/operations/visibility?month=${other}`),
      );
      expect(await screen.findByText('Sep 2026 · captures for in-scope outlets: review funnel, fraud flags & outlet participation', { exact: false })).toBeInTheDocument();
    });

    it('AMOUNT_UPLOAD (no mode) keeps the old card', async () => {
      mockFetch(PAYLOAD_VIS_ON);
      render(<OperationsDashboardPage />);
      expect(await screen.findByText('of addressable outlets')).toBeInTheDocument();
      expect(screen.queryByLabelText('Visibility funnel month')).not.toBeInTheDocument();
    });
  });
});
