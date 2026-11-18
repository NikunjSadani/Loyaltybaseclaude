/// <reference types="vitest/globals" />
/**
 * apply-job — following background Apply / Recalculate jobs (owner 2026-11-18; dual audit of e1ce98d8).
 * Run: npx vitest run src/lib/sales-import/__tests__/apply-job.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SalesApplyJobDto } from '../types';

const apiMock = vi.hoisted(() => ({ getApplyJob: vi.fn(), findApplyJob: vi.fn() }));
vi.mock('../api', () => ({ salesImportApi: apiMock }));

import {
  NO_JOB_FOR_REQUEST, clearUnknown, jobHeadline, loadUnknown, lookUp, saveUnknown, useJobFollower, whenLabel,
} from '../apply-job';

const job = (over: Partial<SalesApplyJobDto> = {}): SalesApplyJobDto => ({
  id: 'j1', kind: 'APPLY', importId: 'imp1', requestId: 'rq', status: 'RUNNING', requestedBy: 'Asha',
  createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, attempts: 1,
  months: [{ month: '2026-10', status: 'RUNNING', startedAt: null, finishedAt: null, result: null, lastError: null }], ...over,
});
const ok = <T,>(data: T) => ({ success: true as const, data });

beforeEach(() => { apiMock.getApplyJob.mockReset(); apiMock.findApplyJob.mockReset(); window.sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe('lookUp (A-M4 / B-M9)', () => {
  it('found → the job', async () => {
    apiMock.findApplyJob.mockResolvedValue(ok(job()));
    expect(await lookUp('rq', 'why', 0)).toEqual(expect.objectContaining({ kind: 'job', afterNoAnswer: true }));
  });
  it('A-M4: a 404 WITHOUT the server’s own "nothing recorded" text (e.g. an API from before this release) is UNKNOWN, never "nothing recorded"', async () => {
    apiMock.findApplyJob.mockResolvedValue({ success: false, error: 'Cannot GET /v1/admin/sales-import/apply-jobs', status: 404 });
    expect(await lookUp('rq', 'why', 0)).toEqual({ kind: 'unknown', reason: 'why' });
  });
  it('B-M9: "nothing recorded" is only said after a SECOND lookup ~5 s later; a job that lands meanwhile is followed', async () => {
    vi.useFakeTimers();
    apiMock.findApplyJob.mockResolvedValueOnce({ success: false, error: NO_JOB_FOR_REQUEST, status: 404 }).mockResolvedValue(ok(job()));
    const p = lookUp('rq', 'why');
    await vi.advanceTimersByTimeAsync(4999);
    expect(apiMock.findApplyJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual(expect.objectContaining({ kind: 'job' }));
    apiMock.findApplyJob.mockReset();
    apiMock.findApplyJob.mockResolvedValue({ success: false, error: NO_JOB_FOR_REQUEST, status: 404 });
    const q = lookUp('rq', 'why');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await q).toEqual({ kind: 'not-recorded', reason: 'why' });
    expect(apiMock.findApplyJob).toHaveBeenCalledTimes(2);
  });
});

describe('useJobFollower', () => {
  it('B-L6: onEnded fires ONCE per job, however often it is followed', async () => {
    const onEnded = vi.fn();
    const { result } = renderHook(() => useJobFollower(onEnded));
    const done = job({ status: 'DONE' });
    act(() => { result.current.follow('j1', done); result.current.follow('j1', done); result.current.follow('j1'); });
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(apiMock.getApplyJob).not.toHaveBeenCalled();
  });

  it.each([
    [401, /session has expired/],
    [403, /no longer have access/],
    [404, /could not be found any more/],
  ])('B-M5: a %s while following stops with a clear message (no more polls)', async (status, text) => {
    vi.useFakeTimers();
    apiMock.getApplyJob.mockResolvedValue({ success: false, error: 'x', status });
    const { result } = renderHook(() => useJobFollower(vi.fn()));
    act(() => { result.current.follow('j1'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.problems.j1).toEqual({ final: true, text: expect.stringMatching(text) });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiMock.getApplyJob).toHaveBeenCalledTimes(1);
  });

  it('B-M5: other failures are per job, retried, and cleared once a poll lands', async () => {
    vi.useFakeTimers();
    apiMock.getApplyJob.mockResolvedValueOnce({ success: false, error: '', status: 502 }).mockResolvedValue(ok(job()));
    const { result } = renderHook(() => useJobFollower(vi.fn()));
    act(() => { result.current.follow('j1'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.problems.j1).toEqual({ final: false, text: expect.stringMatching(/still trying/) });
    expect(result.current.problems.j2).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(result.current.problems.j1).toBeUndefined();
  });

  it('B-L9: no polls while the tab is hidden; polling resumes when it is shown', async () => {
    vi.useFakeTimers();
    let state: DocumentVisibilityState = 'hidden';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    apiMock.getApplyJob.mockResolvedValue(ok(job()));
    const { result } = renderHook(() => useJobFollower(vi.fn()));
    act(() => { result.current.follow('j1'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(apiMock.getApplyJob).not.toHaveBeenCalled();
    state = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(apiMock.getApplyJob).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('labels and the unknown lock', () => {
  it('B-L11: whenLabel shows the date when it is not today (India time)', () => {
    const now = new Date('2026-11-18T08:00:00.000Z');
    expect(whenLabel('2026-11-18T05:02:00.000Z', now)).toBe('10:32');
    expect(whenLabel('2026-11-17T05:02:00.000Z', now)).toBe('17 Nov, 10:32');
  });
  it('B-L1 / B-L2: a queued job says it waits its turn; one handed back after a restart says it will continue', () => {
    expect(jobHeadline(job({ status: 'QUEUED', attempts: 0 }))).toBe('Queued — waiting its turn for the processor');
    expect(jobHeadline(job({ status: 'QUEUED', attempts: 1 }))).toMatch(/^Waiting to continue — the processor was restarted/);
  });
  it('B-L8: the unknown lock round-trips through sessionStorage and is cleared', () => {
    saveUnknown('k', { requestId: 'rq', reason: 'why', months: ['2026-10'] });
    expect(loadUnknown('k')).toEqual({ requestId: 'rq', reason: 'why', months: ['2026-10'] });
    clearUnknown('k');
    expect(loadUnknown('k')).toBeNull();
    window.sessionStorage.setItem('k', '{bad');
    expect(loadUnknown('k')).toBeNull();
  });
});
