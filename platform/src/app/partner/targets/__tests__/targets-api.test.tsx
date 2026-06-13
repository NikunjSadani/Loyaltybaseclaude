/// <reference types="vitest/globals" />
/**
 * PT — Partner Targets page API wiring
 *
 * PT1: mock data shown immediately after loading resolves (no fetch needed)
 * PT2: fetch IS called to /api/partner/targets
 * PT3: graceful fallback when fetch fails — mock data still shown
 * PT4: primary param achievement updates when API returns real achievedValue
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href, children, ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@/lib/partner-session', () => ({
  usePartnerSession: () => ({
    outletId: 'o1', outletType: 'WHOLESALER', firmName: 'Kumar General Store',
    partnerName: 'Rajesh Kumar', tier: 'Gold', mobile: '9876543210',
    track: 'POINTS',
    pointsBalance: 4250, pointsLifetime: 8550,
    leaderboardRank: 12, leaderboardTotal: 248,
    inrEarnedThisCycle: 0, pendingPayoutInr: 0,
  }),
  OUTLET_TYPE_LABELS: { SSS: 'SSS', WHOLESALER: 'Wholesaler', SUB_STOCKIST: 'Sub-Stockist', SSS_TOT: 'SSS TOT' },
  OUTLET_TYPE_COLORS: {
    WHOLESALER: { bg: 'bg-amber-100', text: 'text-amber-700' },
    SSS: { bg: 'bg-blue-100', text: 'text-blue-700' },
    SUB_STOCKIST: { bg: 'bg-purple-100', text: 'text-purple-700' },
    SSS_TOT: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  },
}));

import PartnerTargetsPage from '../page';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PT — Partner Targets page API wiring', () => {

  it('PT1: mock data shown after initial load resolves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}), // never resolves
    }));

    render(<PartnerTargetsPage />);
    // Advance past the 350ms setTimeout that resolves config
    await act(async () => { vi.advanceTimersByTime(500); });

    // Should show the page heading
    expect(screen.getByText('My Targets')).toBeInTheDocument();
  });

  it('PT2: fetch IS called to /api/partner/targets after load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { targets: [] } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    render(<PartnerTargetsPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    // Allow any pending promises to settle
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/partner/targets'),
    );
  });

  it('PT3: graceful fallback — mock data shown when fetch fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    render(<PartnerTargetsPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    // Should still show the page heading — no crash
    expect(screen.getByText('My Targets')).toBeInTheDocument();
  });

  it('PT4: when API returns achievedValue for primary KPI, achievement % updates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // DEMO achievement for o1 (WHOLESALER): p_sv=610, beat target=800 → 76%
    // API returns achievedValue=800 → 100% (target met)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: {
          targets: [
            {
              id: 'st1',
              schemeId: 's1',
              schemeName: 'Monthly Volume Scheme',
              period: '2026-05',
              targetValue: 800,
              achievedValue: 800,
              percentage: 100,
              status: 'ACTIVE',
            },
          ],
        },
      }),
    }));

    render(<PartnerTargetsPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // After API update: primary KPI achievement should show 100% (badge or progress label)
    const badges = screen.getAllByText('100%');
    expect(badges.length).toBeGreaterThan(0);
  });
});
