/**
 * visibility-client.test.ts — the canonical `visibilityApi` client: every method maps
 * to the correct `/api/visibility/*` URL + HTTP verb (through the shared api-client),
 * plus the multipart upload, the media view-path helpers, and the blob export.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spyable api-client — records (verb, url, body) per call.
const calls: Array<{ verb: string; url: string; body?: unknown }> = [];
vi.mock('@/lib/api-client', () => {
  const record = (verb: string) => (url: string, body?: unknown) => {
    calls.push({ verb, url, body });
    return Promise.resolve({ success: true, data: {} });
  };
  return {
    api: {
      get: record('GET'),
      post: record('POST'),
      put: record('PUT'),
      patch: record('PATCH'),
      del: record('DELETE'),
    },
  };
});

import {
  visibilityApi,
  mediaViewUrl,
  rewriteMediaViewPath,
} from '@/lib/visibility';

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('visibilityApi method → URL/verb map', () => {
  it('admin config + form + outlets', () => {
    visibilityApi.getConfig();
    visibilityApi.setConfig({ outletScope: ['SSS'], frequencyPerMonth: 2, allowedSalesLevels: ['SO'], geoFence: { enabled: true, radiusMeters: 50 } });
    visibilityApi.getForm();
    visibilityApi.upsertForm({ formSchema: { captureGpsOnSubmit: true, fields: [] } });
    visibilityApi.listOutlets({ q: 'kir', zone: 'North' });

    expect(calls).toEqual([
      { verb: 'GET', url: '/api/visibility/config', body: undefined },
      { verb: 'PUT', url: '/api/visibility/config', body: expect.objectContaining({ frequencyPerMonth: 2 }) },
      { verb: 'GET', url: '/api/visibility/form', body: undefined },
      { verb: 'PUT', url: '/api/visibility/form', body: expect.any(Object) },
      { verb: 'GET', url: '/api/visibility/outlets?q=kir&zone=North', body: undefined },
    ]);
  });

  it('sales eligible + outlet-status + capture + resubmit', () => {
    visibilityApi.getSalesEligible();
    visibilityApi.getOutletStatus('outlet-1');
    visibilityApi.submitCapture({ outletId: 'outlet-1', formValues: { photo: 'k' } });
    visibilityApi.resubmitCapture('cap-9', { formValues: { photo: 'k2' } });

    expect(calls.map((c) => `${c.verb} ${c.url}`)).toEqual([
      'GET /api/visibility/sales/eligible',
      'GET /api/visibility/outlet/outlet-1/status',
      'POST /api/visibility/capture',
      'POST /api/visibility/captures/cap-9/resubmit',
    ]);
    expect(calls[2].body).toEqual({ outletId: 'outlet-1', formValues: { photo: 'k' } });
  });

  it('review list + get + approve + reject', () => {
    visibilityApi.listCaptures({ status: 'SUBMITTED', windowKey: '2026-07-P2', page: 2 });
    visibilityApi.getCapture('cap-1');
    visibilityApi.approveCapture('cap-1');
    visibilityApi.rejectCapture('cap-1', { reasonCode: 'BLURRY', reason: 'too dark' });

    expect(calls.map((c) => `${c.verb} ${c.url}`)).toEqual([
      'GET /api/visibility/captures?status=SUBMITTED&windowKey=2026-07-P2&page=2',
      'GET /api/visibility/captures/cap-1',
      'POST /api/visibility/captures/cap-1/approve',
      'POST /api/visibility/captures/cap-1/reject',
    ]);
    expect(calls[3].body).toEqual({ reasonCode: 'BLURRY', reason: 'too dark' });
  });

  it('reports get + tenant + export url (window scoping)', () => {
    visibilityApi.getReport('2026-07-P1');
    visibilityApi.getTenantReport();
    expect(calls.map((c) => `${c.verb} ${c.url}`)).toEqual([
      'GET /api/visibility/report?windowKey=2026-07-P1',
      'GET /api/visibility/report/tenant',
    ]);
    expect(visibilityApi.exportUrl('2026-07-P1')).toBe('/api/visibility/report/export?windowKey=2026-07-P1');
    expect(visibilityApi.exportUrl()).toBe('/api/visibility/report/export');
  });
});

describe('media view-path helpers', () => {
  it('builds the auth-gated media view URL', () => {
    expect(mediaViewUrl('visibility-media/c1/a b.jpg')).toBe(
      '/api/visibility/captures/media?key=visibility-media%2Fc1%2Fa%20b.jpg',
    );
  });
  it('rewrites a backend /v1/ viewPath to /api/', () => {
    expect(rewriteMediaViewPath('/v1/visibility/captures/media?key=x')).toBe(
      '/api/visibility/captures/media?key=x',
    );
    // idempotent
    expect(rewriteMediaViewPath('/api/visibility/captures/media?key=x')).toBe(
      '/api/visibility/captures/media?key=x',
    );
  });
});

describe('uploadMedia (multipart) + downloadExport (blob)', () => {
  it('POSTs multipart FormData with the file field', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { key: 'visibility-media/c1/x.jpg' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    const res = await visibilityApi.uploadMedia(file);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/visibility/media');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeTruthy();
    expect(res).toEqual({ success: true, data: { key: 'visibility-media/c1/x.jpg' } });
    vi.unstubAllGlobals();
  });

  it('downloadExport surfaces a failed response error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Forbidden',
      json: () => Promise.resolve({ error: 'Gifsy only' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const res = await visibilityApi.downloadExport('2026-07-P2');
    expect(fetchSpy).toHaveBeenCalledWith('/api/visibility/report/export?windowKey=2026-07-P2');
    expect(res).toEqual({ success: false, error: 'Gifsy only' });
    vi.unstubAllGlobals();
  });
});
