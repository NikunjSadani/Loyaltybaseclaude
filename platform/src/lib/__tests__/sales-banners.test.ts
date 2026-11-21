/// <reference types="vitest/globals" />
/** fetchSalesBannersResult (owner 2026-11-21): the sales read path through the 60 s session cache. */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { __resetSessionCacheForTests } from '@/lib/session-cache';
import { fetchSalesBannersResult, getActiveSalesBanners, updateBanners, SALES_BANNERS_ENDPOINT, type Banner } from '@/lib/banner';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const res = (status: number, body: unknown = {}) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const salesCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === SALES_BANNERS_ENDPOINT).length;

beforeEach(() => {
  __resetSessionCacheForTests();
  fetchMock.mockReset();
});

describe('fetchSalesBannersResult', () => {
  it('hits /api/sales/banners (never the partner endpoint) and maps to full Banner objects', async () => {
    fetchMock.mockImplementation(() => res(200, { success: true, data: { banners: [{ id: 'a', title: 'Hi', priority: 2, type: 'video', videoUrl: 'v' }] } }));
    const r = await fetchSalesBannersResult();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sales/banners');
    expect(r.ok).toBe(true);
    expect(r.banners[0]).toMatchObject({ id: 'a', title: 'Hi', priority: 2, type: 'video', active: true, showInSalesApp: true });
    expect(getActiveSalesBanners(r.banners)).toHaveLength(1); // the client re-check keeps server-filtered rows
  });

  it('cached for 60 s: a second call makes no request', async () => {
    fetchMock.mockImplementation(() => res(200, { success: true, data: { banners: [] } }));
    await fetchSalesBannersResult();
    await fetchSalesBannersResult();
    expect(salesCalls()).toBe(1);
  });

  it('403 = a definite "none" (ok, empty, cached); a 500 / network error is not ok and is NOT cached', async () => {
    fetchMock.mockImplementation(() => res(403));
    expect(await fetchSalesBannersResult()).toEqual({ banners: [], ok: true });
    await fetchSalesBannersResult();
    expect(salesCalls()).toBe(1);

    __resetSessionCacheForTests();
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => res(500));
    expect(await fetchSalesBannersResult()).toEqual({ banners: [], ok: false });
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
    expect(await fetchSalesBannersResult()).toEqual({ banners: [], ok: false });
    expect(salesCalls()).toBe(2);
  });

  it('a banner-config save clears the cached sales banners', async () => {
    fetchMock.mockImplementation((u: unknown) => (String(u) === SALES_BANNERS_ENDPOINT ? res(200, { success: true, data: { banners: [] } }) : res(200)));
    await fetchSalesBannersResult();
    await updateBanners({ banners: [] as Banner[], popups: [] });
    await fetchSalesBannersResult();
    expect(salesCalls()).toBe(2);
  });
});

describe('getActiveSalesBanners — IST day', () => {
  it('a banner starting "today" in IST shows at 00:30 IST (still yesterday in UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T19:00:00Z')); // 21 Nov 00:30 IST
    const b = { id: 'x', active: true, showInSalesApp: true, startDate: '2026-11-21', endDate: '', priority: 0 } as Banner;
    expect(getActiveSalesBanners([b])).toHaveLength(1);
    vi.useRealTimers();
  });
});
