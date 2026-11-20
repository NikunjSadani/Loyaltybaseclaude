/**
 * fetchOutletVisibilityStatuses — GET /api/visibility/outlet-statuses (AMOUNT_UPLOAD tenants).
 * A failure must come back as null (callers SAY "couldn't load"), never {} (which made every
 * outlet look "not captured"); large rosters are chunked under the backend cap.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchOutletVisibilityStatuses, OUTLET_STATUS_CHUNK } from '@/lib/visibility-upload';

afterEach(() => { vi.unstubAllGlobals(); });

const ok = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });

describe('fetchOutletVisibilityStatuses', () => {
  it('returns the map on success and encodes each code (comma-safe)', async () => {
    const fetchMock = vi.fn(() => ok({ 'A,1': { status: 'APPROVED', dateOfCapture: null, approvedBy: null, capturedByEmployeeName: null } }));
    vi.stubGlobal('fetch', fetchMock);
    const map = await fetchOutletVisibilityStatuses(['A,1', 'B'], '2026-11');
    expect(map).toEqual({ 'A,1': expect.objectContaining({ status: 'APPROVED' }) });
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('/api/visibility/outlet-statuses?');
    expect(new URLSearchParams(url.split('?')[1]).get('outletCodes')).toBe('A%2C1,B');
  });

  it('returns null (not {}) on an HTTP error, a failed envelope, or a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })));
    expect(await fetchOutletVisibilityStatuses(['A'], '2026-11')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false, error: 'x' }) })));
    expect(await fetchOutletVisibilityStatuses(['A'], '2026-11')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    expect(await fetchOutletVisibilityStatuses(['A'], '2026-11')).toBeNull();
  });

  it('no codes → {} without a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchOutletVisibilityStatuses([], '2026-11')).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chunks at 250 codes so each URL stays well under header limits (server cap stays 2,000)', async () => {
    expect(OUTLET_STATUS_CHUNK).toBe(250);
    // Long, comma-bearing codes (worst case after per-code encoding) — 1,000 codes → 4 requests.
    const codes = Array.from({ length: 1000 }, (_, i) => `BAJAJ-RLP,${String(i).padStart(6, '0')}-XX`);
    const fetchMock = vi.fn(() => ok({}));
    vi.stubGlobal('fetch', fetchMock);
    await fetchOutletVisibilityStatuses(codes, '2026-11');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls as unknown[][]) {
      const url = String(call[0]);
      expect(new URLSearchParams(url.split('?')[1]).get('outletCodes')!.split(',')).toHaveLength(250);
      expect(url.length).toBeLessThan(8000);
    }
  });

  it('chunks a large roster and merges; one failed chunk → null', async () => {
    const codes = Array.from({ length: OUTLET_STATUS_CHUNK + 5 }, (_, i) => `C${i}`);
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => ok({ C0: { status: 'APPROVED' } }))
      .mockImplementationOnce(() => ok({ [`C${OUTLET_STATUS_CHUNK}`]: { status: 'PENDING' } }));
    vi.stubGlobal('fetch', fetchMock);
    const map = await fetchOutletVisibilityStatuses(codes, '2026-11');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(map ?? {})).toEqual(['C0', `C${OUTLET_STATUS_CHUNK}`]);

    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => ok({}))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })));
    expect(await fetchOutletVisibilityStatuses(codes, '2026-11')).toBeNull();
  });
});
