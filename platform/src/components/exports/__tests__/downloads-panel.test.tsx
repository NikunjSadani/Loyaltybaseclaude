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

let scope: { brandName: string | null; seenKey: string } = { brandName: 'Bajaj Consumer Care', seenKey: 'k:u1:bajaj' };
vi.mock('@/components/exports/use-downloads-scope', () => ({ useDownloadsScope: () => scope }));

import { DownloadsPanel, DOWNLOADS_POLL_MS, displayStatus, nextPollDelay, SLOW_MESSAGE } from '../downloads-panel';
import { readSeen } from '@/lib/exports/seen';

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
  scope = { brandName: 'Bajaj Consumer Care', seenKey: 'k:u1:bajaj' };
  try { window.localStorage.clear(); } catch { /* ignore */ }
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

describe('DownloadsPanel — UI/UX audit fixes', () => {
  const MIN = 60_000;

  it('H1: a request Waiting/Preparing > 15 min says "taking longer than usual"; a Failed one never does', async () => {
    fetchExportList.mockImplementation(() => ok([
      item({ id: 'slow', status: 'RUNNING', createdAt: iso(-20 * MIN), finishedAt: null, expiresAt: null }),
      item({ id: 'slowq', status: 'QUEUED', createdAt: iso(-16 * MIN), finishedAt: null, expiresAt: null }),
      item({ id: 'fresh', status: 'QUEUED', createdAt: iso(-5 * MIN), finishedAt: null, expiresAt: null }),
      item({ id: 'dead', status: 'FAILED', createdAt: iso(-30 * 60 * MIN), error: "The report couldn't start. Please request it again.", expiresAt: null }),
    ]));
    render(<DownloadsPanel />);
    const slow = await screen.findByTestId('download-row-slow');
    expect(within(slow).getByTestId('download-slow')).toHaveTextContent(SLOW_MESSAGE);
    expect(within(screen.getByTestId('download-row-slowq')).getByTestId('download-slow')).toBeInTheDocument();
    expect(within(screen.getByTestId('download-row-fresh')).queryByTestId('download-slow')).not.toBeInTheDocument();
    const dead = screen.getByTestId('download-row-dead');
    expect(within(dead).queryByTestId('download-slow')).not.toBeInTheDocument();
    expect(within(dead).getByText("The report couldn't start. Please request it again.")).toBeInTheDocument();
  });

  it('H2: names the brand; the console page explains it lists files requested outside a brand', async () => {
    fetchExportList.mockImplementation(() => ok([]));
    const { unmount } = render(<DownloadsPanel />);
    expect(await screen.findByRole('heading', { name: /downloads for bajaj consumer care/i })).toBeInTheDocument();
    expect(screen.getByTestId('downloads-scope')).toHaveTextContent(/only you can see them/i);
    unmount();
    scope = { brandName: null, seenKey: 'k:u1:platform' };
    render(<DownloadsPanel tone="dark" console />);
    expect(await screen.findByRole('heading', { name: /^downloads$/i })).toBeInTheDocument();
    expect(screen.getByTestId('downloads-scope')).toHaveTextContent(/outside a brand/i);
  });

  it('M1: a failed auto-refresh keeps retrying with backoff, and the note says so truthfully', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchExportList
      .mockImplementationOnce(() => ok([item({ id: 'p', status: 'RUNNING', finishedAt: null, expiresAt: null })]))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, message: "Couldn't reach the server." }))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, message: "Couldn't reach the server." }))
      .mockImplementation(() => ok([item({ id: 'p', status: 'READY' })]));
    render(<DownloadsPanel />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('downloads-auto-note')).toHaveTextContent(/updates by itself every 10 seconds/i);

    await act(async () => { await vi.advanceTimersByTimeAsync(DOWNLOADS_POLL_MS); });
    expect(fetchExportList).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/couldn't refresh the list/i)).toBeInTheDocument();
    expect(screen.getByTestId('downloads-auto-note')).toHaveTextContent(/try again in about 20 seconds/i);

    // Retried after the backoff (not stopped for good).
    await act(async () => { await vi.advanceTimersByTimeAsync(nextPollDelay(1)); });
    expect(fetchExportList).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('downloads-auto-note')).toHaveTextContent(/about 40 seconds/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(nextPollDelay(2)); });
    expect(fetchExportList).toHaveBeenCalledTimes(4);
    expect(within(screen.getByTestId('download-row-p')).getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText(/couldn't refresh the list/i)).not.toBeInTheDocument();
  });

  it('nextPollDelay doubles per failure and caps at 2 minutes', () => {
    expect(nextPollDelay(0)).toBe(10_000);
    expect(nextPollDelay(1)).toBe(20_000);
    expect(nextPollDelay(3)).toBe(80_000);
    expect(nextPollDelay(10)).toBe(120_000);
  });

  it('L2: announces "<report> is ready" through an always-mounted live region', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchExportList
      .mockImplementationOnce(() => ok([item({ id: 'p', status: 'RUNNING', finishedAt: null, expiresAt: null })]))
      .mockImplementation(() => ok([item({ id: 'p', status: 'READY' })]));
    render(<DownloadsPanel />);
    const region = screen.getByTestId('downloads-announcer');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(DOWNLOADS_POLL_MS); });
    expect(screen.getByTestId('downloads-announcer')).toBe(region);
    expect(region).toHaveTextContent('Outlet master is ready to download.');
  });

  it('M6: Ready files not seen before are marked New and recorded as seen (per user + brand)', async () => {
    window.localStorage.setItem('k:u1:bajaj', JSON.stringify(['old']));
    fetchExportList.mockImplementation(() => ok([item({ id: 'old', label: 'Old file' }), item({ id: 'fresh', label: 'Fresh file' })]));
    render(<DownloadsPanel />);
    const fresh = await screen.findByTestId('download-row-fresh');
    await waitFor(() => expect(within(fresh).getByTestId('download-new')).toBeInTheDocument());
    expect(within(screen.getByTestId('download-row-old')).queryByTestId('download-new')).not.toBeInTheDocument();
    expect([...readSeen('k:u1:bajaj')].sort()).toEqual(['fresh', 'old']);
  });

  it('M6: renders correctly when storage is blocked', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const spy2 = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    fetchExportList.mockImplementation(() => ok([item({ id: 'r' })]));
    render(<DownloadsPanel />);
    expect(await screen.findByRole('button', { name: /download outlet master/i })).toBeInTheDocument();
    spy.mockRestore(); spy2.mockRestore();
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
