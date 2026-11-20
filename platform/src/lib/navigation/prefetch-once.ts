'use client';

/**
 * usePrefetchOnce — warm the bottom-nav / header-menu screens ONCE per app session (request-volume work,
 * 2026-11-21). Replaces <Link>'s automatic prefetch, which Next 16 re-runs for every visible link after every
 * navigation (≈630–790 RSC prefetches per nav page per 80 min in prod). `router.prefetch` is a one-shot task: it is
 * not tied to a visible link, so it is never re-pinged on later navigations.
 *
 * "Session" = this JS context (a full page load / new tab starts over — the router's own cache does too).
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const prefetched = new Set<string>();

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
      for (const h of todo) {
        try {
          router.prefetch(h);
        } catch {
          /* prefetch is an optimisation only */
        }
      }
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
}
