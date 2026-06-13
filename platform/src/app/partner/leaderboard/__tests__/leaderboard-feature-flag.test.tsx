/// <reference types="vitest/globals" />
/**
 * PLF — Leaderboard feature-flag gate (multi-tenant)
 *
 * PLF1: when showLeaderboard=false (Deoleo), page renders "not available" — no leaderboard content
 * PLF2: when showLeaderboard=true, page renders leaderboard content normally
 * PLF3: fetch is NOT called when showLeaderboard=false (no wasted API call)
 * PLF4: fetch IS called when showLeaderboard=true
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import { useClientConfig } from '@/lib/platform/client-config-context';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: vi.fn(),
  ClientConfigProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useFeatureFlag: vi.fn(),
}));

import LeaderboardPage from '../page';

/** Minimal ClientConfig stub — only the fields the page actually reads */
function makeConfig(showLeaderboard: boolean) {
  return {
    features: {
      walletModule: true,
      partnerApp: {
        showSchemes: true,
        showInvoices: true,
        showWallet: true,
        showTeam: true,
        showLeaderboard,
      },
    },
    branding: { displayName: 'Test Client', primaryColor: '#16a34a' },
  };
}

beforeEach(() => {
  vi.mocked(useClientConfig).mockReturnValue(makeConfig(true) as ReturnType<typeof useClientConfig>);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => new Promise(() => {}), // never resolves — prevents async state updates
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PLF — Leaderboard feature-flag gate', () => {

  it('PLF1: when showLeaderboard=false, page shows "not available" — no leaderboard rendered', () => {
    vi.mocked(useClientConfig).mockReturnValue(makeConfig(false) as ReturnType<typeof useClientConfig>);
    render(<LeaderboardPage />);
    // Must show a "not available" / "feature disabled" message
    expect(screen.getByText(/not available/i)).toBeInTheDocument();
    // Must NOT render leaderboard rankings content (kpi labels / scores)
    expect(screen.queryByTestId('lb-kpi-label')).not.toBeInTheDocument();
    // Rankings list heading must not appear
    expect(screen.queryByText(/all rankings/i)).not.toBeInTheDocument();
  });

  it('PLF2: when showLeaderboard=true, page renders leaderboard content normally', () => {
    vi.mocked(useClientConfig).mockReturnValue(makeConfig(true) as ReturnType<typeof useClientConfig>);
    render(<LeaderboardPage />);
    // Leaderboard content should render — at minimum the kpi labels from mock data
    const labels = screen.getAllByTestId('lb-kpi-label');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('PLF3: fetch is NOT called when showLeaderboard=false (no wasted API call)', () => {
    vi.mocked(useClientConfig).mockReturnValue(makeConfig(false) as ReturnType<typeof useClientConfig>);
    const mockFetch = vi.mocked(global.fetch);
    render(<LeaderboardPage />);
    // fetch should not have been triggered — page bails out before useEffect runs
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('PLF4: fetch IS called when showLeaderboard=true', async () => {
    vi.mocked(useClientConfig).mockReturnValue(makeConfig(true) as ReturnType<typeof useClientConfig>);
    const mockFetch = vi.mocked(global.fetch);
    render(<LeaderboardPage />);
    await new Promise(r => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/leaderboard'));
  });
});
