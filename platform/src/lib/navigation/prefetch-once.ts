'use client';

/**
 * usePrefetchOnce — warm the bottom-nav / header-menu screens ONCE per app session (request-volume work,
 * 2026-11-21). Replaces <Link>'s automatic prefetch, which Next 16 re-runs for every visible link after every
 * navigation (≈630–790 RSC prefetches per nav page per 80 min in prod). `router.prefetch` is a one-shot task: it is
 * not tied to a visible link, so it is never re-pinged on later navigations.
 *
 * "Session" = this JS context (a full page load / new tab starts over — the router's own cache does too).
 *
 * What a prefetch buys (node_modules/next/dist/docs/01-app/02-guides/prefetching.md): these routes are DYNAMIC, so
 * a prefetch fetches only "Layout to first loading boundary" — i.e. the route's loading.tsx skeleton — cached ~30 s
 * to 5 min. Every nav route therefore has a loading.tsx: a tap shows its skeleton at once while the page streams.
 * When Next invalidates its prefetch cache (router.refresh / a server action / revalidation) it calls the
 * `onInvalidate` we pass, and we re-prefetch that ONE href — the docs' pattern — capped per href per session so it
 * can never become a per-render or per-navigation loop.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { AppRouterInstance, PrefetchOptions } from 'next/dist/shared/lib/app-router-context.shared-runtime';

const prefetched = new Set<string>();
/** Re-prefetches after a Next cache invalidation, per href per session (bounded). */
export const MAX_REPREFETCH_PER_HREF = 10;
/** An invalidation this soon after the last prefetch of an href does NOT re-prefetch it — the load-time
 *  invalidations Next does on its own (e.g. a route-tree re-check) must not turn one prefetch into two. */
export const REPREFETCH_COOLDOWN_MS = 60_000;
const reprefetches = new Map<string, number>();
const lastPrefetchAt = new Map<string, number>();

/** router.prefetch with the docs' onInvalidate re-prefetch, bounded by MAX_REPREFETCH_PER_HREF. Exported for tests. */
export function prefetchWithRefresh(router: Pick<AppRouterInstance, 'prefetch'>, href: string): void {
  const onInvalidate = () => {
    const n = reprefetches.get(href) ?? 0;
    if (n >= MAX_REPREFETCH_PER_HREF) return;
    if (Date.now() - (lastPrefetchAt.get(href) ?? 0) < REPREFETCH_COOLDOWN_MS) return;
    reprefetches.set(href, n + 1);
    prefetchWithRefresh(router, href);
  };
  lastPrefetchAt.set(href, Date.now());
  try {
    // `kind` is typed as required but optional at runtime (defaults to AUTO — app-router-instance.js); the docs'
    // own example passes only { onInvalidate }.
    router.prefetch(href, { onInvalidate } as PrefetchOptions);
  } catch {
    /* prefetch is an optimisation only */
  }
}

/** Hrefs not yet prefetched this session; marks them as done. Exported for tests. */
export function takeUnprefetched(hrefs: readonly string[]): string[] {
  const todo: string[] = [];
  for (const h of hrefs) {
    if (!h || prefetched.has(h)) continue;
    prefetched.add(h);
    todo.push(h);
  }
  return todo;
}

export function usePrefetchOnce(hrefs: readonly string[]): void {
  const router = useRouter();
  const key = hrefs.join('\n');
  useEffect(() => {
    const todo = takeUnprefetched(key ? key.split('\n') : []);
    if (todo.length === 0) return;
    // After first paint + idle, so the warm-up never competes with the current screen's own data requests.
    const run = () => {
      for (const h of todo) prefetchWithRefresh(router, h);
    };
    const w = typeof window !== 'undefined' ? (window as Window & { requestIdleCallback?: (cb: () => void) => number }) : null;
    if (w?.requestIdleCallback) w.requestIdleCallback(run);
    else setTimeout(run, 1500);
    // `router` is stable for the app's lifetime; keying on the joined hrefs avoids re-running per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Test-only. */
export function __resetPrefetchOnceForTests(): void {
  prefetched.clear();
  reprefetches.clear();
  lastPrefetchAt.clear();
}
