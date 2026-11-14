/**
 * downloadOrQueue — the one path every report download takes (DOWNLOADS-PAGE.md).
 * 200 saves the file; 202 returns "queued" (never saves the JSON as a file); 409/503/4xx → plain English.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));
let storedRole: string | null = 'CLIENT_ADMIN';
vi.mock('@/lib/auth-client', () => ({
  getStoredUser: () => (storedRole ? { id: 'u1', name: 'U', role: storedRole, phone: '' } : null),
}));

import {
  downloadOrQueue,
  fetchExportList,
  fileNameFromDisposition,
  downloadPreparedFile,
  downloadErrorMessage,
  NOT_SET_UP_STAFF_MESSAGE,
  QUEUED_MESSAGE_DEFAULT,
} from '../download';

function res(init: { status: number; json?: unknown; disposition?: string; blob?: Blob }) {
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-disposition' ? init.disposition ?? null : null) },
    json: () => (init.json === undefined ? Promise.reject(new Error('no json')) : Promise.resolve(init.json)),
    blob: () => Promise.resolve(init.blob ?? new Blob(['xlsx'])),
  };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  downloadBlob.mockReset();
  storedRole = 'CLIENT_ADMIN';
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('downloadOrQueue', () => {
  it('200 → saves the blob under the Content-Disposition file name', async () => {
    fetchMock.mockResolvedValue(res({ status: 200, disposition: 'attachment; filename="Outlet Master.xlsx"' }));
    const out = await downloadOrQueue('/api/admin/reports/outlet-master', { fallbackFileName: 'x.xlsx' });
    expect(out).toEqual({ kind: 'downloaded', fileName: 'Outlet Master.xlsx' });
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob.mock.calls[0][1]).toBe('Outlet Master.xlsx');
  });

  it('200 without a file name → uses the fallback name', async () => {
    fetchMock.mockResolvedValue(res({ status: 200 }));
    const out = await downloadOrQueue('/x', { fallbackFileName: 'fallback.xlsx' });
    expect(out).toEqual({ kind: 'downloaded', fileName: 'fallback.xlsx' });
  });

  it('202 → returns queued with the server message and saves nothing', async () => {
    fetchMock.mockResolvedValue(res({
      status: 202,
      json: { success: true, data: { exportRequestId: 'exp-1', message: 'Preparing — see Downloads.' } },
    }));
    const out = await downloadOrQueue('/x');
    expect(out).toEqual({ kind: 'queued', exportRequestId: 'exp-1', message: 'Preparing — see Downloads.' });
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('202 with no message → uses the default "we are preparing your file" text', async () => {
    fetchMock.mockResolvedValue(res({ status: 202, json: { success: true, data: { exportRequestId: 'exp-2' } } }));
    const out = await downloadOrQueue('/x');
    expect(out).toEqual({ kind: 'queued', exportRequestId: 'exp-2', message: QUEUED_MESSAGE_DEFAULT });
  });

  it('409 → the server message (or a plain default) and no download', async () => {
    fetchMock.mockResolvedValue(res({ status: 409, json: { success: false, error: 'You already have 3 downloads being prepared.' } }));
    const out = await downloadOrQueue('/x');
    expect(out).toEqual({ kind: 'error', status: 409, message: 'You already have 3 downloads being prepared.' });
    fetchMock.mockResolvedValue(res({ status: 409 }));
    const out2 = await downloadOrQueue('/x');
    expect(out2.kind === 'error' && out2.message).toMatch(/already have 3 downloads/i);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('503 → shows whichever 503 text the server sent (busy / not set up)', async () => {
    fetchMock.mockResolvedValue(res({ status: 503, json: { success: false, error: 'Server busy — try again in a minute.' } }));
    expect(await downloadOrQueue('/x')).toEqual({ kind: 'error', status: 503, message: 'Server busy — try again in a minute.' });
    fetchMock.mockResolvedValue(res({ status: 503, json: { success: false, error: "Downloads aren't set up on this server yet" } }));
    expect(await downloadOrQueue('/x')).toEqual({ kind: 'error', status: 503, message: "Downloads aren't set up on this server yet" });
  });

  it('403 without a body → a plain permission message; 500 → generic (no raw server text)', async () => {
    fetchMock.mockResolvedValue(res({ status: 403 }));
    const a = await downloadOrQueue('/x');
    expect(a.kind === 'error' && a.message).toMatch(/permission/i);
    fetchMock.mockResolvedValue(res({ status: 500, json: { error: 'Internal server error' } }));
    const b = await downloadOrQueue('/x');
    expect(b.kind === 'error' && b.message).toMatch(/something went wrong/i);
  });

  it('network failure → a plain connection message, never throws', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await downloadOrQueue('/x');
    expect(out.kind === 'error' && out.message).toMatch(/couldn't reach the server/i);
  });
});

describe('fileNameFromDisposition', () => {
  it('reads filename*, quoted and bare names', () => {
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''Target%20vs%20Sales.xlsx")).toBe('Target vs Sales.xlsx');
    expect(fileNameFromDisposition('attachment; filename="a b.xlsx"')).toBe('a b.xlsx');
    expect(fileNameFromDisposition('attachment; filename=plain.xlsx')).toBe('plain.xlsx');
    expect(fileNameFromDisposition(null)).toBeNull();
  });
});

describe('Downloads page API', () => {
  it('fetchExportList unwraps the envelope and passes the cursor', async () => {
    fetchMock.mockResolvedValue(res({ status: 200, json: { success: true, data: { items: [{ id: 'a' }], nextCursor: 'c2' } } }));
    const out = await fetchExportList('c1');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/exports?cursor=c1');
    expect(out).toEqual({ ok: true, data: { items: [{ id: 'a' }], nextCursor: 'c2' } });
  });

  it('fetchExportList surfaces a plain error', async () => {
    fetchMock.mockResolvedValue(res({ status: 503, json: { success: false, error: "Downloads aren't set up on this server yet" } }));
    expect(await fetchExportList()).toEqual({ ok: false, status: 503, message: "Downloads aren't set up on this server yet" });
  });

  it('downloadPreparedFile checks the row, then lets the BROWSER stream the file (no blob in page memory)', async () => {
    fetchMock.mockResolvedValue(res({ status: 200, json: { success: true, data: { id: 'exp 1', status: 'READY', fileName: 'Outlet Master.xlsx', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } } }));
    const clicks: { href: string; download: string }[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    const out = await downloadPreparedFile('exp 1', 'outlet-master.xlsx');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/exports/exp%201');
    expect(clicks).toEqual([{ href: '/api/admin/exports/exp%201/download', download: 'Outlet Master.xlsx' }]);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: 'downloaded', fileName: 'Outlet Master.xlsx' });
    clickSpy.mockRestore();
  });

  it('downloadPreparedFile: expired / gone / failed / not-ready → plain errors, nothing downloaded', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fetchMock.mockResolvedValue(res({ status: 200, json: { data: { status: 'READY', expiresAt: new Date(Date.now() - 1000).toISOString() } } }));
    expect(await downloadPreparedFile('a')).toEqual({ kind: 'error', status: 410, message: 'This file has expired. Please request it again.' });
    fetchMock.mockResolvedValue(res({ status: 200, json: { data: { status: 'EXPIRED' } } }));
    expect(await downloadPreparedFile('a')).toMatchObject({ kind: 'error', status: 410 });
    fetchMock.mockResolvedValue(res({ status: 404, json: { message: 'Download not found.' } }));
    expect(await downloadPreparedFile('a')).toEqual({ kind: 'error', status: 404, message: 'Download not found.' });
    fetchMock.mockResolvedValue(res({ status: 200, json: { data: { status: 'FAILED', error: 'The worker could not start.' } } }));
    expect(await downloadPreparedFile('a')).toMatchObject({ kind: 'error', message: 'The worker could not start.' });
    fetchMock.mockResolvedValue(res({ status: 200, json: { data: { status: 'RUNNING' } } }));
    expect(await downloadPreparedFile('a')).toMatchObject({ kind: 'error', status: 409 });
    expect(clickSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});

describe('503 "not set up" wording (L4)', () => {
  it('brand users are told to contact Gifsy support; Gifsy staff/admin get the technical reason', async () => {
    expect(downloadErrorMessage(503, null, { staff: false })).toMatch(/contact gifsy support/i);
    expect(downloadErrorMessage(503, null, { staff: true })).toBe(NOT_SET_UP_STAFF_MESSAGE);
    expect(downloadErrorMessage(503, "Downloads aren't set up on this server yet. Please contact Gifsy support.", { staff: true }))
      .toBe(NOT_SET_UP_STAFF_MESSAGE);
    // "couldn't start" 503: brand users keep the server text; staff never get "contact Gifsy".
    const cs = "Downloads couldn't start on the server. Please try again later or contact Gifsy.";
    expect(downloadErrorMessage(503, cs, { staff: false })).toBe(cs);
    const staffCs = downloadErrorMessage(503, cs, { staff: true });
    expect(staffCs).toMatch(/couldn't start on the server/);
    expect(staffCs).not.toMatch(/contact gifsy/i);
    // A "busy, try again" 503 is passed through for everyone.
    expect(downloadErrorMessage(503, 'Server busy — try again in a minute.', { staff: true })).toBe('Server busy — try again in a minute.');
    // Default reads the signed-in role.
    storedRole = 'GIFSY_ADMIN';
    fetchMock.mockResolvedValue(res({ status: 503 }));
    expect(await fetchExportList()).toEqual({ ok: false, status: 503, message: NOT_SET_UP_STAFF_MESSAGE });
    expect(NOT_SET_UP_STAFF_MESSAGE).not.toMatch(/contact/i);
  });
});
