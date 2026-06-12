/**
 * TDD — Performance chart header copy (sales team dashboard)
 *
 * Z3: heading reads "Target vs. Achievement" (not "Sales vs Target")
 * Z4: the sub-line "Target vs Achieved" is NOT present
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/components/charts/sales-achievement-chart', () => ({
  SalesAchievementChart: () => <div data-testid="sales-achievement-chart" />,
}));
vi.mock('@/lib/task-config', () => ({
  fetchTaskConfig: () => Promise.resolve(null),
}));
vi.mock('@/lib/banner', () => ({
  fetchBanners:         () => Promise.resolve({ banners: [] }),
  getActiveSalesBanners: () => [],
  getBgStyle:           () => ({}),
  getActivePopup:       () => null,
  shouldShowPopup:      () => false,
  markPopupSeen:        () => undefined,
}));

import SalesDashboardPage from '../page';

describe('Z — Sales dashboard chart header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Z3: heading reads "Target vs. Achievement"', async () => {
    render(<SalesDashboardPage />);
    await waitFor(() =>
      expect(screen.getByText('Target vs. Achievement')).toBeInTheDocument()
    );
  });

  it('Z4: sub-line "Target vs Achieved" is not shown', async () => {
    render(<SalesDashboardPage />);
    await waitFor(() =>
      expect(screen.queryByText(/target vs achieved/i)).not.toBeInTheDocument()
    );
  });
});
