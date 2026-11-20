/// <reference types="vitest/globals" />
/**
 * VISRPT — VisibilityReportView (month-wise, VISIBILITY-POSM-DESIGN.md §17)
 *
 * VISRPT1: default = current IST month; plain-status tiles + coverage from the report.
 * VISRPT2: Export calls downloadExport with the month's only window (freq 1).
 * VISRPT2b: Export month calls downloadExport with the SELECTED report month.
 * VISRPT3: tenant variant reads the tenant report and shows both exports (client admins download their own tenant).
 * VISRPT4/5: scope caption (with / without program narrowing).
 * VISRPT6: picking another month refetches that month; freq 2 shows a window picker; export needs one window.
 * VISRPT7: tapping a tile opens the outlet list for that status; a breakdown row filters by that row.
 * VISRPT8: captures not counted are called out loudly.
 * VISRPT9: imported month — the old app's visits only; coverage / Missed "Not tracked" with the reason.
 * VISRPT10: a re-take left when the window closed shows as "Not approved — window closed".
 * VISRPT11: the not-counted banner points at the month export (which holds every capture not counted).
 * VISRPT12: accessibility — toggletip definitions (keyboard), arrow-key tabs + tabpanel, coverage bar text.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getReport = vi.fn();
const getOutlets = vi.fn();
const downloadExport = vi.fn();

vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    downloadExport: (...a: unknown[]) => downloadExport(...a),
  },
}));

vi.mock('@/lib/visibility-report', async (orig) => {
  const actual = await orig<typeof import('@/lib/visibility-report')>();
  return {
    ...actual,
    currentIstMonth: () => '2026-11',
    monthOptions: () => [
      { value: '2026-11', label: 'Nov 2026' },
      { value: '2026-10', label: 'Oct 2026' },
    ],
    visibilityReportApi: {
      getReport: (...a: unknown[]) => getReport(...a),
      getOutlets: (...a: unknown[]) => getOutlets(...a),
    },
  };
});

import { VisibilityReportView } from '../VisibilityReportView';

const tally = {
  inScope: 10, approved: 6, waiting: 1, needsRetake: 1, rejected: 1, closedNotApproved: 0, notCaptured: 1, missed: 0, notTracked: 0, partOldApp: 0,
  coveragePct: 60 as number | null,
};
const REPORT = {
  month: '2026-11',
  windowKey: null,
  windows: [{ key: '2026-11-P1', closed: false }],
  windowClosed: false,
  frequencyPerMonth: 1,
  outletScope: ['SSS', 'SSS_TOT'],
  outletsInScope: 10,
  summary: tally,
  notCounted: { outOfScope: 0, otherWindow: 0 },
  breakdowns: {
    programme: [{ key: '["Unnati","Elite"]', label: 'Unnati / Elite', ...tally }],
    rep: [{ key: 'r1', label: 'Ravi (E1)', ...tally }],
    manager: [{ key: 'm1', label: 'Meera', ...tally }],
  },
};
const OUTLETS = {
  month: '2026-11', windowKey: null, status: 'NEEDS_RETAKE', group: null, groupKey: null, groupLabel: null,
  rows: [{
    outletId: 'o3', outletCode: 'A3', outletName: 'Three Stores', programme: 'Unnati', subProgramme: 'Privilege',
    windowKey: '2026-11-P1', status: 'NEEDS_RETAKE', captureId: 'c3', rep: 'Sita (E2)', manager: 'Meera',
    capturedBy: 'Sita (E2)', capturedOn: '2026-11-08T05:00:00.000Z', reviewedBy: 'Reviewer One', reviewedOn: '2026-11-09T05:00:00.000Z', imported: false,
  }],
  pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
};

beforeEach(() => {
  getReport.mockReset();
  getOutlets.mockReset();
  downloadExport.mockReset();
  getReport.mockResolvedValue({ success: true, data: REPORT });
  getOutlets.mockResolvedValue({ success: true, data: OUTLETS });
  downloadExport.mockResolvedValue({ success: true });
});

describe('VISRPT — VisibilityReportView', () => {
  it('VISRPT1: default month + plain-status tiles + coverage', async () => {
    render(<VisibilityReportView variant="admin" />);
    expect(await screen.findByText(/^Coverage — Nov 2026/)).toBeInTheDocument();
    expect(screen.getAllByText('60%').length).toBeGreaterThan(0);
    expect(getReport).toHaveBeenCalledWith('admin', { month: '2026-11', windowKey: undefined });
    for (const label of ['In scope', 'Approved', 'Waiting for review', 'Needs re-take', 'Rejected', 'Not captured yet', 'Missed', 'Coverage']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Window open')).toBeInTheDocument();
  });

  it('VISRPT2: Export calls downloadExport with the month\'s only window', async () => {
    render(<VisibilityReportView variant="admin" />);
    await screen.findByText(/^Coverage — /);
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }));
    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith('2026-11-P1'));
  });

  it('VISRPT2b: Export month calls downloadExport with the selected report month', async () => {
    getReport.mockImplementation((_v: unknown, q: { month: string }) =>
      Promise.resolve({ success: true, data: { ...REPORT, month: q.month, windows: [{ key: `${q.month}-P1`, closed: q.month < '2026-11' }] } }),
    );
    render(<VisibilityReportView variant="admin" />);
    await screen.findByText(/^Coverage — Nov 2026/);
    fireEvent.change(screen.getByLabelText('Report month'), { target: { value: '2026-10' } });
    await screen.findByText(/^Coverage — Oct 2026/);
    fireEvent.click(screen.getByRole('button', { name: /export oct 2026|export october 2026/i }));
    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith(undefined, '2026-10'));
  });

  it('VISRPT3: tenant variant uses the tenant report and (owner 2026-11-20) shows Export for the client admin', async () => {
    render(<VisibilityReportView variant="tenant" />);
    await screen.findByText(/^Coverage — /);
    expect(getReport).toHaveBeenCalledWith('tenant', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }));
    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith('2026-11-P1'));
    expect(screen.getByRole('button', { name: /export nov(ember)? 2026/i })).toBeInTheDocument();
  });

  const scopeLine = () =>
    screen.getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').startsWith('Scope:')).textContent;

  it('VISRPT4: scope caption without program narrowing', async () => {
    render(<VisibilityReportView variant="tenant" />);
    await screen.findByText(/^Coverage — /);
    expect(scopeLine()).toBe('Scope: SSS, SSS_TOT · 1× per month');
  });

  it('VISRPT5: scope caption shows programs / sub-programs when set', async () => {
    getReport.mockResolvedValue({ success: true, data: { ...REPORT, programs: ['RLP', 'BSC'], subPrograms: ['Urban'] } });
    render(<VisibilityReportView variant="tenant" />);
    await screen.findByText(/^Coverage — /);
    expect(scopeLine()).toBe('Scope: SSS, SSS_TOT · Programs: RLP, BSC · Sub-Programs: Urban · 1× per month');
  });

  it('VISRPT6: another month refetches; freq 2 → window picker; "All windows" cannot export', async () => {
    getReport.mockImplementation((_v: string, q: { month: string; windowKey?: string }) =>
      Promise.resolve({
        success: true,
        data: q.month === '2026-10'
          ? { ...REPORT, month: '2026-10', frequencyPerMonth: 2, windowKey: q.windowKey ?? null,
              windows: [{ key: '2026-10-P1', closed: true }, { key: '2026-10-P2', closed: true }] }
          : REPORT,
      }),
    );
    render(<VisibilityReportView variant="admin" />);
    await screen.findByText(/^Coverage — /);
    fireEvent.change(screen.getByLabelText('Report month'), { target: { value: '2026-10' } });
    await waitFor(() => expect(getReport).toHaveBeenLastCalledWith('admin', { month: '2026-10', windowKey: undefined }));
    const windowSelect = await screen.findByLabelText('Report window');
    expect(screen.getByRole('button', { name: /export excel/i })).toBeDisabled();
    expect(screen.getByText('Pick one window to export.')).toBeInTheDocument();
    fireEvent.change(windowSelect, { target: { value: '2026-10-P2' } });
    await waitFor(() => expect(getReport).toHaveBeenLastCalledWith('admin', { month: '2026-10', windowKey: '2026-10-P2' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /export excel/i })).not.toBeDisabled());
  });

  it('VISRPT7: a tile opens its outlets; a breakdown row filters by that row', async () => {
    render(<VisibilityReportView variant="admin" />);
    await screen.findByText(/^Coverage — /);
    fireEvent.click(screen.getByRole('button', { name: /needs re-take: 1\. show outlets/i }));
    const list = await screen.findByTestId('report-outlet-list');
    expect(getOutlets).toHaveBeenCalledWith('admin', expect.objectContaining({ month: '2026-11', status: 'NEEDS_RETAKE', page: 1 }));
    expect(await within(list).findByText('Three Stores')).toBeInTheDocument();
    expect(within(list).getByText('Reviewer One')).toBeInTheDocument();
    expect(within(list).getByText('Manager: Meera')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /by rep/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Ravi (E1)' }));
    await waitFor(() =>
      expect(getOutlets).toHaveBeenLastCalledWith('admin', expect.objectContaining({ group: 'rep', groupKey: 'r1', status: undefined })),
    );
  });

  it('VISRPT8: captures not counted are called out (never silent)', async () => {
    getReport.mockResolvedValue({ success: true, data: { ...REPORT, notCounted: { outOfScope: 3, otherWindow: 0 } } });
    render(<VisibilityReportView variant="tenant" />);
    const note = await screen.findByTestId('report-not-counted');
    expect(note.textContent).toContain('3 captures in Nov 2026 are not counted');
    expect(note.textContent).toContain('no longer in scope');
  });

  it('VISRPT9: imported month — visits the old app recorded; coverage / Missed not tracked, with the reason', async () => {
    const note = 'Not tracked for imported months — the old app only kept approved visits, so coverage and Missed cannot be worked out.';
    const imp = { ...tally, inScope: 4, approved: 4, waiting: 0, needsRetake: 0, rejected: 0, notCaptured: 0, coveragePct: null };
    getReport.mockResolvedValue({
      success: true,
      data: {
        ...REPORT, month: '2026-10', windows: [{ key: '2026-10-P1', closed: true }], importedMonth: true, importedMonthNote: note,
        summary: imp, breakdowns: { programme: [{ key: 'p', label: 'Unnati / Elite', ...imp }], rep: [], manager: [] },
      },
    });
    render(<VisibilityReportView variant="tenant" />);
    const banner = await screen.findByTestId('report-imported-month');
    expect(banner.textContent).toContain('Oct 2026 is an imported month.');
    expect(banner.textContent).toContain('the old app only kept approved visits');
    expect(screen.getByText('Visits recorded (old app)')).toBeInTheDocument();
    expect(screen.getAllByText('Not tracked').length).toBeGreaterThan(0);
    // No "Missed" / "Not captured yet" tiles for an imported month, and no coverage bar against today's outlets.
    expect(screen.queryByRole('button', { name: /^missed:/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^not captured yet:/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('report-coverage-bar')).not.toBeInTheDocument();
    expect(screen.getByTestId('report-coverage-not-tracked')).toHaveTextContent(note);
  });

  it('VISRPT10: a re-take left when the window closed is "Not approved — window closed" (its own tile + column)', async () => {
    getReport.mockResolvedValue({
      success: true,
      data: { ...REPORT, summary: { ...tally, needsRetake: 0, rejected: 0, closedNotApproved: 2 } },
    });
    render(<VisibilityReportView variant="admin" />);
    await screen.findByText(/^Coverage — /);
    fireEvent.click(screen.getByRole('button', { name: /not approved — window closed: 2\. show outlets/i }));
    await waitFor(() =>
      expect(getOutlets).toHaveBeenCalledWith('admin', expect.objectContaining({ status: 'CLOSED_NOT_APPROVED' })),
    );
    expect(screen.getByRole('columnheader', { name: 'Not approved — window closed' })).toBeInTheDocument();
  });

  it('VISRPT11: the not-counted banner points at the month export, which holds every one of those captures', async () => {
    getReport.mockResolvedValue({ success: true, data: { ...REPORT, notCounted: { outOfScope: 2, otherWindow: 1 } } });
    const { unmount } = render(<VisibilityReportView variant="admin" />);
    let note = await screen.findByTestId('report-not-counted');
    expect(note.textContent).toContain("still in the month's Excel export");
    expect(note.textContent).not.toContain('cannot be exported');
    unmount();
    // The tenant screen has the same exports (owner 2026-11-20) → the same claim.
    render(<VisibilityReportView variant="tenant" />);
    note = await screen.findByTestId('report-not-counted');
    expect(note.textContent).toContain("still in the month's Excel export");
  });

  it('VISRPT13: the old-app tile ("No approved record — part of this window was on the old app") shows only when it counts something', async () => {
    const { unmount } = render(<VisibilityReportView variant="admin" />);
    await screen.findByText(/^Coverage — /);
    expect(screen.queryByText('No approved record — part of this window was on the old app')).not.toBeInTheDocument();
    unmount();
    getReport.mockResolvedValue({ success: true, data: { ...REPORT, summary: { ...tally, partOldApp: 2 } } });
    render(<VisibilityReportView variant="admin" />);
    expect((await screen.findAllByText('No approved record — part of this window was on the old app')).length).toBeGreaterThan(0);
  });

  it('VISRPT12: definitions are keyboard toggletips; tabs move with arrow keys; the coverage bar has a text alternative', async () => {
    render(<VisibilityReportView variant="admin" />);
    await screen.findByText(/^Coverage — /);
    const tip = screen.getByRole('button', { name: 'About Missed' });
    expect(tip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(tip);
    expect(tip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('No capture by the time the window closed.')).toBeInTheDocument();
    fireEvent.keyDown(tip, { key: 'Escape' });
    expect(tip).toHaveAttribute('aria-expanded', 'false');

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /by rep/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'vis-breakdown-tab-rep');
    fireEvent.keyDown(screen.getByRole('tab', { name: /by rep/i }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: /by programme/i })).toHaveAttribute('aria-selected', 'true');

    const bar = screen.getByTestId('report-coverage-bar');
    expect(bar).toHaveAttribute('role', 'img');
    expect(bar.getAttribute('aria-label')).toContain('Coverage 60% of 10 visits due');
    expect(bar.getAttribute('aria-label')).toContain('Approved 6');
  });

  it('shows the error with a retry when the report fails', async () => {
    getReport.mockResolvedValue({ success: false, error: 'Visibility is not enabled for this tenant.' });
    render(<VisibilityReportView variant="tenant" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Visibility is not enabled');
  });
});
