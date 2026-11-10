/// <reference types="vitest/globals" />
/**
 * /admin/sales-import/[id] — polling, preview, acks, apply, 409 refresh (SALES-IMPORT-PIPELINE-PLAN §11 F-4).
 * API mocked (backend lanes build in parallel).
 * Run: npx vitest run src/app/admin/sales-import/__tests__/import-detail.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { MonthPreview, SalesImportDetail, SalesImportPreview } from '@/lib/sales-import/types';

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
    lastApplied: null, ...over,
  };
}

function preview(months: MonthPreview[], over: Partial<SalesImportPreview> = {}): SalesImportPreview {
  return {
    importId: 'imp1', definitionsHash: 'h1', processingVersion: 7, mappingChanged: false, rosterOutletsAddedSinceProcessing: 0,
    months, ...over,
  };
}

const ok = <T,>(data: T) => ({ success: true as const, data });

beforeEach(() => {
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
      months: ['2026-10'], expectedDefinitionsHash: 'h1', processingVersion: 7, acknowledgePartialMonths: ['2026-10'],
    });
    expect(await screen.findByTestId('sales-import-apply-results')).toHaveTextContent('3 outlets updated, 1 set to 0');
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

  it('a 5xx from Apply does not pretend the preview was refreshed', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    apiMock.apply.mockResolvedValue({ success: false, error: 'HTTP 502', status: 502 });
    render(<Page />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    expect(await screen.findByTestId('sales-import-apply-notice')).toHaveTextContent('Try again in a moment');
    expect(apiMock.preview).toHaveBeenCalledTimes(1);
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
    expect(screen.getByTestId('sales-import-preview-error')).toHaveTextContent('HTTP 503');
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
});
