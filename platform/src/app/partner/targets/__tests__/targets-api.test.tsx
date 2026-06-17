/// <reference types="vitest/globals" />
/**
 * PT — Partner Targets page API wiring (rewired to new backend shape).
 *
 * Backend endpoint: GET /api/partner/targets?period=YYYY-MM
 * Response shape:   { success: true, data: { period, outlets: [{
 *                     outletCode, outletName, outletType,
 *                     kpis: [{ code, target, achieved, pace }]
 *                   }] } }
 *
 * PT1: page heading visible after load (empty state, no outlets)
 * PT2: fetch IS called to /api/partner/targets
 * PT3: graceful fallback when fetch fails — empty state shown (no crash)
 * PT4: when API returns outlet KPI data, achievement % shown correctly
 * PT5: multi-outlet data renders outlet breakdown table
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href, children, ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@/lib/partner-session', () => ({
  usePartnerSession: () => ({
    outletId: 'OUT-001', outletType: 'WHOLESALER', firmName: 'Kumar General Store',
    partnerName: 'Rajesh Kumar', tier: 'Gold', mobile: '9876543210',
    track: 'POINTS',
    pointsBalance: 4250, pointsLifetime: 8550,
    leaderboardRank: 12, leaderboardTotal: 248,
    inrEarnedThisCycle: 0, pendingPayoutInr: 0,
  }),
  OUTLET_TYPE_LABELS: { SSS: 'SSS', WHOLESALER: 'Wholesaler', SUB_STOCKIST: 'Sub-Stockist', SSS_TOT: 'SSS TOT' },
  OUTLET_TYPE_COLORS: {
    WHOLESALER:   { bg: 'bg-amber-100',   text: 'text-amber-700'  },
    SSS:          { bg: 'bg-blue-100',    text: 'text-blue-700'   },
    SUB_STOCKIST: { bg: 'bg-purple-100',  text: 'text-purple-700' },
    SSS_TOT:      { bg: 'bg-emerald-100', text: 'text-emerald-700'},
  },
}));

import PartnerTargetsPage from '../page';

// ─── Shared mock response factory ────────────────────────────────────────────

function makeTargetsResponse(outlets: Array<{
  outletCode:  string;
  outletName:  string;
  outletType:  string;
  kpis: Array<{ code: string; target: number | null; achieved: number | null; pace: number | null }>;
}> = []) {
  return {
    success: true,
    data: {
      period:  '2026-06',
      outlets,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PT — Partner Targets page API wiring (new shape)', () => {

  it('PT1: page heading visible after load resolves with empty outlet list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve(makeTargetsResponse([])),
    }));

    render(<PartnerTargetsPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    expect(screen.getByText('My Targets')).toBeInTheDocument();
  });

  it('PT2: fetch IS called to /api/partner/targets', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mockFetch = vi.fn().mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve(makeTargetsResponse([])),
    });
    vi.stubGlobal('fetch', mockFetch);

    render(<PartnerTargetsPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/partner/targets'),
      expect.any(Object),
    );
  });

  it('PT3: graceful fallback — empty state shown when fetch fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    render(<PartnerTargetsPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // Page heading should still be visible (no crash)
    expect(screen.getByText('My Targets')).toBeInTheDocument();
  });

  it('PT4: API returns outlet KPI data — achievement % is rendered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Outlet: MONTH_TGT — target=800, achieved=800 → 100%
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve(makeTargetsResponse([
        {
          outletCode: 'OUT-001',
          outletName: 'Kumar General Store',
          outletType: 'WHOLESALER',
          kpis: [
            { code: 'MONTH_TGT', target: 800, achieved: 800, pace: 1 },
          ],
        },
      ])),
    }));

    render(<PartnerTargetsPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // Should show 100% somewhere (in the progress badges or score card)
    const badges = screen.getAllByText('100%');
    expect(badges.length).toBeGreaterThan(0);
  });

  it('PT5: multi-outlet data — outlet breakdown table rendered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve(makeTargetsResponse([
        {
          outletCode: 'OUT-001',
          outletName: 'Kumar General Store',
          outletType: 'WHOLESALER',
          kpis: [{ code: 'MONTH_TGT', target: 400, achieved: 200, pace: 0.5 }],
        },
        {
          outletCode: 'OUT-002',
          outletName: 'Singh Traders',
          outletType: 'WHOLESALER',
          kpis: [{ code: 'MONTH_TGT', target: 400, achieved: 300, pace: 0.75 }],
        },
      ])),
    }));

    render(<PartnerTargetsPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // Outlet breakdown table shows both outlet names
    expect(screen.getByText('Kumar General Store')).toBeInTheDocument();
    expect(screen.getByText('Singh Traders')).toBeInTheDocument();
  });
});
