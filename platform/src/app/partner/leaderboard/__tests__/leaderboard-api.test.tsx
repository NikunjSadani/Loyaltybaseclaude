/// <reference types="vitest/globals" />
/**
 * LB — Partner Leaderboard page API wiring
 *
 * LB1: renders initial mock data synchronously (before fetch resolves)
 * LB2: renders API partner name after fetch resolves
 * LB3: keeps showing data when fetch fails (graceful fallback)
 * LB4: fetch is called with /api/leaderboard
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Leaderboard is opt-in per tenant; these API tests always render with showLeaderboard=true
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({
    features: {
      walletModule: true,
      partnerApp: {
        showSchemes: true, showInvoices: true, showWallet: true,
        showTeam: true, showLeaderboard: true,
      },
    },
    branding: { displayName: 'Test', primaryColor: '#16a34a' },
  }),
  ClientConfigProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useFeatureFlag: () => true,
}));

import LeaderboardPage from '../page';

afterEach(() => { vi.unstubAllGlobals(); });

describe('LB — Leaderboard API wiring', () => {
  it('LB1: renders initial mock data synchronously (kpi labels present immediately)', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<LeaderboardPage />);
    // Initial state is ALL_PARTNERS — kpi labels render before fetch resolves
    const labels = screen.getAllByTestId('lb-kpi-label');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('LB2: renders API partner name after fetch resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            leaderboard: [
              { rank: 1, partnerId: 'p1', partnerName: 'API Partner One', score: 99999, rankChange: 1 },
              { rank: 2, partnerId: 'p2', partnerName: 'API Partner Two',  score: 88888, rankChange: 0 },
            ],
            pagination: { page: 1, limit: 50, total: 2, pages: 1 },
          },
        }),
    }));
    render(<LeaderboardPage />);
    // API data should appear once fetch resolves (may appear in podium + list)
    const matches = await screen.findAllByText('API Partner One');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('LB3: keeps showing data when fetch fails (graceful fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<LeaderboardPage />);
    // Still shows initial data (no crash, no error thrown)
    const labels = screen.getAllByTestId('lb-kpi-label');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('LB4: fetch is called with /api/leaderboard endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { leaderboard: [], pagination: { page: 1, limit: 50, total: 0, pages: 0 } } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    render(<LeaderboardPage />);
    // Wait for fetch to have been called
    await new Promise(r => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/leaderboard'));
  });
});
