/// <reference types="vitest/globals" />
/**
 * TDD — Leaderboard ranks by absolute primary-KPI value, not achievement %
 *
 * Each outlet has a primary KPI (marked isPrimary in their target config).
 * The leaderboard ranks outlets by the ABSOLUTE value achieved for that KPI
 * in the current period — not by (achieved / target) * 100.
 *
 * Rationale: comparing achievement % would favour outlets with easy targets.
 * Absolute volume creates a fair ranking on actual business output.
 *
 * V1: Each row shows a primaryKpiLabel (the name of the KPI being ranked on)
 * V2: Rows are sorted by primaryKpiValue descending (highest value = rank 1)
 * V3: "My rank" card shows my primaryKpiValue and primaryKpiLabel
 * V4: Each row has data-testid="lb-kpi-value" showing the numeric value
 * V5: The label under the value says the KPI name, NOT just "pts"
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

// Leaderboard is opt-in per tenant; these tests always render with showLeaderboard=true
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

describe('V — Leaderboard: absolute primary-KPI ranking', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('V1: each row shows a primaryKpiLabel', () => {
    render(<LeaderboardPage />);
    const labels = screen.getAllByTestId('lb-kpi-label');
    expect(labels.length).toBeGreaterThan(0);
    // Each label should contain a non-empty string
    labels.forEach((el) => expect(el.textContent?.trim().length).toBeGreaterThan(0));
  });

  it('V2: rows are sorted by primaryKpiValue descending (rank 1 has highest value)', () => {
    render(<LeaderboardPage />);
    const values = screen
      .getAllByTestId('lb-kpi-value')
      .map((el) => Number(el.textContent?.replace(/[^0-9]/g, '')));
    // Each value should be ≥ the next
    for (let i = 0; i < values.length - 1; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i + 1]);
    }
  });

  it('V3: my-rank card shows my primaryKpiValue', () => {
    render(<LeaderboardPage />);
    // "My rank" card is the gradient hero — it shows my value
    const myCard = screen.getByTestId('lb-my-rank-card');
    expect(myCard).toBeInTheDocument();
    expect(within(myCard).getByTestId('lb-kpi-value')).toBeInTheDocument();
  });

  it('V4: every leaderboard row has a lb-kpi-value testid', () => {
    render(<LeaderboardPage />);
    const rows  = screen.getAllByTestId('lb-row');
    const kpis  = screen.getAllByTestId('lb-kpi-value');
    // At minimum the full list rows should each have one
    expect(kpis.length).toBeGreaterThanOrEqual(rows.length);
  });

  it('V5: the KPI label shown is not just "pts" — it reflects the actual KPI name', () => {
    render(<LeaderboardPage />);
    const labels = screen.getAllByTestId('lb-kpi-label');
    // None of them should say just "pts" (that was the old behaviour)
    labels.forEach((el) => {
      expect(el.textContent?.toLowerCase().trim()).not.toBe('pts');
    });
  });
});
