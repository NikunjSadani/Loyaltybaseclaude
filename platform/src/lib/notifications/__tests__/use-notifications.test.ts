/// <reference types="vitest/globals" />
/**
 * useNotifications() — the shared bell-feed hook.
 *
 * Auth rides the httpOnly cookie, so the hook calls through the central `api`
 * client; we stub global fetch to return the platform `{ success, data }` envelope
 * and route by URL + method.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNotifications } from '@/lib/notifications/use-notifications';

interface Route {
  match: (url: string, method: string) => boolean;
  body: unknown;
  ok?: boolean;
  status?: number;
}

let routes: Route[] = [];
const calls: { url: string; method: string; body?: unknown }[] = [];

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const route = routes.find((r) => r.match(url, method));
      if (!route) {
        return Promise.resolve({
          ok: false, status: 404, statusText: 'Not Found',
          json: () => Promise.resolve({ success: false, error: 'no route' }),
        });
      }
      const ok = route.ok ?? true;
      return Promise.resolve({
        ok, status: route.status ?? (ok ? 200 : 500), statusText: ok ? 'OK' : 'Error',
        json: () => Promise.resolve(route.body),
      });
    }),
  );
}

const countRoute = (count: number): Route => ({
  match: (u, m) => u.includes('/api/notifications/unread-count') && m === 'GET',
  body: { success: true, data: { count } },
});

const feedRoute = (items: unknown[], nextCursor: string | null): Route => ({
  match: (u, m) => u.startsWith('/api/notifications?') && m === 'GET',
  body: { success: true, data: { items, nextCursor } },
});

function item(id: string, readAt: string | null = null) {
  return { id, subject: `Subject ${id}`, body: `Body ${id}`, url: `/x/${id}`, createdAt: new Date().toISOString(), readAt };
}

beforeEach(() => {
  routes = [];
  calls.length = 0;
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useNotifications — unread count', () => {
  it('fetches the unread count on mount (drives the badge)', async () => {
    routes = [countRoute(5)];
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(5));
  });

  it('a failed count poll leaves the last known count untouched', async () => {
    routes = [{ match: (u, m) => u.includes('unread-count') && m === 'GET', body: { success: false, error: 'boom' }, ok: false }];
    const { result } = renderHook(() => useNotifications());
    // stays at the initial 0 rather than throwing / going negative
    await waitFor(() => expect(result.current.unreadCount).toBe(0));
  });
});

describe('useNotifications — feed', () => {
  it('lazily loads the first page on openFeed()', async () => {
    routes = [countRoute(2), feedRoute([item('a'), item('b')], null)];
    const { result } = renderHook(() => useNotifications());

    expect(result.current.items).toHaveLength(0);
    act(() => result.current.openFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.loading).toBe(false);
    expect(result.current.hasMore).toBe(false);
  });

  it('refetches page 1 every time the feed is opened (no stale list)', async () => {
    routes = [countRoute(1), feedRoute([item('a')], null)];
    const { result } = renderHook(() => useNotifications());

    act(() => result.current.openFeed());
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['a']));

    // A new notification arrives; re-opening the panel must reload page 1 and
    // surface it (the earlier fix short-circuited on `loadedOnce` and never did).
    routes = [countRoute(2), feedRoute([item('b'), item('a')], null)];
    act(() => result.current.openFeed());
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['b', 'a']));
    // Two feed fetches were issued (one per open), not one.
    expect(calls.filter((c) => c.url.startsWith('/api/notifications?')).length).toBe(2);
  });

  it('surfaces an error when the feed load fails', async () => {
    routes = [countRoute(0), { match: (u, m) => u.startsWith('/api/notifications?') && m === 'GET', body: { success: false, error: 'nope' }, ok: false }];
    const { result } = renderHook(() => useNotifications());
    act(() => result.current.openFeed());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.items).toHaveLength(0);
  });

  it('load-more appends the next page and clears hasMore', async () => {
    routes = [
      countRoute(0),
      // first page returns a cursor; second page (same matcher) also matches — so
      // swap the route after the first load to simulate paging.
      feedRoute([item('a')], 'cursor-1'),
    ];
    const { result } = renderHook(() => useNotifications());
    act(() => result.current.openFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);

    routes = [countRoute(0), feedRoute([item('b')], null)];
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.hasMore).toBe(false);
    // the load-more request carried the cursor
    const feedCalls = calls.filter((c) => c.url.startsWith('/api/notifications?'));
    expect(feedCalls.some((c) => c.url.includes('cursor=cursor-1'))).toBe(true);
  });
});

describe('useNotifications — mark read', () => {
  it('markRead POSTs to the item endpoint and optimistically decrements the count', async () => {
    routes = [
      countRoute(3),
      feedRoute([item('a'), item('b')], null),
      { match: (u, m) => u === '/api/notifications/a/read' && m === 'POST', body: { success: true, data: { id: 'a', readAt: '2026-01-01T00:00:00Z' } } },
    ];
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    act(() => result.current.openFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await act(async () => { await result.current.markRead('a'); });

    expect(result.current.unreadCount).toBe(2);
    expect(result.current.items.find((n) => n.id === 'a')?.readAt).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/notifications/a/read' && c.method === 'POST')).toBe(true);
  });

  it('markRead reverts the optimistic change when the POST fails', async () => {
    routes = [
      countRoute(1),
      feedRoute([item('a')], null),
      { match: (u, m) => u === '/api/notifications/a/read' && m === 'POST', body: { success: false, error: 'fail' }, ok: false },
    ];
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    act(() => result.current.openFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await act(async () => { await result.current.markRead('a'); });

    // reverted
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.items.find((n) => n.id === 'a')?.readAt).toBeNull();
  });

  it('markAllRead POSTs read-all and zeroes the count', async () => {
    routes = [
      countRoute(4),
      feedRoute([item('a'), item('b')], null),
      { match: (u, m) => u === '/api/notifications/read-all' && m === 'POST', body: { success: true, data: { updated: 4 } } },
    ];
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(4));
    act(() => result.current.openFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await act(async () => { await result.current.markAllRead(); });

    expect(result.current.unreadCount).toBe(0);
    expect(result.current.items.every((n) => n.readAt)).toBe(true);
    expect(calls.some((c) => c.url === '/api/notifications/read-all' && c.method === 'POST')).toBe(true);
  });

  it('markAllRead restores the list AND the count when the POST fails', async () => {
    routes = [
      countRoute(2),
      feedRoute([item('a'), item('b')], null),
      { match: (u, m) => u === '/api/notifications/read-all' && m === 'POST', body: { success: false, error: 'boom' }, ok: false },
    ];
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    act(() => result.current.openFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await act(async () => { await result.current.markAllRead(); });

    // Both the badge and the list revert — never "all read" list with a live badge.
    expect(result.current.unreadCount).toBe(2);
    expect(result.current.items.every((n) => !n.readAt)).toBe(true);
  });
});
