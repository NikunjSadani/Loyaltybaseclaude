/**
 * SchemeEnrollmentsView — the read-only boundary (D26 tenant parity).
 *
 * The SAME rich enrollments view backs two callers:
 *   • GIFSY admin (readOnly=false): full read+write, report via getReport.
 *   • tenant CLIENT_ADMIN (readOnly=true): read-only, report via getTenantReport
 *     (getReport is GIFSY-only → 403 for a tenant), and every write affordance hidden.
 *
 * These assert the two security-critical branches so a regression can't silently
 * (a) call the GIFSY-only report as a tenant, or (b) render a write control read-only.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) =>
    React.createElement('a', { href, ...rest }, children),
}));

const listEnrollments = vi.fn();
const getReport = vi.fn();
const getTenantReport = vi.fn();
const downloadExport = vi.fn();
const listDeletedEnrollments = vi.fn();
vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    listEnrollments: (...a: unknown[]) => listEnrollments(...a),
    getReport: (...a: unknown[]) => getReport(...a),
    getTenantReport: (...a: unknown[]) => getTenantReport(...a),
    downloadExport: (...a: unknown[]) => downloadExport(...a),
    listDeletedEnrollments: (...a: unknown[]) => listDeletedEnrollments(...a),
    getEnrollment: vi.fn(),
    reject: vi.fn(),
    deleteEnrollment: vi.fn(),
    restoreEnrollment: vi.fn(),
  },
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

const REPORT = {
  scheme: { id: 's1', code: 'C', name: 'Field Audit', status: 'ACTIVE' },
  summary: { rosterCount: 12, enrolledCount: 8, submittedCount: 7, rejectedCount: 1, notEnrolledCount: 4, coveragePct: 67 },
};
const EMPTY_LIST = { success: true, data: { enrollments: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } } };

beforeEach(() => {
  listEnrollments.mockResolvedValue(EMPTY_LIST);
  getReport.mockResolvedValue({ success: true, data: REPORT });
  getTenantReport.mockResolvedValue({ success: true, data: { ...REPORT, rows: [] } });
  downloadExport.mockResolvedValue({ success: true });
  listDeletedEnrollments.mockResolvedValue({ success: true, data: { enrollments: [] } });
});
afterEach(() => { vi.clearAllMocks(); });

async function renderView(readOnly: boolean) {
  const { default: SchemeEnrollmentsView } = await import('../SchemeEnrollmentsView');
  return render(<SchemeEnrollmentsView schemeId="s1" readOnly={readOnly} backHref="/back" />);
}

describe('SchemeEnrollmentsView — read-only tenant boundary', () => {
  it('readOnly: fetches the TENANT report (never the GIFSY-only getReport) and never lists deleted', async () => {
    await act(async () => { await renderView(true); });
    await waitFor(() => expect(screen.getByText('67%')).toBeInTheDocument());
    expect(getTenantReport).toHaveBeenCalledWith('s1');
    expect(getReport).not.toHaveBeenCalled();
    expect(listDeletedEnrollments).not.toHaveBeenCalled();
  });

  it('readOnly: hides the write affordances (no Show-deleted) but keeps Export Excel', async () => {
    await act(async () => { await renderView(true); });
    await waitFor(() => expect(screen.getByText('67%')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /show deleted/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export excel/i })).toBeInTheDocument();
  });

  it('write mode (GIFSY): uses getReport and shows the Show-deleted recovery toggle', async () => {
    await act(async () => { await renderView(false); });
    await waitFor(() => expect(screen.getByText('67%')).toBeInTheDocument());
    expect(getReport).toHaveBeenCalledWith('s1');
    expect(getTenantReport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /show deleted/i })).toBeInTheDocument();
  });
});
