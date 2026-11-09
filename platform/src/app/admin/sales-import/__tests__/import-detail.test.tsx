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
  get: vi.fn(), preview: vi.fn(), apply: vi.fn(), reprocess: vi.fn(), remove: vi.fn(),
  unmatchedCsvUrl: (id: string) => `/u/${id}`, errorsXlsxUrl: (id: string) => `/e/${id}`,
}));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock, fetchDownload: vi.fn() }));

import Page from '../[id]/page';

function detail(over: Partial<SalesImportDetail> = {}): SalesImportDetail {
  return {
    id: 'imp1', status: 'READY', originalFilename: 'dms.xlsx', fileKind: 'XLSX', sizeBytes: 1000, partCount: 1,
    partsReceived: 1, bytesRead: 1000, rowsRead: 50, rowsSkipped: 0, progressPct: null, duplicateOfId: null,
    error: null, detectedHeaders: null, createdAt: '2026-11-01T10:00:00.000Z', finishedAt: null, uploadedBy: 'Asha',
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
  return { importId: 'imp1', definitionsHash: 'h1', rosterHashMatches: true, months, ...over };
}

const ok = <T,>(data: T) => ({ success: true as const, data });

beforeEach(() => {
  Object.values(apiMock).forEach((f) => typeof f === 'function' && 'mockReset' in f && (f as ReturnType<typeof vi.fn>).mockReset());
  push.mockReset();
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
  it('shows a duplicate-file banner', async () => {
    apiMock.get.mockResolvedValue(ok(detail({ duplicateOfId: 'old1' })));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<Page />);
    const b = await screen.findByTestId('sales-import-duplicate');
    expect(within(b).getByRole('link', { name: /earlier import/ })).toHaveAttribute('href', '/admin/sales-import/old1');
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
      months: ['2026-10'], expectedDefinitionsHash: 'h1', acknowledgePartialMonths: ['2026-10'],
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

  it('roster changed → red banner with Reprocess', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ canApply: false, warnings: ['ROSTER_CHANGED'] })], { rosterHashMatches: false })));
    render(<Page />);
    const b = await screen.findByTestId('sales-import-roster-changed');
    expect(within(b).getByRole('button', { name: /Reprocess/ })).toBeInTheDocument();
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
});
