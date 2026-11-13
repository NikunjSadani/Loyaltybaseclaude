/**
 * Downloads page body — statuses in plain words, Download only when Ready, auto-refresh only while
 * something is Waiting/Preparing (paused when the tab is hidden), empty / error states, Load more.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { ExportRequestDto } from '@/lib/exports/types';

const fetchExportList = vi.fn();
const downloadPreparedFile = vi.fn();
vi.mock('@/lib/exports/download', () => ({
  fetchExportList: (...a: unknown[]) => fetchExportList(...a),
  downloadPreparedFile: (...a: unknown[]) => downloadPreparedFile(...a),
}));

import { DownloadsPanel, DOWNLOADS_POLL_MS, displayStatus } from '../downloads-panel';

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function item(over: Partial<ExportRequestDto>): ExportRequestDto {
  return {
    id: 'e1',
    kind: 'outlet-master',
    label: 'Outlet master',
    paramsSummary: 'All outlets',
    status: 'READY',
    fileName: 'outlet-master.xlsx',
    sizeBytes: 2_500_000,
    rowCount: 6491,
    error: null,
    createdAt: iso(-60_000),
    startedAt: iso(-50_000),
    finishedAt: iso(-10_000),
    expiresAt: iso(7 * DAY),
    ...over,
  };
}

const ok = (items: ExportRequestDto[], nextCursor: string | null = null) =>
  Promise.resolve({ ok: true, data: { items, nextCursor } });

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  fetchExportList.mockReset();
  downloadPreparedFile.mockReset();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => { vi.useRealTimers(); });

describe('DownloadsPanel', () => {
  it('shows each status in plain words; Download only on Ready rows', async () => {
    fetchExportList.mockImplementation(() => ok([
      item({ id: 'r', status: 'READY', label: 'Ready report' }),
      item({ id: 'q', status: 'QUEUED', label: 'Queued report', finishedAt: null, expiresAt: null, sizeBytes: null, rowCount: null }),
      item({ id: 'p', status: 'RUNNING', label: 'Running report', finishedAt: null, expiresAt: null }),
      item({ id: 'f', status: 'FAILED', label: 'Failed report', error: 'The period has no data.', expiresAt: null }),
      item({ id: 'x', status: 'EXPIRED', label: 'Expired report' }),
      item({ id: 'old', status: 'READY', label: 'Past expiry', expiresAt: iso(-DAY) }),
    ]));
    render(<DownloadsPanel />);

    const ready = await screen.findByTestId('download-row-r');
    expect(within(ready).getByText('Ready')).toBeInTheDocument();
    expect(within(ready).getByText(/available until/i)).toBeInTheDocument();
    expect(within(ready).getByText('2.4 MB')).toBeInTheDocument();
    expect(within(ready).getByRole('button', { name: /download ready report/i })).toBeInTheDocument();

    expect(within(screen.getByTestId('download-row-q')).getByText('Waiting to start')).toBeInTheDocument();
    expect(within(screen.getByTestId('download-row-p')).getByText('Preparing')).toBeInTheDocument();
    const failed = screen.getByTestId('download-row-f');
    expect(within(failed).getByText('Failed')).toBeInTheDocument();
    expect(within(failed).getByText('The period has no data.')).toBeInTheDocument();
    expect(within(screen.getByTestId('download-row-x')).getByText('Expired')).toBeInTheDocument();
    // A READY file past its expiry is shown as Expired, without a Download button.
    expect(within(screen.getByTestId('download-row-old')).getByText('Expired')).toBeInTheDocument();

    // Only the one live READY row offers Download.
    expect(screen.getAllByRole('button', { name: /^download /i })).toHaveLength(1);
  });

  it('Download fetches the prepared file; a gone file shows the reason and refreshes the list', async () => {
    fetchExportList.mockImplementation(() => ok([item({ id: 'r' })]));
    downloadPreparedFile.mockResolvedValueOnce({ kind: 'downloaded', fileName: 'outlet-master.xlsx' });
    render(<DownloadsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /download outlet master/i }));
    await waitFor(() => expect(downloadPreparedFile).toHaveBeenCalledWith('r', 'outlet-master.xlsx'));

    downloadPreparedFile.mockResolvedValueOnce({ kind: 'error', status: 410, message: 'This file has expired. Please request it again.' });
    const callsBefore = fetchExportList.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /download outlet master/i }));
    expect(await screen.findByText('This file has expired. Please request it again.')).toBeInTheDocument();
    await waitFor(() => expect(fetchExportList.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('empty state', async () => {
    fetchExportList.mockImplementation(() => ok([]));
    render(<DownloadsPanel />);
    expect(await screen.findByTestId('downloads-empty')).toHaveTextContent(/no downloads yet/i);
  });

  it('error state with a working Try again', async () => {
    fetchExportList.mockResolvedValueOnce({ ok: false, message: "Downloads aren't set up on this server yet" });
    fetchExportList.mockImplementation(() => ok([]));
    render(<DownloadsPanel />);
    const err = await screen.findByTestId('downloads-error');
    expect(err).toHaveTextContent("Downloads aren't set up on this server yet");
    fireEvent.click(within(err).getByRole('button', { name: /try again/i }));
    expect(await screen.findByTestId('downloads-empty')).toBeInTheDocument();
  });

  it('Load more appends the next page with the cursor', async () => {
    fetchExportList.mockImplementation((cursor: string | null) =>
      cursor === 'c2'
        ? ok([item({ id: 'b', label: 'Second page report' })], null)
        : ok([item({ id: 'a', label: 'First page report' })], 'c2'));
    render(<DownloadsPanel />);
    await screen.findByTestId('download-row-a');
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByTestId('download-row-b')).toBeInTheDocument();
    expect(fetchExportList).toHaveBeenLastCalledWith('c2');
    expect(screen.getByTestId('download-row-a')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('auto-refreshes while something is preparing, and stops once nothing is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchExportList
      .mockImplementationOnce(() => ok([item({ id: 'p', status: 'RUNNING', finishedAt: null, expiresAt: null })]))
      .mockImplementation(() => ok([item({ id: 'p', status: 'READY' })]));
    render(<DownloadsPanel />);
    await act(async () => { await Promise.resolve(); });
    expect(within(screen.getByTestId('download-row-p')).getByText('Preparing')).toBeInTheDocument();
    expect(fetchExportList).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(DOWNLOADS_POLL_MS); });
    expect(fetchExportList).toHaveBeenCalledTimes(2);
    expect(within(screen.getByTestId('download-row-p')).getByText('Ready')).toBeInTheDocument();

    // Nothing active any more → no further polling.
    await act(async () => { await vi.advanceTimersByTimeAsync(DOWNLOADS_POLL_MS * 3); });
    expect(fetchExportList).toHaveBeenCalledTimes(2);
  });

  it('pauses auto-refresh while the tab is hidden and refreshes on return', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchExportList.mockImplementation(() => ok([item({ id: 'q', status: 'QUEUED', finishedAt: null, expiresAt: null })]));
    render(<DownloadsPanel />);
    await act(async () => { await Promise.resolve(); });
    expect(fetchExportList).toHaveBeenCalledTimes(1);

    act(() => { setVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(DOWNLOADS_POLL_MS * 3); });
    expect(fetchExportList).toHaveBeenCalledTimes(1);

    await act(async () => { setVisibility('visible'); await Promise.resolve(); });
    expect(fetchExportList).toHaveBeenCalledTimes(2);
  });
});

describe('displayStatus', () => {
  it('turns a READY file past its expiry into EXPIRED', () => {
    const now = Date.now();
    expect(displayStatus({ status: 'READY', expiresAt: new Date(now - 1).toISOString() }, now)).toBe('EXPIRED');
    expect(displayStatus({ status: 'READY', expiresAt: new Date(now + DAY).toISOString() }, now)).toBe('READY');
    expect(displayStatus({ status: 'RUNNING', expiresAt: null }, now)).toBe('RUNNING');
  });
});
