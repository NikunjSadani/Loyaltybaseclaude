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
 *   • Every entry is SCOPED to the session that wrote it — host + signed-in user id (localStorage `user`) + the
 *     GIFSY operator's assumed brand (localStorage `assumedBrand`) — so a different user / tenant / assumed brand
 *     can never read another's entry, even in a tab that missed a clear.
 *   • Cross-tab: other tabs clear on a `storage` change of those keys (login / logout / assume / exit in another
 *     tab) and on a 'gifsy-session' BroadcastChannel message, which every session change, partner-outlet switch and
 *     API write posts.
 */

export const SESSION_TTL_MS = 5 * 60_000;
/** The sales dashboard reuses its data for this long on return (owner, 2026-11-21); older → shown + refreshed. */
export const DASHBOARD_REUSE_MS = 2 * 60_000;
/** Key prefix of every sales-dashboard read. */
export const DASH_PREFIX = 'dash:';
/** Tenant feature flags gate UI — admin toggles must reach reps within a minute (audit fix 7). */
export const FEATURES_TTL_MS = 60_000;

/** localStorage keys owned by lib/auth-client.ts (USER_KEY / ASSUMED_BRAND_KEY) — the session identity. */
export const SESSION_IDENTITY_KEYS = ['user', 'assumedBrand'] as const;
export const SESSION_CHANNEL = 'gifsy-session';

/** The current session's scope: host | user id | assumed brand. Read on every call (cheap) so it is never stale. */
export function sessionScope(): string {
  if (typeof window === 'undefined') return 'ssr';
  let uid = '';
  let brand = '';
  try {
    const raw = window.localStorage.getItem('user');
    if (raw) uid = String((JSON.parse(raw) as { id?: unknown })?.id ?? '');
  } catch {
    uid = '';
  }
  try {
    brand = window.localStorage.getItem('assumedBrand') ?? '';
  } catch {
    brand = '';
  }
  return `${window.location.host}|${uid}|${brand}`;
}

const SEP = '::';
const scoped = (key: string) => `${sessionScope()}${SEP}${key}`;
const unscoped = (full: string) => full.slice(full.indexOf(SEP) + SEP.length);

interface Entry {
  value?: unknown;
  /** ms epoch when `value` was stored; undefined = no value yet. */
  at?: number;
  inflight?: Promise<unknown>;
}

const store = new Map<string, Entry>();
/** Bumped on every clear — a load that started under an older generation never writes its result. */
let generation = 0;
/** Per-key generation, bumped by invalidateCached — invalidating ONE key must not void every other in-flight load
 *  (a forced roster read inside the dashboard's own loader would otherwise stop the dashboard storing its part). */
const keyGeneration = new Map<string, number>();

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
  const kgen = keyGeneration.get(key) ?? 0;
  // eslint-disable-next-line prefer-const -- read inside the IIFE's `finally`, which always runs after assignment
  let p!: Promise<T>;
  p = (async () => {
    try {
      // Deferred one microtask so a loader that throws synchronously still settles through `finally` AFTER `p`
      // is assigned below.
      const value = await Promise.resolve().then(loader);
      if (gen === generation && kgen === (keyGeneration.get(key) ?? 0) && shouldCache(value)) {
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
  const full = scoped(key);
  const entry = store.get(full);
  if (entry && entry.at !== undefined && now() - entry.at < ttl) return Promise.resolve(entry.value as T);
  return load(full, loader, opts.shouldCache ?? defaultShouldCache);
}

/** The cached value and its age, or undefined. Never triggers a request. */
export function peekCached<T>(key: string): { value: T; ageMs: number } | undefined {
  return peekFull<T>(scoped(key));
}

function peekFull<T>(full: string): { value: T; ageMs: number } | undefined {
  const entry = store.get(full);
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
  const full = scoped(key);
  const cached = peekFull<T>(full);
  if (cached) {
    opts.onValue(cached.value, 'cache');
    if (cached.ageMs < opts.maxAgeMs) return undefined;
  }
  return load(full, loader, shouldCache).then((value) => {
    opts.onValue(value, 'network');
    return value;
  });
}

/** Store a value directly (e.g. a refresh made outside a loader). Scoped like every other entry. */
export function setCached<T>(key: string, value: T): void {
  store.set(scoped(key), { value, at: now() });
}

/** Drop every key starting with `prefix` (or matching the predicate) — in every scope. */
export function invalidateCached(match: string | ((key: string) => boolean)): void {
  const test = typeof match === 'string' ? (k: string) => k.startsWith(match) : match;
  for (const full of [...store.keys()]) {
    if (test(unscoped(full))) {
      store.delete(full);
      keyGeneration.set(full, (keyGeneration.get(full) ?? 0) + 1);
    }
  }
}

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (channel || typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return channel;
  try {
    channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = () => clearLocal();
    // Node (tests / SSR tooling) keeps a process alive on an open channel; browsers have no unref.
    (channel as unknown as { unref?: () => void }).unref?.();
  } catch {
    channel = null;
  }
  return channel;
}

function clearLocal(): void {
  store.clear();
  generation += 1;
}

/**
 * Forget everything (logout / assume-tenant / exit-tenant / login / partner-outlet switch / any API write) in THIS
 * tab and — unless `broadcast: false` — in every other open tab of this origin.
 */
export function clearSessionCache(opts: { broadcast?: boolean } = {}): void {
  clearLocal();
  if (opts.broadcast === false) return;
  try {
    getChannel()?.postMessage({ type: 'clear' });
  } catch {
    /* best effort — the scoped keys still keep another session's entries unreadable */
  }
}

/** Other tabs: clear when the session identity keys change (login / logout / assume / exit elsewhere). */
let crossTabInstalled = false;
export function installCrossTabSessionSync(): void {
  if (crossTabInstalled || typeof window === 'undefined') return;
  crossTabInstalled = true;
  getChannel();
  window.addEventListener('storage', (e: StorageEvent) => {
    // key === null → localStorage.clear() in another tab.
    if (e.key === null || (SESSION_IDENTITY_KEYS as readonly string[]).includes(e.key)) clearLocal();
  });
}
if (typeof window !== 'undefined') installCrossTabSessionSync();

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
  keyGeneration.clear();
  generation = 0;
}

/** Test-only: the raw store size (all scopes). */
export function __sessionCacheSizeForTests(): number {
  return store.size;
}
