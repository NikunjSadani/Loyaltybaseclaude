/// <reference types="vitest/globals" />
/**
 * Usage Report — only REAL actions count. Every automatic request (polls, badge counts, beacons, auto push re-sync)
 * carries `X-Background: 1` so the API skips activity tracking; real actions never carry it. The bell poll also
 * pauses while the tab is hidden. The shared api client always sends X-Client-Medium explicitly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { api } from '@/lib/api-client';
import { BACKGROUND_HEADER, CLIENT_MEDIUM_HEADER, backgroundInit } from '@/lib/client-medium';
import { useNotifications, UNREAD_POLL_MS } from '@/lib/notifications/use-notifications';
import { fetchExportList } from '@/lib/exports/download';
import { getVapidPublicKey } from '@/lib/pwa/push';
import { salesImportApi } from '@/lib/sales-import/api';
import { vdApi } from '@/lib/voucher-dispersal';

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
const header = (c: Call, name: string) => new Headers(c.init?.headers).get(name);

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ success: true, data: { count: 2, items: [], nextCursor: null, publicKey: '' } }),
      });
    }),
  );
  setVisibility('visible');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setVisibility('visible');
});

describe('shared api client', () => {
  it('always sends X-Client-Medium explicitly; X-Background only when asked', async () => {
    await api.get('/api/wallet');
    await api.get('/api/notifications/unread-count', { background: true });
    await api.post('/api/rewards/redeem', { a: 1 });
    expect(header(calls[0], CLIENT_MEDIUM_HEADER)).toBe('browser');
    expect(header(calls[0], BACKGROUND_HEADER)).toBeNull();
    expect(header(calls[1], BACKGROUND_HEADER)).toBe('1');
    expect(header(calls[2], BACKGROUND_HEADER)).toBeNull(); // a real action
    expect(header(calls[2], 'Content-Type')).toBe('application/json');
  });

  it('backgroundInit keeps the rest of the init', () => {
    const init = backgroundInit({ method: 'POST', headers: { a: '1' } });
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('a')).toBe('1');
    expect(new Headers(init.headers).get(BACKGROUND_HEADER)).toBe('1');
  });
});

describe('notification bell (use-notifications)', () => {
  it('the unread-count poll is a background request; marking read is a real action', async () => {
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    const count = calls.filter((c) => c.url.includes('unread-count'));
    expect(count.length).toBeGreaterThan(0);
    expect(count.every((c) => header(c, BACKGROUND_HEADER) === '1')).toBe(true);
    await act(async () => { await result.current.markAllRead(); });
    const markAll = calls.find((c) => c.url.includes('read-all'))!;
    expect(header(markAll, BACKGROUND_HEADER)).toBeNull();
  });

  it('polls every 60 s while visible, NOT while hidden, and refreshes once on becoming visible', async () => {
    vi.useFakeTimers();
    setVisibility('hidden');
    renderHook(() => useNotifications());
    await act(async () => { await vi.advanceTimersByTimeAsync(UNREAD_POLL_MS * 3); });
    expect(calls.filter((c) => c.url.includes('unread-count'))).toHaveLength(0); // hidden tab → no poll at all

    setVisibility('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(calls.filter((c) => c.url.includes('unread-count'))).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(UNREAD_POLL_MS); });
    expect(calls.filter((c) => c.url.includes('unread-count'))).toHaveLength(2);

    setVisibility('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(UNREAD_POLL_MS * 5); });
    expect(calls.filter((c) => c.url.includes('unread-count'))).toHaveLength(2);
  });
});

describe('other automatic requests', () => {
  it('downloads badge / auto-refresh list fetch is background; the Downloads page first load is not', async () => {
    await fetchExportList(null, { background: true });
    await fetchExportList(null);
    expect(header(calls[0], BACKGROUND_HEADER)).toBe('1');
    expect(calls[1].init).toBeUndefined(); // unchanged plain fetch(url)
  });

  it('auto push re-sync (VAPID key) can be marked background', async () => {
    await getVapidPublicKey({ background: true });
    await getVapidPublicKey();
    expect(header(calls[0], BACKGROUND_HEADER)).toBe('1');
    expect(header(calls[1], BACKGROUND_HEADER)).toBeNull();
  });

  it('sales-import status poll and voucher-dispersal poll / nudge are background when asked', async () => {
    await salesImportApi.get('imp1', { background: true });
    await salesImportApi.get('imp1');
    await vdApi.getCampaign('c1', { background: true });
    await vdApi.rows('c1', { page: 1, background: true });
    await vdApi.process('c1', { background: true });
    await vdApi.getCampaign('c1');
    expect(calls.map((c) => header(c, BACKGROUND_HEADER))).toEqual(['1', null, '1', '1', '1', null]);
  });
});
