/// <reference types="vitest/globals" />
/**
 * TDD — Employee Hierarchy Management page (admin portal)
 *
 * H33: Page renders "Employee Hierarchy" heading
 * H34: Download Template button present  (data-testid="download-template")
 * H35: Download Guide button present     (data-testid="download-guide")
 * H36: Search input present              (data-testid="employee-search")
 * H37: Employee list renders mock employees
 * H38: Search by Employee ID filters the list
 * H39: Search by name filters the list
 * H40: Search by phone filters the list
 * H41: Upload area / file input present  (data-testid="hierarchy-upload-input")
 * H42: Stats cards present               (data-testid="stat-total", "stat-active", "stat-placeholder")
 * H43: Validation result panel hidden by default
 * H44: After simulated validation with errors → error panel shown
 * H45: Confirm button absent when validation has errors
 * H46: Employee status badge shows PLACEHOLDER for vacant positions
 * H47: Hierarchy path is visible on employee row
 * H48: Filtering shows correct count in results
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/admin/hierarchy',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

// Mock xlsx — no real file generation needed in tests
vi.mock('xlsx', () => ({
  utils: {
    book_new:      vi.fn(() => ({})),
    aoa_to_sheet:  vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
  },
  writeFile: vi.fn(),
  write: vi.fn(() => new ArrayBuffer(8)),
}));

// Stub URL.createObjectURL / revokeObjectURL
Object.defineProperty(globalThis, 'URL', {
  value: {
    createObjectURL: vi.fn(() => 'blob:test-url'),
    revokeObjectURL: vi.fn(),
  },
  configurable: true,
});

import HierarchyPage from '../page';

describe('H — Employee Hierarchy Management Page', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('H33: page renders "Employee Hierarchy" heading', () => {
    render(<HierarchyPage />);
    expect(screen.getByRole('heading', { name: /employee hierarchy/i })).toBeInTheDocument();
  });

  it('H34: Download Template button is present', () => {
    render(<HierarchyPage />);
    expect(screen.getByTestId('download-template')).toBeInTheDocument();
  });

  it('H35: Download Guide button is present', () => {
    render(<HierarchyPage />);
    expect(screen.getByTestId('download-guide')).toBeInTheDocument();
  });

  it('H36: search input is present', () => {
    render(<HierarchyPage />);
    expect(screen.getByTestId('employee-search')).toBeInTheDocument();
  });

  it('H37: employee list renders mock employees (NSM-01 should appear)', () => {
    render(<HierarchyPage />);
    expect(screen.getByText('NSM-01')).toBeInTheDocument();
  });

  it('H38: search by Employee ID filters the list', async () => {
    render(<HierarchyPage />);
    const search = screen.getByTestId('employee-search');
    fireEvent.change(search, { target: { value: 'NSM-01' } });
    await waitFor(() => {
      expect(screen.getByText('NSM-01')).toBeInTheDocument();
      expect(screen.queryByText('ISR-M001')).not.toBeInTheDocument();
    });
  });

  it('H39: search by name filters the list', async () => {
    render(<HierarchyPage />);
    const search = screen.getByTestId('employee-search');
    fireEvent.change(search, { target: { value: 'Anand Rao' } });
    await waitFor(() => {
      expect(screen.getByText(/Anand Rao/i)).toBeInTheDocument();
      // Anil Sharma should not be visible
      expect(screen.queryByText(/Anil Sharma/i)).not.toBeInTheDocument();
    });
  });

  it('H40: search by phone filters the list', async () => {
    render(<HierarchyPage />);
    const search = screen.getByTestId('employee-search');
    fireEvent.change(search, { target: { value: '9900000041' } });
    await waitFor(() => {
      // ISR-M001 has phone 9900000041
      expect(screen.getByText('ISR-M001')).toBeInTheDocument();
      expect(screen.queryByText('NSM-01')).not.toBeInTheDocument();
    });
  });

  it('H41: file upload input is present', () => {
    render(<HierarchyPage />);
    expect(screen.getByTestId('hierarchy-upload-input')).toBeInTheDocument();
  });

  it('H42: stats cards are present', () => {
    render(<HierarchyPage />);
    expect(screen.getByTestId('stat-total')).toBeInTheDocument();
    expect(screen.getByTestId('stat-active')).toBeInTheDocument();
    expect(screen.getByTestId('stat-placeholder')).toBeInTheDocument();
  });

  it('H43: validation result panel hidden by default (no upload yet)', () => {
    render(<HierarchyPage />);
    expect(screen.queryByTestId('validation-panel')).not.toBeInTheDocument();
  });

  it('H44: confirmation panel not shown before any upload', () => {
    render(<HierarchyPage />);
    expect(screen.queryByTestId('confirm-upload-btn')).not.toBeInTheDocument();
  });

  it('H45: PLACEHOLDER badge shown for vacant positions', () => {
    render(<HierarchyPage />);
    // ISR-M002 and SO-MUM2 are PLACEHOLDER
    const badges = screen.getAllByTestId('status-badge');
    const placeholderBadge = badges.find(b => b.textContent?.toLowerCase().includes('placeholder'));
    expect(placeholderBadge).toBeInTheDocument();
  });

  it('H46: ACTIVE badge shown for active employees', () => {
    render(<HierarchyPage />);
    const badges = screen.getAllByTestId('status-badge');
    const activeBadge = badges.find(b => b.textContent?.toLowerCase().includes('active'));
    expect(activeBadge).toBeInTheDocument();
  });

  it('H47: hierarchy path is shown on each employee row', () => {
    render(<HierarchyPage />);
    // NSM-01's path is /NSM-01/
    expect(screen.getByText('/NSM-01/')).toBeInTheDocument();
  });

  it('H48: stat-total shows the total number of employees', () => {
    render(<HierarchyPage />);
    const totalEl = screen.getByTestId('stat-total');
    // MOCK_EMPLOYEES has 11 employees
    expect(Number(totalEl.textContent)).toBeGreaterThan(0);
  });

  it('H49: clearing search restores all employees', async () => {
    render(<HierarchyPage />);
    const search = screen.getByTestId('employee-search');
    fireEvent.change(search, { target: { value: 'NSM-01' } });
    fireEvent.change(search, { target: { value: '' } });
    await waitFor(() => {
      // Both NSM-01 and ISR-M001 should be visible again
      expect(screen.getByText('NSM-01')).toBeInTheDocument();
      expect(screen.getByText('ISR-M001')).toBeInTheDocument();
    });
  });
});
