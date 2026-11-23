/// <reference types="vitest/globals" />
/**
 * /admin/sales-import/[id] — polling, preview, acks, apply, 409 refresh (SALES-IMPORT-PIPELINE-PLAN §11 F-4).
 * API mocked (backend lanes build in parallel).
 * Run: npx vitest run src/app/admin/sales-import/__tests__/import-detail.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EMPTY_MONTH_RECONCILIATION, type MonthPreview, type SalesApplyJobDto, type SalesImportDetail, type SalesImportPreview } from '@/lib/sales-import/types';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'imp1' }),
  useRouter: () => ({ push, replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const apiMock = vi.hoisted(() => ({
  get: vi.fn(), preview: vi.fn(), apply: vi.fn(), reprocess: vi.fn(), remove: vi.fn(), cancel: vi.fn(), reprocessAsNew: vi.fn(),
  getApplyJob: vi.fn(), findApplyJob: vi.fn(),
  unmatchedCsvUrl: (id: string) => `/u/${id}`, errorsXlsxUrl: (id: string) => `/e/${id}`,
}));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock, fetchDownload: vi.fn() }));
const perms = vi.hoisted(() => ({ granted: true, config: true }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({
    role: 'CLIENT_ADMIN', permissions: [], ready: true, error: false, retry: () => {},
    has: (p: string) => (p === 'targets:manage_config' ? perms.config : perms.granted),
  }),
}));

import Page from '../[id]/page';

function detail(over: Partial<SalesImportDetail> = {}): SalesImportDetail {
  return {
    id: 'imp1', status: 'READY', originalFilename: 'dms.xlsx', fileKind: 'XLSX', sizeBytes: 1000, partCount: 1,
    partsReceived: 1, bytesRead: 1000, rowsRead: 50, rowsSkipped: 0, progressPct: null, duplicateOfId: null,
    error: null, detectedHeaders: null, createdAt: '2026-11-01T10:00:00.000Z', finishedAt: null, uploadedBy: 'Asha',
    queuedAt: null, heartbeatAt: null, stalled: false, applied: false, purgedAt: null, canReprocess: true, canCancel: false, canDelete: true, reprocessedFromId: null, canReprocessAsNew: false,
    monthSummaries: null, errorSamples: null, ...over,
  };
}

function month(over: Partial<MonthPreview> = {}): MonthPreview {
  return {
    month: '2026-10', firstDate: '2026-10-01', lastDate: '2026-10-31', lines: 40, matchedOutlets: 3,
    unmatchedCustomers: 2, matchedAmountRupees: 1200, matchedQuantity: 4.5, unmatchedAmountRupees: 30,
    unmatchedQuantity: 0.2, monthState: 'OPEN', canApply: true, warnings: [], zeroFillOutlets: 1,
    kpis: [{ kpiCode: 'KPI_X', label: 'KPI X', measure: 'AMOUNT', newTotal: 1200, currentTotal: 1000, delta: 200, outletsNonZero: 3, outletsNegative: 0 }],
    lastApplied: null, reconciliation: EMPTY_MONTH_RECONCILIATION, activeJob: null, lastJob: null, ...over,
  };
}

function preview(months: MonthPreview[], over: Partial<SalesImportPreview> = {}): SalesImportPreview {
  return {
    importId: 'imp1', definitionsHash: 'h1', processingVersion: 7, mappingChanged: false, rosterOutletsAddedSinceProcessing: 0, rosterOutletsNotIncluded: 0,
    months, ...over,
  };
}

const ok = <T,>(data: T) => ({ success: true as const, data });

beforeEach(() => {
  window.sessionStorage.clear();
  Object.values(apiMock).forEach((f) => typeof f === 'function' && 'mockReset' in f && (f as ReturnType<typeof vi.fn>).mockReset());
  push.mockReset();
  perms.granted = true;
  perms.config = true;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('import detail — processing', () => {
  it('polls every 2 s while PROCESSING and shows the preview once READY', async () => {
    vi.useFakeTimers();
    apiMock.get
      .mockResolvedValueOnce(ok(detail({ status: 'PROCESSING', progressPct: 40, rowsRead: 1234 })))
      .mockResolvedValueOnce(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('sales-import-processing')).toHaveTextContent('1,234 rows read');
    expect(screen.getByRole('progressbar', { name: 'Processing progress' })).toHaveAttribute('aria-valuenow', '40');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(apiMock.get).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('sales-import-preview')).toBeInTheDocument();
    // terminal → no more polling
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(apiMock.get).toHaveBeenCalledTimes(2);
  });

  it('stops polling on 403 with a final message', async () => {
    vi.useFakeTimers();
    apiMock.get.mockResolvedValue({ success: false, error: 'Forbidden', status: 403 });
    render(<Page />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/have access to this import/)).toBeInTheDocument();
    expect(screen.queryByText(/Still trying/)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(apiMock.get).toHaveBeenCalledTimes(1);
  });

  it('a transient error keeps polling and says so', async () => {
    vi.useFakeTimers();
    apiMock.get.mockResolvedValueOnce({ success: false, error: 'HTTP 502', status: 502 })
      .mockResolvedValue(ok(detail({ status: 'QUEUED', canCancel: true })));
    render(<Page />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Still trying/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByTestId('sales-import-processing')).toBeInTheDocument();
  });

  it('QUEUED can be cancelled', async () => {
    apiMock.get.mockResolvedValueOnce(ok(detail({ status: 'QUEUED', canCancel: true, canDelete: false })))
      .mockResolvedValue(ok(detail({ status: 'CANCELLED', canCancel: false })));
    apiMock.cancel.mockResolvedValue(ok(detail({ status: 'CANCELLED' })));
    render(<Page />);
    fireEvent.click(await screen.findByTestId('sales-import-cancel'));
    expect(await screen.findByText(/This import was cancelled/)).toBeInTheDocument();
    expect(apiMock.cancel).toHaveBeenCalledWith('imp1');
  });

  it('UPLOADING explains it may still be uploading elsewhere', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ status: 'UPLOADING', partsReceived: 2, partCount: 5 })));
    render(<Page />);
    expect(await screen.findByTestId('sales-import-uploading')).toHaveTextContent(/2 of 5 parts.*another tab/);
  });

  it('NEEDS_MAPPING separates the heading row from sample rows', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ status: 'NEEDS_MAPPING', detectedHeaders: [['CUST', 'DATE'], ['C001', '05-10-2026']] })));
    render(<Page />);
    const card = await screen.findByTestId('sales-import-needs-mapping');
    expect(within(card).getByRole('columnheader', { name: 'CUST' })).toBeInTheDocument();
    expect(within(card).getByRole('cell', { name: 'C001' })).toBeInTheDocument();
  });

  it('NEEDS_MAPPING shows the detected headings and links to Settings', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ status: 'NEEDS_MAPPING', detectedHeaders: [['X', 'X'], ['CUST', 'DATE']], error: 'Missing: INVOICE DATE' })));
    render(<Page />);
    const card = await screen.findByTestId('sales-import-needs-mapping');
    expect(card).toHaveTextContent('CUST');
    expect(within(card).getByRole('link', { name: /Set up column mapping/ })).toHaveAttribute('href', '/admin/sales-import/settings?fromImport=imp1');
  });

  it('FAILED shows the message and Reprocess re-queues', async () => {
    apiMock.get.mockResolvedValueOnce(ok(detail({ status: 'FAILED', error: 'Corrupted xlsx' })))
      .mockResolvedValue(ok(detail({ status: 'QUEUED' })));
    apiMock.reprocess.mockResolvedValue(ok(detail({ status: 'QUEUED' })));
    render(<Page />);
    expect(await screen.findByTestId('sales-import-failed')).toHaveTextContent('Corrupted xlsx');
    fireEvent.click(screen.getByRole('button', { name: /Reprocess/ }));
    expect(await screen.findByTestId('sales-import-processing')).toBeInTheDocument();
    expect(apiMock.reprocess).toHaveBeenCalledWith('imp1');
  });
});

describe('import detail — preview + apply', () => {
  it('shows a duplicate-file banner that never calls a re-apply harmless', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ duplicateOfId: 'old1' })));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    const b = await screen.findByTestId('sales-import-duplicate');
    expect(within(b).getByRole('link', { name: /earlier import/ })).toHaveAttribute('href', '/admin/sales-import/old1');
    expect(b.textContent).not.toMatch(/harmless/i);
    expect(b).toHaveTextContent(/roll those months back/);
  });

  it('a closed month cannot be ticked and shows why', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ month: '2026-08', monthState: 'CLOSED', canApply: false, blockedReason: 'August 2026 is closed. Only Gifsy can reopen it.' })])));
    render(<Page />);
    const box = await screen.findByRole('checkbox', { name: 'Apply August 2026' });
    expect(box).toBeDisabled();
    expect(screen.getByText(/Only Gifsy can reopen it/)).toBeInTheDocument();
  });

  it('a partial month needs its explicit ack before Apply; apply sends hash + acks; results render', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ firstDate: '2026-10-05', warnings: ['STARTS_AFTER_FIRST'] })])));
    apiMock.apply.mockResolvedValue(ok({ results: [{ month: '2026-10', ok: true, applyId: 'a1', outletsWritten: 3, outletsZeroFilled: 1 }] }));
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    const apply = screen.getByTestId('sales-import-apply');
    expect(apply).toBeDisabled();
    expect(screen.getByTestId('sales-import-apply-blockers')).toHaveTextContent('partial-month');
    fireEvent.click(screen.getByRole('checkbox', { name: /replaces the whole of October 2026/ }));
    expect(apply).not.toBeDisabled();
    await act(async () => { fireEvent.click(apply); });
    expect(window.confirm).toHaveBeenCalled();
    expect(apiMock.apply).toHaveBeenCalledWith('imp1', {
      months: ['2026-10'], expectedDefinitionsHash: 'h1', processingVersion: 7, acknowledgePartialMonths: ['2026-10'], requestId: expect.any(String),
    });
    expect(await screen.findByTestId('sales-import-apply-results')).toHaveTextContent('3 outlets updated, 1 set to 0');
  });

  it('S4: an apply that could not store the day-by-day figures says so LOUDLY per month (never silent); a written one shows no warning', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month(), month({ month: '2026-11', firstDate: '2026-11-01', lastDate: '2026-11-30' })])));
    apiMock.apply.mockResolvedValue(ok({ results: [
      { month: '2026-10', ok: true, applyId: 'a1', outletsWritten: 3, outletsZeroFilled: 1,
        dayData: { written: false, outlets: 0, rows: 0, lastDay: null, reason: 'This file was processed before day-by-day sales were stored. Reprocess the file and apply it again to store it.' } },
      { month: '2026-11', ok: true, applyId: 'a2', outletsWritten: 2, outletsZeroFilled: 0, dayData: { written: true, outlets: 2, rows: 9, lastDay: 17 } },
    ] }));
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apply November 2026' }));
    for (const ack of screen.queryAllByRole('checkbox', { name: /replaces the whole of/ })) fireEvent.click(ack);
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    await screen.findByTestId('sales-import-apply-results');
    const warn = screen.getByTestId('day-data-missing-2026-10');
    expect(warn).toHaveAttribute('role', 'alert');
    expect(warn).toHaveTextContent('Daily figures not stored for October 2026: This file was processed before day-by-day sales were stored. Reprocess the file and apply it again to store it.');
    expect(warn.textContent).not.toContain('..');
    expect(screen.queryByTestId('day-data-missing-2026-11')).not.toBeInTheDocument();
  });

  // Roster-only aggregates (owner 2026-11-23): outlets added after processing are NOT in the file's figures — never silent.
  it('roster-only import: outlets added after processing → amber "not included" banner with Reprocess (not the blue "included" note)', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()], { rosterOutletsNotIncluded: 3, rosterOutletsAddedSinceProcessing: 0 })));
    render(<Page />);
    const b = await screen.findByTestId('sales-import-roster-not-included');
    expect(b).toHaveTextContent(
      '3 outlets were added to the programme after this file was processed — their sales in this file are not included (they get 0). Reprocess the file (or upload the next file) to include them.',
    );
    expect(within(b).getByRole('alert')).toBeInTheDocument();
    expect(within(b).getByRole('button', { name: /Reprocess/ })).toBeInTheDocument();
    expect(screen.queryByTestId('sales-import-roster-added')).not.toBeInTheDocument();
  });

  it('no outlets left out (or a legacy import) → no "not included" banner', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    await screen.findByTestId('sales-import-preview');
    expect(screen.queryByTestId('sales-import-roster-not-included')).not.toBeInTheDocument();
  });

  it('an apply result reports the outlets not included (singular wording), a result without it shows nothing', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month(), month({ month: '2026-11', firstDate: '2026-11-01', lastDate: '2026-11-30' })])));
    apiMock.apply.mockResolvedValue(ok({ results: [
      { month: '2026-10', ok: true, applyId: 'a1', outletsWritten: 3, outletsZeroFilled: 1, outletsNotIncluded: 1 },
      { month: '2026-11', ok: true, applyId: 'a2', outletsWritten: 2, outletsZeroFilled: 0, outletsNotIncluded: 0 },
    ] }));
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apply November 2026' }));
    for (const ack of screen.queryAllByRole('checkbox', { name: /replaces the whole of/ })) fireEvent.click(ack);
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    await screen.findByTestId('sales-import-apply-results');
    const n = screen.getByTestId('not-included-2026-10');
    expect(n).toHaveAttribute('role', 'alert');
    expect(n).toHaveTextContent('1 outlet was added to the programme after this file was processed — its sales in this file are not included (it gets 0).');
    expect(screen.queryByTestId('not-included-2026-11')).not.toBeInTheDocument();
  });

  it('an older file needs the older-file ack', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ warnings: ['OLDER_THAN_LAST_APPLIED'] })])));
    apiMock.apply.mockResolvedValue(ok({ results: [{ month: '2026-10', ok: true }] }));
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    expect(screen.getByTestId('sales-import-apply')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /apply this older file/ }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    expect(apiMock.apply).toHaveBeenCalledWith('imp1', expect.objectContaining({ acknowledgeOlderThanLastApplied: true }));
  });

  it('cancelling the confirm sends nothing', async () => {
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    expect(apiMock.apply).not.toHaveBeenCalled();
  });

  it('409 (definitions changed) → notice + preview refetched', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: 'KPI definitions changed since the preview', status: 409 });
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    expect(await screen.findByTestId('sales-import-apply-notice')).toHaveTextContent(/preview has been refreshed/);
    expect(apiMock.preview).toHaveBeenCalledTimes(2);
  });

  it('a per-month failure is shown on its own card', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month(), month({ month: '2026-11', firstDate: '2026-11-01', lastDate: '2026-11-30' })])));
    apiMock.apply.mockResolvedValue(ok({ results: [
      { month: '2026-10', ok: false, error: 'October 2026 was closed meanwhile' },
      { month: '2026-11', ok: true, outletsWritten: 2, outletsZeroFilled: 0 },
    ] }));
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apply November 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    const results = await screen.findByTestId('sales-import-apply-results');
    expect(results).toHaveTextContent('October 2026: not applied');
    expect(results).toHaveTextContent('closed meanwhile');
    expect(results).toHaveTextContent('November 2026: applied');
  });

  it('mapping changed → red banner with Reprocess; roster additions are informational', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ canApply: false, blockedReason: 'The column mapping changed.' })], {
      mappingChanged: true, rosterOutletsAddedSinceProcessing: 4,
    })));
    render(<Page />);
    const b = await screen.findByTestId('sales-import-mapping-changed');
    expect(within(b).getByRole('button', { name: /Reprocess/ })).toBeInTheDocument();
    expect(screen.getByTestId('sales-import-roster-added')).toHaveTextContent('4 outlets were added');
  });

  it('any 4xx from Apply refreshes the preview (not only 409)', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: 'October 2026 is closed.', status: 400 });
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    const notice = await screen.findByTestId('sales-import-apply-notice');
    expect(notice).toHaveTextContent('Nothing was applied: October 2026 is closed. The preview has been refreshed');
    expect(notice.textContent).not.toContain('..');
    expect(apiMock.preview).toHaveBeenCalledTimes(2);
  });

  // ── Background apply jobs (owner 2026-11-18): the POST records a job (202); the page follows it. With no clear answer
  //    the click is looked up by its requestId — never guessed from "last applied" (audit H1 / M4).
  const job = (over: Partial<SalesApplyJobDto> = {}, months: Array<Partial<SalesApplyJobDto['months'][number]>> = [{}]): SalesApplyJobDto => ({
    id: 'job1', kind: 'APPLY', importId: 'imp1', requestId: 'rq', status: 'QUEUED', requestedBy: 'Asha',
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, attempts: 0,
    months: months.map((m) => ({ month: '2026-10', status: 'QUEUED', startedAt: null, finishedAt: null, result: null, lastError: null, ...m })),
    ...over,
  });
  const DONE_OCT = { status: 'DONE' as const, result: { month: '2026-10', ok: true, applyId: 'a1', outletsWritten: 3, outletsZeroFilled: 1 } };
  const enqueued = (j: SalesApplyJobDto) => ok({ job: j, results: [] });

  async function clickApply() {
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
  }

  it('Apply → 202 job: sends a requestId, shows Queued → Applying → the result card; Apply held meanwhile', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue(enqueued(job()));
    apiMock.getApplyJob
      .mockResolvedValueOnce(ok(job({ status: 'RUNNING' }, [{ status: 'RUNNING', startedAt: new Date().toISOString() }])))
      .mockResolvedValue(ok(job({ status: 'DONE' }, [DONE_OCT])));
    render(<Page />);
    await clickApply();
    expect(apiMock.apply).toHaveBeenCalledWith('imp1', expect.objectContaining({ months: ['2026-10'], requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) }));
    const panel = await screen.findByTestId('sales-import-job');
    expect(panel).toHaveTextContent('Queued — waiting its turn for the processor');
    expect(panel).toHaveTextContent('Started by Asha');
    expect(screen.getByTestId('sales-import-apply')).toBeDisabled();
    expect(screen.getByTestId('sales-import-apply')).toHaveAttribute('aria-describedby', 'sales-import-apply-why');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByTestId('sales-import-job-months')).toHaveTextContent(/October 2026: applying \(started/);
    expect(screen.getByTestId('sales-import-live')).toHaveTextContent(/October 2026: applying/);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(await screen.findByTestId('sales-import-apply-results')).toHaveTextContent('October 2026: applied');
    expect(screen.getByTestId('sales-import-apply-results')).toHaveTextContent('3 outlets updated, 1 set to 0');
    expect(screen.queryByTestId('sales-import-job')).not.toBeInTheDocument();
    expect(apiMock.apply).toHaveBeenCalledTimes(1);
  });

  it('a FAILED month of the job is shown with its reason and stays ticked for another try', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue(enqueued(job({ status: 'DONE' }, [{ status: 'FAILED', result: { month: '2026-10', ok: false, error: 'October 2026 is CLOSED.' } }])));
    render(<Page />);
    await clickApply();
    const results = await screen.findByTestId('sales-import-apply-results');
    expect(results).toHaveTextContent('October 2026: not applied');
    expect(results).toHaveTextContent('October 2026 is CLOSED.');
    expect(screen.getByRole('checkbox', { name: 'Apply October 2026' })).toBeChecked();
  });

  it('no clear answer (cut-off 500) → looks the click up by requestId → found: follows THAT job, never a second apply', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: '', status: 500 });
    apiMock.findApplyJob.mockResolvedValue(ok(job({ status: 'DONE' }, [DONE_OCT])));
    render(<Page />);
    await clickApply();
    expect(await screen.findByTestId('sales-import-apply-results')).toHaveTextContent('October 2026: applied');
    expect(apiMock.findApplyJob).toHaveBeenCalledWith(apiMock.apply.mock.calls[0][1].requestId);
    expect(screen.getByTestId('sales-import-apply-notice')).toHaveTextContent(/first reply didn.t come through, but the apply was recorded/);
    expect(screen.queryByText(/Nothing was applied/)).not.toBeInTheDocument();
    expect(apiMock.apply).toHaveBeenCalledTimes(1);
  });

  it('no clear answer and the lookup says the click recorded nothing (404) → "Nothing was applied" + Try again resends the SAME requestId', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValueOnce({ success: false, error: 'Failed to fetch' }).mockResolvedValue(enqueued(job({ status: 'DONE' }, [DONE_OCT])));
    apiMock.findApplyJob.mockResolvedValue({ success: false, error: 'No apply was recorded for this request.', status: 404 });
    render(<Page />);
    await clickApply();
    const notice = await screen.findByTestId('sales-import-apply-notice');
    expect(notice).toHaveTextContent('Nothing was applied: the server could not be reached, and nothing was recorded for this click. Try again.');
    expect(notice.textContent).not.toMatch(/in time/); // M5: an offline browser is not a timeout
    await act(async () => { fireEvent.click(within(notice).getByRole('button', { name: 'Try again' })); });
    expect(apiMock.apply).toHaveBeenCalledTimes(2);
    expect(apiMock.apply.mock.calls[1][1].requestId).toBe(apiMock.apply.mock.calls[0][1].requestId);
    expect(await screen.findByTestId('sales-import-apply-results')).toHaveTextContent('October 2026: applied');
  });

  it('no clear answer and the lookup ALSO fails → unknown: Apply disabled, "Don’t apply again yet", Check again settles it', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: '', status: 504 });
    apiMock.findApplyJob.mockResolvedValueOnce({ success: false, error: '', status: 503 }).mockResolvedValue(ok(job({ status: 'DONE' }, [DONE_OCT])));
    render(<Page />);
    await clickApply();
    const unknown = await screen.findByTestId('sales-import-apply-unknown');
    expect(unknown).toHaveAttribute('role', 'alert');
    expect(unknown).toHaveTextContent(/couldn.t confirm whether this apply was recorded: the server didn.t reply in time/);
    expect(unknown).toHaveTextContent(/Don.t apply again yet/);
    expect(screen.getByTestId('sales-import-apply')).toBeDisabled();
    await act(async () => { fireEvent.click(within(unknown).getByRole('button', { name: 'Check again' })); });
    expect(await screen.findByTestId('sales-import-apply-results')).toHaveTextContent('October 2026: applied');
    expect(screen.queryByTestId('sales-import-apply-unknown')).not.toBeInTheDocument();
    expect(apiMock.apply).toHaveBeenCalledTimes(1);
  });

  it('shows "Checking what happened…" while the lookup runs', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    let release: (v: unknown) => void = () => {};
    apiMock.apply.mockResolvedValue({ success: false, error: '', status: 502 });
    apiMock.findApplyJob.mockImplementation(() => new Promise((res) => { release = res; }));
    render(<Page />);
    await clickApply();
    expect(await screen.findByTestId('sales-import-apply-checking')).toHaveTextContent('Checking what happened');
    expect(screen.getByTestId('sales-import-apply')).toBeDisabled();
    await act(async () => { release(ok(job({ status: 'DONE' }, [DONE_OCT]))); });
    expect(screen.queryByTestId('sales-import-apply-checking')).not.toBeInTheDocument();
  });

  it('refresh-safe / another admin: a month already being applied is shown as such — progress followed, month cannot be ticked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const active = { jobId: 'job9', kind: 'APPLY' as const, status: 'RUNNING' as const, importId: 'imp1', requestedBy: 'Ravi', createdAt: new Date().toISOString() };
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview
      .mockResolvedValueOnce(ok(preview([month({ activeJob: active, canApply: false, blockedReason: 'October 2026 is being applied by Ravi since 10:32. Wait for it to finish.' })])))
      .mockResolvedValue(ok(preview([month()])));
    apiMock.getApplyJob
      .mockResolvedValueOnce(ok(job({ id: 'job9', status: 'RUNNING', requestedBy: 'Ravi' }, [{ status: 'RUNNING', startedAt: new Date().toISOString() }])))
      .mockResolvedValue(ok(job({ id: 'job9', status: 'DONE', requestedBy: 'Ravi' }, [DONE_OCT])));
    render(<Page />);
    const box = await screen.findByRole('checkbox', { name: 'Apply October 2026' });
    expect(box).toBeDisabled();
    expect(screen.getByText(/being applied by Ravi since 10:32/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(await screen.findByTestId('sales-import-job')).toHaveTextContent('Started by Ravi');
    expect(apiMock.getApplyJob).toHaveBeenCalledWith('job9');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(await screen.findByTestId('sales-import-apply-results')).toHaveTextContent('October 2026: applied');
    expect(apiMock.apply).not.toHaveBeenCalled();
  });

  it('409 (the month is being applied by someone else) → "Nothing was applied: …" with the server reason, preview refreshed', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: 'October 2026 is being applied by Ravi since 10:32. Wait for it to finish, then check the result before applying again.', status: 409 });
    render(<Page />);
    await clickApply();
    expect(await screen.findByTestId('sales-import-apply-notice')).toHaveTextContent('Nothing was applied: October 2026 is being applied by Ravi since 10:32');
    expect(apiMock.preview).toHaveBeenCalledTimes(2);
    expect(apiMock.findApplyJob).not.toHaveBeenCalled();
  });

  it('L10: a 2xx without a usable body is treated as no clear answer (looked up), never a crash or a stuck spinner', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: true, data: undefined });
    apiMock.findApplyJob.mockResolvedValue(ok(job({ status: 'DONE' }, [DONE_OCT])));
    render(<Page />);
    await clickApply();
    expect(await screen.findByTestId('sales-import-apply-results')).toHaveTextContent('October 2026: applied');
  });

  it('an old (synchronous) API answer during a deploy is still shown as results', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue(ok({ results: [{ month: '2026-10', ok: true, outletsWritten: 2, outletsZeroFilled: 0 }] }));
    render(<Page />);
    await clickApply();
    expect(await screen.findByTestId('sales-import-apply-results')).toHaveTextContent('2 outlets updated');
  });

  it('an empty error never renders "Nothing was applied: ." (4xx with no message)', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: '', status: 409 });
    render(<Page />);
    await clickApply();
    const notice = await screen.findByTestId('sales-import-apply-notice');
    expect(notice.textContent).not.toMatch(/: \./);
    expect(notice).toHaveTextContent('Nothing was applied: the server refused it without giving a reason.');
  });

  it('reprocess with no clear answer does not claim "Not reprocessed"', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ status: 'FAILED', error: 'Bad' })));
    apiMock.reprocess.mockResolvedValue({ success: false, error: '', status: 502 });
    render(<Page />);
    await screen.findByTestId('sales-import-failed');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Reprocess/ })); });
    const alert = await screen.findByText(/couldn.t confirm whether/i);
    expect(alert.textContent).not.toMatch(/Not reprocessed/);
    expect(alert.textContent).toMatch(/error 502/);
  });

  it('the Refresh preview button reloads the preview', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    await screen.findByTestId('sales-import-preview');
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-refresh-preview')); });
    expect(apiMock.preview).toHaveBeenCalledTimes(2);
  });

  it('older data: shows this file vs the applied range, explains the roll-back without hover', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({
      lastDate: '2026-10-20', warnings: ['OLDER_THAN_LAST_APPLIED'],
      lastApplied: { importId: 'new1', at: '2026-11-02T10:00:00.000Z', byName: 'Ravi', lastInvoiceDate: '2026-10-31' },
    })])));
    render(<Page />);
    expect(await screen.findByTestId('last-applied-2026-10')).toHaveTextContent('Applied now: up to 31 Oct');
    expect(screen.getByTestId('month-warnings-2026-10')).toHaveTextContent(/stop on 20 Oct.*goes up to 31 Oct.*roll the month back/);
  });

  it('REPLACES_MANUAL_VALUES is explained without hover', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ warnings: ['REPLACES_MANUAL_VALUES'] })])));
    render(<Page />);
    expect(await screen.findByTestId('month-warnings-2026-10')).toHaveTextContent(/manual achievement upload/);
  });

  it('zero KPIs → Apply disabled with the reason', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ kpis: [] })])));
    render(<Page />);
    await screen.findByTestId('sales-import-preview');
    expect(screen.getByTestId('sales-import-apply')).toBeDisabled();
    expect(screen.getByTestId('sales-import-apply-blockers')).toHaveTextContent('No KPIs are set up for Sales Import');
  });

  it('without targets:upload: no Apply / Reprocess / Delete, months cannot be ticked', async () => {
    perms.granted = false;
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    expect(await screen.findByTestId('sales-import-apply-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('sales-import-apply')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reprocess|Delete/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Apply October 2026' })).toBeDisabled();
  });

  it('expanding a month shows per-KPI new / stored / change', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: /October 2026/ }));
    const row = screen.getByText('KPI X').closest('tr')!;
    expect(row).toHaveTextContent('₹1,200');
    expect(row).toHaveTextContent('₹1,000');
    expect(row).toHaveTextContent('+₹200');
  });

  it('a successful apply refreshes the import detail too', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue(ok({ results: [{ month: '2026-10', ok: true, outletsWritten: 1, outletsZeroFilled: 0 }] }));
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    const before = apiMock.get.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    await screen.findByTestId('sales-import-apply-results');
    expect(apiMock.get.mock.calls.length).toBeGreaterThan(before);
  });

  it('apply 4xx whose preview reload FAILS says so (never "refreshed") and shows the preview error', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValueOnce(ok(preview([month()]))).mockResolvedValue({ success: false, error: 'HTTP 503', status: 503 });
    apiMock.apply.mockResolvedValue({ success: false, error: 'Definitions changed', status: 409 });
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    const before = apiMock.get.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    const notice = await screen.findByTestId('sales-import-apply-notice');
    expect(notice).toHaveTextContent('could not be refreshed');
    expect(notice).not.toHaveTextContent('has been refreshed');
    expect(screen.getByTestId('sales-import-preview-error')).toHaveTextContent('the server didn’t give a clear answer (error 503)');
    expect(screen.getByTestId('sales-import-preview')).toBeInTheDocument(); // the old preview stays visible
    expect(apiMock.get.mock.calls.length).toBeGreaterThan(before);
  });

  it('apply 403 explains the missing permission', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: 'Forbidden', status: 403 });
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    expect(await screen.findByTestId('sales-import-apply-notice')).toHaveTextContent('permission to apply sales files');
  });

  it('applied import with a changed mapping offers "Read again as a new import" and opens the new one', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ applied: true, canReprocess: false, canDelete: false, canReprocessAsNew: true })));
    apiMock.preview.mockResolvedValue(ok(preview([month({ canApply: false })], { mappingChanged: true })));
    apiMock.reprocessAsNew.mockResolvedValue(ok(detail({ id: 'new9', status: 'QUEUED', reprocessedFromId: 'imp1' })));
    render(<Page />);
    const banner = await screen.findByTestId('sales-import-mapping-changed');
    expect(banner).toHaveTextContent('read the same file again as a new import');
    expect(within(banner).queryByRole('button', { name: /^Reprocess$/ })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(within(banner).getByTestId('sales-import-reprocess-as-new-banner')); });
    expect(apiMock.reprocessAsNew).toHaveBeenCalledWith('imp1');
    expect(push).toHaveBeenCalledWith('/admin/sales-import/new9');
  });

  it('an import created by reprocess-as-new links back to the original', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ reprocessedFromId: 'orig1' })));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    const b = await screen.findByTestId('sales-import-reprocessed-from');
    expect(within(b).getByRole('link', { name: /original import/ })).toHaveAttribute('href', '/admin/sales-import/orig1');
  });

  it('without upload / settings permission the copy never tells the user to press Reprocess or set up the mapping', async () => {
    perms.granted = false;
    perms.config = false;
    apiMock.get.mockResolvedValue(ok(detail({ status: 'NEEDS_MAPPING', detectedHeaders: [['CUST']] })));
    render(<Page />);
    const card = await screen.findByTestId('sales-import-needs-mapping');
    expect(card).not.toHaveTextContent(/press Reprocess/);
    expect(within(card).queryByRole('link', { name: /Set up column mapping/ })).not.toBeInTheDocument();
    expect(card).toHaveTextContent(/Ask someone who can change the Sales Import settings/);
  });

  it('FAILED without upload permission does not say "press Reprocess"', async () => {
    perms.granted = false;
    apiMock.get.mockResolvedValue(ok(detail({ status: 'FAILED', error: 'Bad file.' })));
    render(<Page />);
    const b = await screen.findByTestId('sales-import-failed');
    expect(b).not.toHaveTextContent(/press Reprocess/);
    expect(b.textContent).not.toContain('..');
  });

  it('a cancelled / deleted import does not blame retention', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ status: 'CANCELLED', purgedAt: '2026-11-03T10:00:00.000Z', canDelete: false })));
    render(<Page />);
    expect(await screen.findByTestId('sales-import-cancelled')).toHaveTextContent('cancelled or deleted, and its file was removed');
    expect(screen.queryByTestId('sales-import-purged')).not.toBeInTheDocument();
  });

  it('no "same file as an earlier upload" banner when the duplicate is this import\'s reprocess-as-new parent', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ duplicateOfId: 'orig1', reprocessedFromId: 'orig1' })));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    await screen.findByTestId('sales-import-reprocessed-from');
    expect(screen.queryByTestId('sales-import-duplicate')).not.toBeInTheDocument();
  });

  it('skipped rows: the server reason is shown and the note names the 200-character product-value limit', async () => {
    apiMock.get.mockResolvedValue(ok(detail({
      rowsSkipped: 1,
      errorSamples: [{ row: 7, column: 'BRAND', reason: 'product value longer than 200 characters' }],
    })));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    expect(await screen.findByText('product value longer than 200 characters')).toBeInTheDocument();
    expect(screen.getByTestId('skip-reasons-note')).toHaveTextContent('a product value longer than 200 characters');
  });
});

describe('import detail — dual-audit fixes (background jobs)', () => {
  const job = (over: Partial<SalesApplyJobDto> = {}, months: Array<Partial<SalesApplyJobDto['months'][number]>> = [{}]): SalesApplyJobDto => ({
    id: 'job1', kind: 'APPLY', importId: 'imp1', requestId: 'rq', status: 'QUEUED', requestedBy: 'Asha',
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, attempts: 0,
    months: months.map((m) => ({ month: '2026-10', status: 'QUEUED', startedAt: null, finishedAt: null, result: null, lastError: null, ...m })),
    ...over,
  });
  const DONE_OCT = { status: 'DONE' as const, result: { month: '2026-10', ok: true, applyId: 'a1', outletsWritten: 3, outletsZeroFilled: 1 } };
  const active = (over = {}) => ({ jobId: 'job9', kind: 'APPLY' as const, status: 'RUNNING' as const, importId: 'imp1', requestedBy: 'Ravi', createdAt: new Date().toISOString(), ...over });

  async function clickApply() {
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
  }

  it('B-H1: coming back after a job ended shows its result card (who / when / reason) from the month’s lastJob', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({
      lastJob: { jobId: 'j0', kind: 'APPLY', status: 'FAILED', importId: 'imp1', requestedBy: 'Ravi', createdAt: '2026-11-17T05:00:00.000Z',
        finishedAt: '2026-11-17T05:02:00.000Z', result: { month: '2026-10', ok: false, error: 'October 2026 is CLOSED.' } },
    })])));
    render(<Page />);
    const card = await screen.findByTestId('last-result-2026-10');
    expect(card).toHaveTextContent('October 2026: not applied');
    expect(card).toHaveTextContent(/By Ravi, finished 17 Nov, 10:32\. October 2026 is CLOSED\./);
  });

  it('B-M6: the job’s end is announced in the live region with each month’s result', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue(ok({ job: job({ status: 'DONE' }, [DONE_OCT]), results: [] }));
    render(<Page />);
    await clickApply();
    await screen.findByTestId('sales-import-apply-results');
    expect(screen.getByTestId('sales-import-live')).toHaveTextContent('Apply finished. October 2026: applied.');
  });

  it('B-L10: after the confirm, focus moves to the outcome area', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: 'October 2026 is closed.', status: 409 });
    render(<Page />);
    await clickApply();
    await screen.findByTestId('sales-import-apply-notice');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('sales-import-outcome')));
  });

  it('A-L6 / B-M8: while an apply of this file runs, Reprocess / Read again / Cancel / Delete are disabled with the reason', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ canCancel: true, canDelete: true, canReprocess: true })));
    apiMock.preview.mockResolvedValue(ok(preview([month({ activeJob: active(), canApply: false, blockedReason: 'busy' })])));
    apiMock.getApplyJob.mockResolvedValue(ok(job({ id: 'job9', status: 'RUNNING', requestedBy: 'Ravi' }, [{ status: 'RUNNING' }])));
    render(<Page />);
    const why = await screen.findByTestId('sales-import-held-why');
    expect(why).toHaveTextContent(/apply of this file is running \(started by Ravi at/);
    for (const b of [screen.getByTestId('sales-import-cancel'), screen.getByRole('button', { name: /Reprocess/ }), screen.getByRole('button', { name: /Delete/ })]) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('aria-describedby', 'sales-import-held-why');
    }
  });

  it('B-L1: a job handed back after a restart says it will continue, not "queued"', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue(ok({ job: job({ status: 'QUEUED', attempts: 1 }), results: [] }));
    apiMock.getApplyJob.mockResolvedValue(ok(job({ status: 'QUEUED', attempts: 1 })));
    render(<Page />);
    await clickApply();
    expect(await screen.findByTestId('sales-import-job')).toHaveTextContent(/Waiting to continue — the processor was restarted/);
  });

  it('B-L5: when the shown job has ended, a LATER job on the same file (another admin) is followed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview
      .mockResolvedValueOnce(ok(preview([month()])))
      .mockResolvedValue(ok(preview([month({ activeJob: active({ jobId: 'job2', requestedBy: 'Ravi' }), canApply: false, blockedReason: 'busy' })])));
    apiMock.apply.mockResolvedValue(ok({ job: job({ status: 'DONE' }, [DONE_OCT]), results: [] }));
    apiMock.getApplyJob.mockResolvedValue(ok(job({ id: 'job2', status: 'RUNNING', requestedBy: 'Ravi' }, [{ status: 'RUNNING' }])));
    render(<Page />);
    await clickApply();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(apiMock.getApplyJob).toHaveBeenCalledWith('job2');
    expect(await screen.findByTestId('sales-import-job')).toHaveTextContent('Started by Ravi');
  });

  it('B-L8: an unknown outcome survives a reload — Apply stays held and Check again is offered', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: '', status: 504 });
    apiMock.findApplyJob.mockResolvedValue({ success: false, error: '', status: 503 });
    const first = render(<Page />);
    await clickApply();
    await screen.findByTestId('sales-import-apply-unknown');
    first.unmount();
    render(<Page />);
    expect(await screen.findByTestId('sales-import-apply-unknown')).toHaveTextContent(/Don.t apply again yet/);
    expect(screen.getByTestId('sales-import-apply')).toBeDisabled();
  });

  it('B-M1: "Read again as a new import" whose success reply carries no id says so instead of crashing', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ applied: true, canReprocess: false, canDelete: false, canReprocessAsNew: true })));
    apiMock.preview.mockResolvedValue(ok(preview([month({ canApply: false })], { mappingChanged: true })));
    apiMock.reprocessAsNew.mockResolvedValue({ success: true, data: undefined });
    render(<Page />);
    const btn = await screen.findByTestId('sales-import-reprocess-as-new');
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByText(/A new import was started, but its link was not received/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
