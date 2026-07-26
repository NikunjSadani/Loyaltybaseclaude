/**
 * enrollments.test.tsx
 *
 * Tests for the real per-scheme Enrollments view (D25):
 *  1. Loads the report + enrollment list on mount; renders live stat tiles
 *     (no more hardcoded "—").
 *  2. Clicking "Export Excel" calls schemeApi.downloadExport.
 *  3. Surfaces an export error when the download fails.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) =>
    React.createElement('a', { href, ...rest }, children),
}));

// react `use(params)` → { id: 'sch-test' }
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    use: (val: unknown) => {
      if (val && typeof (val as Promise<unknown>).then === 'function') return { id: 'sch-test' };
      return val;
    },
  };
});

// Mock the canonical scheme client.
const listEnrollments = vi.fn();
const getReport = vi.fn();
const downloadExport = vi.fn();
vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    listEnrollments: (...a: unknown[]) => listEnrollments(...a),
    getReport: (...a: unknown[]) => getReport(...a),
    downloadExport: (...a: unknown[]) => downloadExport(...a),
    getEnrollment: vi.fn(),
    reject: vi.fn(),
  },
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

const REPORT = {
  scheme: { id: 'sch-test', code: 'C', name: 'Visibility Audit', status: 'ACTIVE' },
  summary: { rosterCount: 12, enrolledCount: 8, submittedCount: 7, rejectedCount: 1, notEnrolledCount: 4, coveragePct: 67 },
};

beforeEach(() => {
  listEnrollments.mockResolvedValue({ success: true, data: { enrollments: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } } });
  getReport.mockResolvedValue({ success: true, data: REPORT });
  downloadExport.mockResolvedValue({ success: true });
});
afterEach(() => { vi.clearAllMocks(); });

async function renderPage() {
  const { default: EnrollmentsPage } = await import('./page');
  return render(<EnrollmentsPage params={Promise.resolve({ id: 'sch-test' }) as Promise<{ id: string }>} />);
}

describe('Enrollments view', () => {
  it('renders live report stat tiles + empty list state', async () => {
    await act(async () => { await renderPage(); });
    await waitFor(() => {
      expect(screen.getByText('Visibility Audit', { exact: false })).toBeInTheDocument();
      expect(screen.getByText('67%')).toBeInTheDocument();
      expect(screen.getByText(/no enrollments/i)).toBeInTheDocument();
    });
  });

  it('calls schemeApi.downloadExport when Export Excel is clicked', async () => {
    await act(async () => { await renderPage(); });
    const btn = screen.getByRole('button', { name: /export excel/i });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith('sch-test'));
  });

  it('shows an error when the export fails', async () => {
    downloadExport.mockResolvedValueOnce({ success: false, error: 'Insufficient permissions' });
    await act(async () => { await renderPage(); });
    const btn = screen.getByRole('button', { name: /export excel/i });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(screen.getByText(/insufficient permissions/i)).toBeInTheDocument());
  });
});
