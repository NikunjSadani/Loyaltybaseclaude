/// <reference types="vitest/globals" />
/**
 * GO — Partner Group Overview page (Wave 3, READ-ONLY)
 *
 * The page renders a consolidated, read-only wallet roll-up for a login that is the
 * group PARENT. It fetches GET /api/partner/group/wallet (envelope { success, data })
 * where data is either { available: false } or the full roll-up.
 *
 * GO1: available:true → parent header + consolidated totals render
 * GO2: available:true → ₹ equivalent of redeemable (points ÷ conversionRate) shown
 * GO3: available:true → a per-outlet row renders for each outlet (code, points)
 * GO4: available:true → read-only badge + helper note present; NO redeem/payout control
 * GO5: available:false → friendly empty state (no crash), link back to dashboard
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

// next/link → plain anchor for jsdom.
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import GroupOverviewPage from '../page';

/** Full available:true roll-up. conversionRate 2 → ₹ = points ÷ 2. */
const AVAILABLE_PAYLOAD = {
  available: true,
  parent: { businessName: 'Sunrise Group', ownerName: 'Meera Shah' },
  totals: {
    redeemablePoints: 20_000,
    earnedPoints:     50_000,
    redeemedPoints:   8_000,
    expiredPoints:    500,
    lockedPoints:     1_000,
    lifetimeEarned:   58_500,
    lifetimeRedeemed: 8_000,
  },
  conversionRate: 2,
  outlets: [
    {
      outletCode: 'OUT-001', businessName: 'Sunrise Central', ownerName: 'Meera Shah',
      isActive: true, redeemablePoints: 12_000, earnedPoints: 30_000,
      redeemedPoints: 5_000, expiredPoints: 200, lockedPoints: 600,
    },
    {
      outletCode: 'OUT-002', businessName: 'Sunrise North', ownerName: 'Anil Shah',
      isActive: false, redeemablePoints: 8_000, earnedPoints: 20_000,
      redeemedPoints: 3_000, expiredPoints: 300, lockedPoints: 400,
    },
  ],
};

/** Per-endpoint payloads. Wallet is required (gates the shell); the three new
    sections default to "hidden" unless a test overrides them, so the pre-existing
    wallet tests keep asserting exactly the wallet slice. */
interface RouteOverrides {
  targets?:     unknown;
  visibility?:  unknown;
  leaderboard?: unknown;
}

function stubFetch(wallet: unknown, opts: RouteOverrides = {}) {
  const routes: Record<string, unknown> = {
    '/api/partner/group/wallet':      wallet,
    '/api/partner/group/targets':     opts.targets     ?? { available: false },
    '/api/partner/group/visibility':  opts.visibility  ?? { available: true, visibilityEnabled: false },
    '/api/partner/group/leaderboard': opts.leaderboard ?? { available: false },
  };
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, data: key ? routes[key] : { available: false } }),
    });
  }));
}

/* ─── Section payload fixtures ──────────────────────────────────────────────── */

const TARGETS_PAYLOAD = {
  available: true,
  parent: { businessName: 'Sunrise Group', ownerName: 'Meera Shah' },
  period: '2026-07',
  kpiTotals: [
    { code: 'VOL', name: 'Volume', target: 1000, achieved: 850, pace: 0.85, unit: 'cases', isPrimary: true },
    { code: 'NEW', name: 'New Outlets', target: 20, achieved: null, pace: null, unit: '', isPrimary: false },
  ],
  outlets: [
    {
      outletCode: 'OUT-001', outletName: 'Sunrise Central', outletType: 'RETAIL',
      kpis: [{ code: 'VOL', name: 'Volume', target: 600, achieved: 540, pace: 0.9, unit: 'cases', isPrimary: true }],
    },
    {
      outletCode: 'OUT-002', outletName: 'Sunrise North', outletType: 'RETAIL',
      kpis: [{ code: 'VOL', name: 'Volume', target: 400, achieved: 310, pace: 0.775, unit: 'cases', isPrimary: true }],
    },
  ],
};

const VISIBILITY_ON_PAYLOAD = {
  available: true,
  visibilityEnabled: true,
  month: '2026-07',
  counts: { total: 2, approved: 1, underReview: 1, pending: 0, noRecord: 0 },
  outlets: [
    { outletCode: 'OUT-001', outletName: 'Sunrise Central', status: 'APPROVED', dateOfCapture: '2026-07-10', approvedBy: 'ISR-1' },
    { outletCode: 'OUT-002', outletName: 'Sunrise North', status: 'UNDER_REVIEW', dateOfCapture: '2026-07-12', approvedBy: null },
  ],
};

const LEADERBOARD_PAYLOAD = {
  available: true,
  parent: { businessName: 'Sunrise Group', ownerName: 'Meera Shah' },
  snapshot: { snapshotDate: '2026-07-15', periodStartDate: '2026-07-01', periodEndDate: '2026-07-31' },
  entries: [
    { rank: 3, partnerId: 'p1', partnerName: 'Sunrise Central', score: 8500, rankChange: 2 },
    { rank: 7, partnerId: 'p2', partnerName: 'Sunrise North', score: 5200, rankChange: -1 },
  ],
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('GO — Partner Group Overview (read-only)', () => {
  it('GO1: available:true renders the parent header + consolidated totals', async () => {
    stubFetch(AVAILABLE_PAYLOAD);
    render(<GroupOverviewPage />);

    expect(await screen.findByText(/Group Overview — Sunrise Group/)).toBeInTheDocument();
    // Consolidated redeemable total (20,000 pts).
    const card = await screen.findByTestId('group-totals-card');
    expect(card).toHaveTextContent('20,000');
    // Lifetime figures rolled up.
    expect(card).toHaveTextContent('58,500');
  });

  it('GO2: shows the ₹ equivalent of redeemable using conversionRate (points ÷ rate)', async () => {
    stubFetch(AVAILABLE_PAYLOAD);
    render(<GroupOverviewPage />);

    // 20,000 pts ÷ rate 2 = ₹10,000.
    await waitFor(() =>
      expect(screen.getByTestId('group-redeemable-inr')).toHaveTextContent('₹10,000'),
    );
  });

  it('audit item 2 / owner decision 2 (2026-11-19): a child in debt — owed shown apart from the group total, its row negative with no ₹', async () => {
    stubFetch({
      ...AVAILABLE_PAYLOAD,
      totals: { ...AVAILABLE_PAYLOAD.totals, redeemablePoints: 12_000, owedPoints: 2_986 },
      outlets: [AVAILABLE_PAYLOAD.outlets[0], { ...AVAILABLE_PAYLOAD.outlets[1], redeemablePoints: -2_986 }],
    });
    render(<GroupOverviewPage />);
    expect((await screen.findByTestId('group-owed-points')).textContent).toBe(
      'Wallets in this group owe 2,986 pts — repaid from their next earnings (not counted above).',
    );
    expect(screen.getByTestId('group-outlet-negative').textContent).toBe('Owed — repaid from next earnings');
    const rows = screen.getAllByTestId('group-outlet-row');
    expect(rows[1].textContent).toContain('−2,986');
    expect(rows[1].textContent).not.toMatch(/₹/);
  });

  it('GO3: renders a per-outlet row for every outlet with code + points', async () => {
    stubFetch(AVAILABLE_PAYLOAD);
    render(<GroupOverviewPage />);

    await waitFor(() =>
      expect(screen.getAllByTestId('group-outlet-row')).toHaveLength(2),
    );
    expect(await screen.findByText('Sunrise Central')).toBeInTheDocument();
    expect(await screen.findByText('Sunrise North')).toBeInTheDocument();
    expect(await screen.findByText(/OUT-001/)).toBeInTheDocument();
    // Inactive outlet flagged.
    expect(await screen.findByText('Inactive')).toBeInTheDocument();
  });

  it('GO4: read-only badge + helper note present, and NO redeem/payout controls', async () => {
    stubFetch(AVAILABLE_PAYLOAD);
    render(<GroupOverviewPage />);

    expect(await screen.findByTestId('read-only-badge')).toBeInTheDocument();
    expect(await screen.findByText(/happen per outlet/i)).toBeInTheDocument();
    // Never any action controls on this read-only view.
    expect(screen.queryByRole('button', { name: /redeem/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /payout|withdraw/i })).not.toBeInTheDocument();
  });

  it('GO5: available:false renders the friendly empty state with a dashboard link', async () => {
    stubFetch({ available: false });
    render(<GroupOverviewPage />);

    expect(await screen.findByTestId('group-empty-state')).toBeInTheDocument();
    expect(await screen.findByText(/No group overview available/i)).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /back to dashboard/i });
    expect(link).toHaveAttribute('href', '/partner/dashboard');
    // No totals card / outlet rows when there's no group.
    expect(screen.queryByTestId('group-totals-card')).not.toBeInTheDocument();
  });
});

/* ─── Targets section ───────────────────────────────────────────────────────── */

describe('GO Targets — consolidated group KPI roll-up (read-only)', () => {
  it('renders the group KPI totals + a per-outlet target row for each outlet', async () => {
    stubFetch(AVAILABLE_PAYLOAD, { targets: TARGETS_PAYLOAD });
    render(<GroupOverviewPage />);

    expect(await screen.findByTestId('group-targets-section')).toBeInTheDocument();
    // One group total chip per KPI.
    expect(await screen.findAllByTestId('group-kpi-total')).toHaveLength(2);
    const section = await screen.findByTestId('group-targets-section');
    // Primary KPI's group pace (0.85 → 85%) + achieved/target rendered.
    expect(section).toHaveTextContent('85%');
    expect(section).toHaveTextContent('850');
    // A row per outlet.
    expect(await screen.findAllByTestId('group-target-outlet-row')).toHaveLength(2);
    // A null-pace KPI degrades to a dash rather than crashing.
    expect(section).toHaveTextContent('—');
  });

  it('hides the targets section entirely when available:false', async () => {
    stubFetch(AVAILABLE_PAYLOAD, { targets: { available: false } });
    render(<GroupOverviewPage />);

    expect(await screen.findByTestId('group-totals-card')).toBeInTheDocument();
    expect(screen.queryByTestId('group-targets-section')).not.toBeInTheDocument();
  });
});

/* ─── Visibility section ────────────────────────────────────────────────────── */

describe('GO Visibility — per-outlet capture status (read-only, flag-gated)', () => {
  it('hides the visibility section when visibilityEnabled is false', async () => {
    stubFetch(AVAILABLE_PAYLOAD, { visibility: { available: true, visibilityEnabled: false } });
    render(<GroupOverviewPage />);

    expect(await screen.findByTestId('group-totals-card')).toBeInTheDocument();
    expect(screen.queryByTestId('group-visibility-section')).not.toBeInTheDocument();
  });

  it('renders the counts summary + a status row per outlet when visibilityEnabled', async () => {
    stubFetch(AVAILABLE_PAYLOAD, { visibility: VISIBILITY_ON_PAYLOAD });
    render(<GroupOverviewPage />);

    expect(await screen.findByTestId('group-visibility-section')).toBeInTheDocument();
    expect(await screen.findAllByTestId('group-visibility-row')).toHaveLength(2);
    const section = await screen.findByTestId('group-visibility-section');
    expect(section).toHaveTextContent('Approved');
    expect(section).toHaveTextContent('Under review');
  });

  // PHOTO_APPROVAL tenants (Bajaj): the API reads VisibilityCapture for the current window and
  // the page shows the shared plain status words — never "No record" for every shop.
  it('PHOTO_APPROVAL: shows the current window + plain status words per outlet', async () => {
    stubFetch(AVAILABLE_PAYLOAD, {
      visibility: {
        available: true,
        visibilityEnabled: true,
        mode: 'PHOTO_APPROVAL',
        windowKey: '2026-11-P1',
        window: { startDay: 1, endDay: 30 },
        counts: { total: 4, approved: 1, waiting: 1, needsRetake: 1, rejected: 0, notCaptured: 1, notInScope: 1 },
        outlets: [
          { outletCode: 'OUT-001', outletName: 'Sunrise Central', inScope: true, status: 'APPROVED', capturedAt: '2026-11-03', reviewedAt: '2026-11-04', version: 1 },
          { outletCode: 'OUT-002', outletName: 'Sunrise North', inScope: true, status: 'SUBMITTED', capturedAt: '2026-11-05', reviewedAt: null, version: 1 },
          { outletCode: 'OUT-003', outletName: 'Sunrise East', inScope: true, status: 'CHANGES_REQUESTED', capturedAt: '2026-11-05', reviewedAt: '2026-11-06', version: 2 },
          { outletCode: 'OUT-004', outletName: 'Sunrise West', inScope: true, status: null, capturedAt: null, reviewedAt: null, version: null },
          { outletCode: 'OUT-005', outletName: 'Sunrise Depot', inScope: false, status: null, capturedAt: null, reviewedAt: null, version: null },
        ],
      },
    });
    render(<GroupOverviewPage />);

    const section = await screen.findByTestId('group-visibility-section');
    const rows = await within(section).findAllByTestId('group-visibility-row');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Approved');
    expect(rows[1]).toHaveTextContent('Waiting for review');
    expect(rows[2]).toHaveTextContent('Needs re-take');
    expect(rows[3]).toHaveTextContent('Not captured yet');
    expect(rows[4]).toHaveTextContent('Not part of visibility');
    expect(section).toHaveTextContent('1–30 Nov');
    expect(section).not.toHaveTextContent('No record');
  });
});

/* ─── Leaderboard section ───────────────────────────────────────────────────── */

describe('GO Leaderboard — group shops with tenant-wide rank (read-only)', () => {
  it('renders a ranked row for each of the group’s shops', async () => {
    stubFetch(AVAILABLE_PAYLOAD, { leaderboard: LEADERBOARD_PAYLOAD });
    render(<GroupOverviewPage />);

    expect(await screen.findByTestId('group-leaderboard-section')).toBeInTheDocument();
    expect(await screen.findAllByTestId('group-leaderboard-row')).toHaveLength(2);
    const section = await screen.findByTestId('group-leaderboard-section');
    expect(section).toHaveTextContent('#3');
    expect(section).toHaveTextContent('Sunrise Central');
    expect(section).toHaveTextContent('8,500');
    // No published-yet empty state when there are entries.
    expect(screen.queryByTestId('group-leaderboard-empty')).not.toBeInTheDocument();
  });

  it('shows the friendly empty state (not hidden) when snapshot is null', async () => {
    stubFetch(AVAILABLE_PAYLOAD, {
      leaderboard: { available: true, parent: { businessName: 'Sunrise Group', ownerName: 'Meera Shah' }, snapshot: null, entries: [] },
    });
    render(<GroupOverviewPage />);

    expect(await screen.findByTestId('group-leaderboard-section')).toBeInTheDocument();
    expect(await screen.findByTestId('group-leaderboard-empty')).toBeInTheDocument();
    expect(await screen.findByText(/no published leaderboard yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('group-leaderboard-row')).not.toBeInTheDocument();
  });

  it('hides the leaderboard section entirely when available:false', async () => {
    stubFetch(AVAILABLE_PAYLOAD, { leaderboard: { available: false } });
    render(<GroupOverviewPage />);

    expect(await screen.findByTestId('group-totals-card')).toBeInTheDocument();
    expect(screen.queryByTestId('group-leaderboard-section')).not.toBeInTheDocument();
  });
});
