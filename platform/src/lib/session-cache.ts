/**
 * session-cache — ONE in-memory client cache for read-mostly API data (request-volume work, 2026-11-21).
 *
 * Why: the sales app re-fetched the same rarely-changing reads (/api/sales/me, /api/settings/outlet-types,
 * /api/auth/me, …) on nearly every screen, and the sales dashboard re-fetched ~10 endpoints on every return.
 * This module gives those reads:
 *   • `getCached(key, loader, { ttlMs })` — a TTL cache with in-flight de-duplication: concurrent callers
 *     share ONE request; a fresh value (younger than ttlMs) is served without a request.
 *   • `swr(key, loader, { maxAgeMs, onValue })` — stale-while-revalidate: a cached value is handed over at
 *     once; a background refresh runs only when the value is older than maxAgeMs.
 *
 * Freshness rules (so stale data never shows where it matters):
 *   • In-memory only — a full page load, a logout (full navigation to /auth/login) or a new tab starts empty.
 *   • `clearSessionCache()` runs on logout / assume-tenant / exit-tenant / login (lib/auth-client.ts).
 *   • ANY same-origin `/api/*` write (POST/PUT/PATCH/DELETE — a KYC submit, a capture, a redemption, an
 *     approval, a settings save, …) clears the WHOLE cache, both when it starts and when it settles
 *     (`noteApiMutation`, wired into the global fetch patch in lib/client-medium.ts). A read that was already
 *     in flight when the write started is not stored (generation check), so a pre-write answer can never
 *     land in the cache after the write.
 *   • Only successful values are cached (`shouldCache`); a failure is never cached and is retried next time.
 */

export const SESSION_TTL_MS = 5 * 60_000;
/** The sales dashboard reuses its data for this long on return (owner, 2026-11-21); older → shown + refreshed. */
export const DASHBOARD_REUSE_MS = 2 * 60_000;
/** Key prefix of every sales-dashboard read. */
export const DASH_PREFIX = 'dash:';

interface Entry {
  value?: unknown;
  /** ms epoch when `value` was stored; undefined = no value yet. */
  at?: number;
  inflight?: Promise<unknown>;
}

const store = new Map<string, Entry>();
/** Bumped on every clear — a load that started under an older generation never writes its result. */
let generation = 0;

function now(): number {
  return Date.now();
}

export interface CacheOptions<T> {
  /** Max age of a value that is served without a request. Default SESSION_TTL_MS. */
  ttlMs?: number;
  /** Store the loaded value? Default: anything not null/undefined. Return false for failures. */
  shouldCache?: (value: T) => boolean;
}

const defaultShouldCache = (v: unknown) => v !== null && v !== undefined;

function load<T>(key: string, loader: () => Promise<T>, shouldCache: (v: T) => boolean): Promise<T> {
  const entry = store.get(key) ?? {};
  if (entry.inflight) return entry.inflight as Promise<T>;
  const gen = generation;
  // eslint-disable-next-line prefer-const -- read inside the IIFE's `finally`, which always runs after assignment
  let p!: Promise<T>;
  p = (async () => {
    try {
      // Deferred one microtask so a loader that throws synchronously still settles through `finally` AFTER `p`
      // is assigned below.
      const value = await Promise.resolve().then(loader);
      if (gen === generation && shouldCache(value)) {
        store.set(key, { value, at: now() });
      }
      return value;
    } finally {
      const cur = store.get(key);
      if (cur && cur.inflight === p) {
        delete cur.inflight;
        if (cur.at === undefined) store.delete(key);
      }
    }
  })();
  store.set(key, { ...entry, inflight: p });
  return p;
}

/** Cached value (fresh within ttlMs) or ONE shared request for it. */
export function getCached<T>(key: string, loader: () => Promise<T>, opts: CacheOptions<T> = {}): Promise<T> {
  const ttl = opts.ttlMs ?? SESSION_TTL_MS;
  const entry = store.get(key);
  if (entry && entry.at !== undefined && now() - entry.at < ttl) return Promise.resolve(entry.value as T);
  return load(key, loader, opts.shouldCache ?? defaultShouldCache);
}

/** The cached value and its age, or undefined. Never triggers a request. */
export function peekCached<T>(key: string): { value: T; ageMs: number } | undefined {
  const entry = store.get(key);
  if (!entry || entry.at === undefined) return undefined;
  return { value: entry.value as T, ageMs: now() - entry.at };
}

export interface SwrOptions<T> {
  /** A cached value younger than this is used with NO request; older → used at once AND refreshed. */
  maxAgeMs: number;
  /** Receives the cached value (synchronously) and/or the loaded value. Guard against unmount yourself. */
  onValue: (value: T, source: 'cache' | 'network') => void;
  shouldCache?: (value: T) => boolean;
}

/**
 * Stale-while-revalidate read. Returns the network promise when a request was made (resolves after onValue ran),
 * or undefined when the cached value was fresh enough.
 */
export function swr<T>(key: string, loader: () => Promise<T>, opts: SwrOptions<T>): Promise<T> | undefined {
  const shouldCache = opts.shouldCache ?? defaultShouldCache;
  const cached = peekCached<T>(key);
  if (cached) {
    opts.onValue(cached.value, 'cache');
    if (cached.ageMs < opts.maxAgeMs) return undefined;
  }
  return load(key, loader, shouldCache).then((value) => {
    opts.onValue(value, 'network');
    return value;
  });
}

/** Drop every key starting with `prefix` (or matching the predicate). */
export function invalidateCached(match: string | ((key: string) => boolean)): void {
  const test = typeof match === 'string' ? (k: string) => k.startsWith(match) : match;
  for (const key of [...store.keys()]) {
    if (test(key)) store.delete(key);
  }
  generation += 1;
}

/** Forget everything (logout / assume-tenant / exit-tenant / login / any API write). */
export function clearSessionCache(): void {
  store.clear();
  generation += 1;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The HTTP method of a fetch call (init wins over a Request's own method). */
export function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const m =
    init?.method ??
    (typeof Request !== 'undefined' && input instanceof Request ? input.method : undefined) ??
    'GET';
  return m.toUpperCase();
}

/** True for a write that must invalidate cached reads. */
export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * Called by the global fetch patch for every same-origin /api request. A write clears the cache when it starts
 * (so a read racing it is not stored) — callers call it again when the write settles.
 */
export function noteApiMutation(method: string): void {
  if (isWriteMethod(method)) clearSessionCache();
}

/** Test-only. */
export function __resetSessionCacheForTests(): void {
  store.clear();
  generation = 0;
}
