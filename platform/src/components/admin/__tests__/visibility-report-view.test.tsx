/// <reference types="vitest/globals" />
/**
 * VISRPT — VisibilityReportView
 *
 * VISRPT1: admin variant renders the per-window coverage tiles from getReport.
 * VISRPT2: the Export button calls visibilityApi.downloadExport with the window.
 * VISRPT3: tenant variant reads getTenantReport and hides the Export button.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getReport = vi.fn();
const getTenantReport = vi.fn();
const downloadExport = vi.fn();

vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    getReport: (...a: unknown[]) => getReport(...a),
    getTenantReport: (...a: unknown[]) => getTenantReport(...a),
    downloadExport: (...a: unknown[]) => downloadExport(...a),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

import { VisibilityReportView } from '../VisibilityReportView';

const REPORT = {
  windowKey: '2026-07-P2',
  windowClosed: false,
  frequencyPerMonth: 2,
  outletScope: ['SSS', 'SSS_TOT'],
  summary: { denominator: 10, captured: 6, pending: 2, rejected: 1, missed: 1, coveragePct: 60 },
};

beforeEach(() => {
  getReport.mockReset();
  getTenantReport.mockReset();
  downloadExport.mockReset();
  getReport.mockResolvedValue({ success: true, data: REPORT });
  getTenantReport.mockResolvedValue({ success: true, data: REPORT });
  downloadExport.mockResolvedValue({ success: true });
});

describe('VISRPT — VisibilityReportView', () => {
  it('VISRPT1: admin variant renders coverage tiles', async () => {
    render(<VisibilityReportView variant="admin" />);
    expect(await screen.findByText('60%')).toBeInTheDocument();
    expect(screen.getByText('Coverage')).toBeInTheDocument();
    // denominator tile
    expect(screen.getByText('In scope')).toBeInTheDocument();
  });

  it('VISRPT2: Export calls downloadExport with the selected window', async () => {
    render(<VisibilityReportView variant="admin" />);
    await screen.findByText('60%');
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }));
    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith('2026-07-P2'));
  });

  it('VISRPT3: tenant variant uses getTenantReport and hides Export', async () => {
    render(<VisibilityReportView variant="tenant" />);
    await screen.findByText('60%');
    expect(getTenantReport).toHaveBeenCalled();
    expect(getReport).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /export excel/i })).not.toBeInTheDocument();
  });
});
