/// <reference types="vitest/globals" />
/**
 * Sales Import chunked upload (plan §11 F-1).
 * Run: npx vitest run src/lib/sales-import/__tests__/upload.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  planParts, validateSalesFile, withRetry, uploadInParts, continueUpload, backoffMs, UPLOAD_RETRIES,
  SalesImportHttpError, UploadAbortedError, UploadGoneError, UploadStoppedError, readImportStatus, classifyUploadStatus,
  type UploadSession,
} from '../upload';
import { SALES_IMPORT_PART_SIZE, SALES_IMPORT_MAX_FILE_BYTES } from '../types';

const noSleep = () => Promise.resolve();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('planParts', () => {
  it('slices into exact parts with a short last part', () => {
    const size = 2 * SALES_IMPORT_PART_SIZE + 123;
    const parts = planParts(size, SALES_IMPORT_PART_SIZE);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ n: 0, start: 0, end: SALES_IMPORT_PART_SIZE });
    expect(parts[2]).toEqual({ n: 2, start: 2 * SALES_IMPORT_PART_SIZE, end: size });
    expect(parts.reduce((s, p) => s + (p.end - p.start), 0)).toBe(size);
  });

  it('an exact multiple has no empty trailing part', () => {
    expect(planParts(2 * 10, 10)).toEqual([{ n: 0, start: 0, end: 10 }, { n: 1, start: 10, end: 20 }]);
  });

  it('a file smaller than one part is one part', () => {
    expect(planParts(5, 10)).toEqual([{ n: 0, start: 0, end: 5 }]);
  });
});

describe('validateSalesFile', () => {
  it.each([
    [{ name: 'dms.xlsx', size: 10 }, null],
    [{ name: 'DMS.CSV', size: 10 }, null],
    [{ name: 'dms.xls', size: 10 }, 'Only .xlsx or .csv files are supported.'],
    [{ name: 'dms.csv', size: 0 }, 'The file is empty.'],
  ])('%o → %p', (f, msg) => expect(validateSalesFile(f)).toBe(msg));

  it('rejects a file over the max size', () => {
    expect(validateSalesFile({ name: 'a.csv', size: SALES_IMPORT_MAX_FILE_BYTES + 1 })).toMatch(/larger than 600 MB/);
  });
});

describe('withRetry', () => {
  it('retries a transient failure then succeeds, with exponential backoff', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const fn = vi.fn()
      .mockRejectedValueOnce(new SalesImportHttpError('boom', 503))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('ok');
    await expect(withRetry(fn, 4, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it('the default budget waits ~60 s in total, capped at 30 s per wait', () => {
    const waits = Array.from({ length: UPLOAD_RETRIES }, (_, i) => backoffMs(i));
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60000);
  });

  it('gives up after the retry budget', async () => {
    const fn = vi.fn().mockRejectedValue(new SalesImportHttpError('down', 502));
    await expect(withRetry(fn, 4, { sleep: noSleep })).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('does not retry a 409 (real refusal)', async () => {
    const fn = vi.fn().mockRejectedValue(new SalesImportHttpError('not uploading', 409));
    await expect(withRetry(fn, 4, { sleep: noSleep })).rejects.toThrow('not uploading');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops when aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const fn = vi.fn().mockResolvedValue('x');
    await expect(withRetry(fn, 4, { signal: ctl.signal, sleep: noSleep })).rejects.toBeInstanceOf(UploadAbortedError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('uploadInParts', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function file(size: number) {
    return new File([new Uint8Array(size)], 'dms.csv', { type: 'text/csv' });
  }

  it('creates, uploads every part in order with the right byte sizes, completes, reports progress', async () => {
    const partSize = 4;
    const sizes: number[] = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/api/admin/sales-import/uploads') {
        expect(JSON.parse(String(init.body))).toEqual({ filename: 'dms.csv', sizeBytes: 10 });
        return json(200, { success: true, data: { importId: 'imp1', partSize, partCount: 3 } });
      }
      const m = url.match(/\/api\/admin\/sales-import\/imp1\/parts\/(\d+)$/);
      if (m) {
        const part = (init.body as FormData).get('file') as Blob;
        sizes[Number(m[1])] = part.size;
        return json(200, { success: true, data: { partsReceived: Number(m[1]) + 1 } });
      }
      if (url === '/api/admin/sales-import/imp1/complete') return json(200, { success: true, data: { id: 'imp1', status: 'QUEUED' } });
      throw new Error(`unexpected ${url}`);
    });
    const progress: number[] = [];
    const id = await uploadInParts(file(10), { onProgress: (p) => progress.push(p), sleep: noSleep });
    expect(id).toBe('imp1');
    expect(sizes).toEqual([4, 4, 2]);
    expect(progress).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it('retries a failed part then continues', async () => {
    let part0Calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/uploads')) return json(200, { success: true, data: { importId: 'i', partSize: 8, partCount: 1 } });
      if (url.endsWith('/parts/0')) {
        part0Calls++;
        return part0Calls === 1 ? json(503, { success: false, error: 'busy' }) : json(200, { success: true, data: { partsReceived: 1 } });
      }
      return json(200, { success: true, data: {} });
    });
    await expect(uploadInParts(file(5), { onProgress: () => {}, sleep: noSleep })).resolves.toBe('i');
    expect(part0Calls).toBe(2);
  });

  it('surfaces the complete error (e.g. size mismatch)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/uploads')) return json(200, { success: true, data: { importId: 'i', partSize: 8, partCount: 1 } });
      if (url.endsWith('/parts/0')) return json(200, { success: true, data: { partsReceived: 1 } });
      return json(400, { success: false, error: 'Uploaded size does not match' });
    });
    await expect(uploadInParts(file(5), { onProgress: () => {}, sleep: noSleep })).rejects.toThrow('Uploaded size does not match');
  });

  it('surfaces the create error and never posts parts', async () => {
    fetchMock.mockResolvedValue(json(403, { success: false, error: 'Sales Import is not enabled for this tenant.' }));
    await expect(uploadInParts(file(5), { onProgress: () => {} })).rejects.toThrow('not enabled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('abort stops before the next part and never completes', async () => {
    const ctl = new AbortController();
    const urls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/uploads')) return json(200, { success: true, data: { importId: 'i', partSize: 2, partCount: 3 } });
      if (url.endsWith('/parts/0')) { ctl.abort(); return json(200, { success: true, data: { partsReceived: 1 } }); }
      return json(200, { success: true, data: {} });
    });
    const onCreated = vi.fn();
    await expect(uploadInParts(file(6), { onProgress: () => {}, signal: ctl.signal, sleep: noSleep, onCreated }))
      .rejects.toBeInstanceOf(UploadAbortedError);
    expect(onCreated).toHaveBeenCalledWith('i', expect.objectContaining({ importId: 'i' }));
    expect(urls.some((u) => u.endsWith('/parts/1'))).toBe(false);
    expect(urls.some((u) => u.endsWith('/complete'))).toBe(false);
  });

  it('continueUpload re-sends ONLY the parts not yet confirmed, then completes', async () => {
    const posted: number[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      const m = url.match(/\/parts\/(\d+)$/);
      if (m) { posted.push(Number(m[1])); return json(200, { success: true, data: { partsReceived: 3 } }); }
      if (url.endsWith('/complete')) return json(200, { success: true, data: { id: 'i', status: 'QUEUED' } });
      throw new Error(`unexpected ${url}`);
    });
    const session: UploadSession = { importId: 'i', partSize: 2, partCount: 3, confirmed: new Set([0, 2]) };
    const progress: number[] = [];
    await expect(continueUpload(file(6), session, { onProgress: (p) => progress.push(p), sleep: noSleep })).resolves.toBe('i');
    expect(posted).toEqual([1]);
    expect(progress).toEqual([2 / 3, 1]);
  });

  it('a failed part leaves the confirmed set intact for a later resume', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/uploads')) return json(200, { success: true, data: { importId: 'i', partSize: 2, partCount: 2 } });
      if (url.endsWith('/parts/0')) return json(200, { success: true, data: { partsReceived: 1 } });
      return json(409, { success: false, error: 'Import is not uploading' });
    });
    let session: UploadSession | null = null;
    await expect(uploadInParts(file(4), { onProgress: () => {}, sleep: noSleep, onCreated: (_id, s) => { session = s; } }))
      .rejects.toThrow('Import is not uploading');
    expect([...(session as unknown as UploadSession).confirmed]).toEqual([0]);
  });

  it('a /complete whose answer was lost but which succeeded server-side counts as success', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/uploads')) return json(200, { success: true, data: { importId: 'i', partSize: 8, partCount: 1 } });
      if (url.endsWith('/parts/0')) return json(200, { success: true, data: { partsReceived: 1 } });
      if (url.endsWith('/complete')) return json(502, { success: false, error: 'Bad gateway' });
      if (url.endsWith('/sales-import/i') && (!init?.method || init.method === 'GET')) {
        return json(200, { success: true, data: { id: 'i', status: 'QUEUED' } });
      }
      throw new Error(`unexpected ${url}`);
    });
    await expect(uploadInParts(file(5), { onProgress: () => {}, sleep: noSleep })).resolves.toBe('i');
  });

  it('a /complete that really failed (still UPLOADING) is reported', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/uploads')) return json(200, { success: true, data: { importId: 'i', partSize: 8, partCount: 1 } });
      if (url.endsWith('/parts/0')) return json(200, { success: true, data: { partsReceived: 1 } });
      if (url.endsWith('/complete')) return json(502, { success: false, error: 'Bad gateway' });
      return json(200, { success: true, data: { id: 'i', status: 'UPLOADING' } });
    });
    await expect(uploadInParts(file(5), { onProgress: () => {}, sleep: noSleep })).rejects.toThrow('Bad gateway');
  });

  it('readImportStatus: 404 → GONE, other failures → null (unknown)', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { success: false, error: 'Not found' }));
    await expect(readImportStatus('x')).resolves.toBe('GONE');
    fetchMock.mockResolvedValueOnce(json(503, { success: false, error: 'down' }));
    await expect(readImportStatus('x')).resolves.toBeNull();
  });

  it('classifyUploadStatus: only QUEUED/PROCESSING/NEEDS_MAPPING/READY/FAILED count as completed', () => {
    for (const s of ['QUEUED', 'PROCESSING', 'NEEDS_MAPPING', 'READY', 'FAILED'] as const) expect(classifyUploadStatus(s)).toBe('completed');
    expect(classifyUploadStatus('CANCELLED')).toBe('gone');
    expect(classifyUploadStatus('GONE')).toBe('gone');
    expect(classifyUploadStatus('UPLOADING')).toBe('uploading');
    expect(classifyUploadStatus(null)).toBe('unknown');
  });

  it('a lost /complete on an import that was CANCELLED meanwhile throws UploadGoneError (not success)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/uploads')) return json(200, { success: true, data: { importId: 'i', partSize: 8, partCount: 1 } });
      if (url.endsWith('/parts/0')) return json(200, { success: true, data: { partsReceived: 1 } });
      if (url.endsWith('/complete')) return json(409, { success: false, error: 'Not uploading' });
      return json(200, { success: true, data: { id: 'i', status: 'CANCELLED' } });
    });
    await expect(uploadInParts(file(5), { onProgress: () => {}, sleep: noSleep })).rejects.toBeInstanceOf(UploadGoneError);
  });

  it('a guard that throws stops the upload at once (never retried, no further requests)', async () => {
    const urls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/uploads')) return json(200, { success: true, data: { importId: 'i', partSize: 2, partCount: 2 } });
      return json(200, { success: true, data: { partsReceived: 1 } });
    });
    let calls = 0;
    const guard = () => { calls++; if (calls > 1) throw new UploadStoppedError('session changed'); };
    await expect(uploadInParts(file(4), { onProgress: () => {}, sleep: noSleep, guard })).rejects.toBeInstanceOf(UploadStoppedError);
    expect(urls).toEqual(['/api/admin/sales-import/uploads']);
  });
});
