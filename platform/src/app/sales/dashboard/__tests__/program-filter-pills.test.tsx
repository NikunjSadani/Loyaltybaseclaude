/**
 * TDD — Program-name filter pills on the Target vs. Achievement chart
 *
 * PF1: "Vriddhi" pill is rendered
 * PF2: "Sambandh 2.0" pill is rendered
 * PF3: "SSS" pill is NOT rendered (replaced by program name)
 * PF4: "Wholesaler" pill is NOT rendered (replaced by program name)
 * PF5: "Sub-Stockist" pill is NOT rendered (removed)
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
  fetchBanners:              () => Promise.resolve({ banners: [] }),
  getActiveSalesBanners:     () => [],
  getActiveBannersFromList:  () => [],
  getBgStyle:                () => ({}),
  getActivePopup:            () => null,
  shouldShowPopup:           () => false,
  markPopupSeen:             () => undefined,
}));

import SalesDashboardPage from '../page';

describe('PF — Program filter pills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PF1: "Vriddhi" pill is rendered', async () => {
    render(<SalesDashboardPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Vriddhi' })).toBeInTheDocument()
    );
  });

  it('PF2: "Sambandh 2.0" pill is rendered', async () => {
    render(<SalesDashboardPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sambandh 2.0' })).toBeInTheDocument()
    );
  });

  it('PF3: "SSS" pill is NOT rendered', async () => {
    render(<SalesDashboardPage />);
    // Wait for component to settle
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Vriddhi' })).toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: 'SSS' })).not.toBeInTheDocument();
  });

  it('PF4: "Wholesaler" pill is NOT rendered', async () => {
    render(<SalesDashboardPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Vriddhi' })).toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: 'Wholesaler' })).not.toBeInTheDocument();
  });

  it('PF5: "Sub-Stockist" pill is NOT rendered', async () => {
    render(<SalesDashboardPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Vriddhi' })).toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: 'Sub-Stockist' })).not.toBeInTheDocument();
  });
});
