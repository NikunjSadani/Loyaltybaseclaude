/**
 * Tenant routing cache (§A-DOMAIN Phase 2) — server-only.
 *
 * Fetches + caches the DB-driven domain→slug + branding map from the backend
 * `GET {NEXT_PUBLIC_API_URL}/v1/tenants/routing` endpoint, so the FE tenant
 * resolver can route a login to the right tenant from a DB source instead of the
 * in-code CLIENT_REGISTRY. The registry stays the fallback during rollout.
 *
 * ── Runtime / persistence note (from the modified-Next docs) ──────────────────
 * This Next.js runs `proxy.ts` in the **Node.js runtime** (proxy.md: "Proxy
 * defaults to using the Node.js runtime"). Within a single Node server process
 * (one Cloud Run instance) module-level state DOES persist across requests, so
 * this in-memory snapshot is shared. HOWEVER the docs explicitly warn: "Proxy is
 * meant to be invoked separately of your render code … you should not attempt
 * relying on shared modules or globals." Cloud Run also scales horizontally, so
 * each instance holds its OWN snapshot. We therefore design for NON-persistent
 * state as the worst case: every cold instance simply refetches once (~60s TTL),
 * and while the snapshot is null the resolver falls back to CLIENT_REGISTRY — so
 * correctness never depends on the cache surviving. No distributed cache needed.
 * (Also: `fetch` cache/revalidate options have no effect in Proxy, so we cache
 * ourselves rather than leaning on Next's fetch cache.)
 *
 * ── Design ───────────────────────────────────────────────────────────────────
 *  - Stale-while-revalidate: `getRoutingSnapshot()` is SYNC and returns the
 *    current in-memory snapshot (possibly null on cold start, possibly stale).
 *    Callers never block on the network — they read the snapshot and, out of
 *    band, call `refreshIfStale()` (via the proxy's `waitUntil`) to swap in fresh
 *    data for the NEXT request.
 *  - `invalidate()` marks the snapshot stale so the next `refreshIfStale()`
 *    refetches (last-good is kept for reads until the refetch lands — SWR).
 *  - Defensive fetch: AbortController timeout, try/catch, and on ANY failure the
 *    last-good snapshot (or null) is kept and at most a warning is logged. A
 *    backend outage must NOT break tenant resolution — the registry carries it.
 *  - `TENANT_ROUTING_SOURCE=registry` disables the DB path entirely (snapshot
 *    always null → pure registry behaviour) as an instant rollback switch.
 *    Default (unset or `'db'`) = DB-first with registry fallback.
 *
 * This module must only be imported from server code (proxy, server actions, SSR
 * helpers). It is never imported by a client component.
 */

/** Public branding shape returned by the routing endpoint (all fields optional). */
export interface PublicBranding {
  displayName?: string;
  primaryColor?: string;
  logoUrl?: string;
  wordmarkWhiteUrl?: string;
  wordmarkColorUrl?: string;
  faviconUrl?: string;
}

/** One tenant entry from `GET /v1/tenants/routing`. */
export interface RoutingTenant {
  slug: string;
  status: 'ACTIVE' | 'ONBOARDING';
  domains: string[];
  branding: PublicBranding;
}

/** The cached snapshot: derived lookup maps + the fetch timestamp. */
export interface RoutingSnapshot {
  /** lowercased full host → slug */
  domainToSlug: Map<string, string>;
  /** lowercased slug → cleaned public branding (empty strings dropped) */
  slugToBranding: Map<string, PublicBranding>;
  /** Date.now() at which this snapshot was built */
  fetchedAt: number;
}

/** How long a snapshot is considered fresh before a background refetch. */
const TTL_MS = 60_000;
/** Hard cap on the routing fetch so a slow backend can't stall the refresh. */
const FETCH_TIMEOUT_MS = 2_000;

/** The branding fields we accept from the endpoint (whitelist — no secrets). */
const BRANDING_FIELDS: (keyof PublicBranding)[] = [
  'displayName',
  'primaryColor',
  'logoUrl',
  'wordmarkWhiteUrl',
  'wordmarkColorUrl',
  'faviconUrl',
];

// ── Module-level state (see persistence note above) ──────────────────────────
let snapshot: RoutingSnapshot | null = null;
let inFlight: Promise<void> | null = null;
let forcedStale = false;
// Bumped by every invalidate() so a refresh that was dispatched BEFORE a
// concurrent invalidate doesn't clear the stale flag on completion (else the
// admin's just-made edit could be swallowed by an older in-flight fetch).
let invalidateGen = 0;

/**
 * Whether the DB routing source is active. `TENANT_ROUTING_SOURCE=registry`
 * disables it (instant rollback to pure registry behaviour); default = DB-first.
 */
function isDbSourceEnabled(): boolean {
  return process.env.TENANT_ROUTING_SOURCE !== 'registry';
}

/**
 * SYNC read of the current snapshot. Returns null when the DB source is disabled
 * or on cold start (no successful fetch yet) — callers then fall back to the
 * registry. Never triggers I/O.
 */
export function getRoutingSnapshot(): RoutingSnapshot | null {
  if (!isDbSourceEnabled()) return null;
  return snapshot;
}

/** Drop empty/blank fields so overlay treats "" (the staging reality) as "no value". */
function cleanBranding(raw: unknown): PublicBranding {
  const out: PublicBranding = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const key of BRANDING_FIELDS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v;
  }
  return out;
}

/** Build the lookup maps from the endpoint's tenant list. Defensive against junk. */
function buildSnapshot(tenants: unknown[]): RoutingSnapshot {
  const domainToSlug = new Map<string, string>();
  const slugToBranding = new Map<string, PublicBranding>();

  for (const t of tenants) {
    if (!t || typeof t !== 'object') continue;
    const tenant = t as Record<string, unknown>;
    const rawSlug = tenant.slug;
    if (typeof rawSlug !== 'string' || rawSlug.trim() === '') continue;
    const slug = rawSlug.trim().toLowerCase();

    const domains = tenant.domains;
    if (Array.isArray(domains)) {
      for (const d of domains) {
        if (typeof d === 'string' && d.trim() !== '') {
          domainToSlug.set(d.trim().toLowerCase(), slug);
        }
      }
    }

    slugToBranding.set(slug, cleanBranding(tenant.branding));
  }

  return { domainToSlug, slugToBranding, fetchedAt: Date.now() };
}

/**
 * Fetch + parse the routing map. Returns a snapshot on success, or null on any
 * error/timeout/malformed response (the caller keeps the last-good snapshot).
 * Never throws.
 */
async function fetchRouting(): Promise<RoutingSnapshot | null> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/tenants/routing`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      // Next's fetch cache/revalidate has no effect in Proxy — be explicit.
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const tenants = (body as { data?: { tenants?: unknown } } | null)?.data?.tenants;
    if (!Array.isArray(tenants)) return null;
    return buildSnapshot(tenants);
  } catch {
    // Timeout / network / parse error — keep last-good, no throw.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ASYNC stale-while-revalidate refresh. No-ops when the DB source is disabled or
 * the snapshot is still fresh. Coalesces concurrent callers onto one in-flight
 * fetch. Resolves (never rejects) even on fetch failure so the proxy's
 * `waitUntil(refreshIfStale())` — or a fire-and-forget `void refreshIfStale()` —
 * can never produce an unhandled rejection or crash the request.
 */
export function refreshIfStale(): Promise<void> {
  if (!isDbSourceEnabled()) return Promise.resolve();

  const stale =
    snapshot === null || forcedStale || Date.now() - snapshot.fetchedAt > TTL_MS;
  if (!stale) return Promise.resolve();
  if (inFlight) return inFlight;

  const gen = invalidateGen; // capture the intent at dispatch (see invalidateGen)
  inFlight = fetchRouting()
    .then((next) => {
      if (next) {
        // Atomic swap — a single reference assignment; readers see old or new.
        snapshot = next;
        // Only clear the stale flag if NO new invalidate() arrived while this
        // fetch was in flight — otherwise a concurrent edit's invalidate would be
        // lost and the edit wouldn't reflect until the TTL elapsed.
        if (gen === invalidateGen) forcedStale = false;
      }
      // On failure keep the last-good snapshot (or null → registry fallback).
    })
    .catch((err) => {
      // fetchRouting already swallows its own errors; this is belt-and-braces so
      // a rejected promise can never bubble out of a waitUntil/fire-and-forget.
      console.warn(
        '[tenant-routing-cache] refresh failed:',
        err instanceof Error ? err.message : err,
      );
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Force the next `refreshIfStale()` to refetch (e.g. after a client create/edit
 * server action changes routing/branding). The last-good snapshot is kept for
 * SYNC reads until the refetch lands (stale-while-revalidate).
 */
export function invalidate(): void {
  forcedStale = true;
  invalidateGen++;
}

/**
 * ONE-TIME cold-start warm: when the DB source is enabled and there is NO
 * snapshot yet (a fresh Cloud Run instance whose SWR fetch hasn't resolved), AWAIT
 * a single fetch so the DB domain→slug map is available before the first
 * resolution. Without this, a cold instance resolving a DB-only BRANDED host
 * (label ≠ slug, e.g. `clientbrewards.gifsy.in → clientb`) would fall through to
 * the subdomain heuristic and return the bare label — a mis-route. Bounded by the
 * fetch's ~2s timeout; on failure the snapshot stays null → registry fallback.
 * Returns immediately once warm (then plain SWR takes over), so this blocks at
 * most the FIRST request per instance, never the hot path thereafter.
 */
export async function ensureWarm(): Promise<void> {
  if (!isDbSourceEnabled()) return;
  if (snapshot !== null) return;
  await refreshIfStale();
}

/**
 * TEST-ONLY: reset all module state between vitest cases. Never called by
 * production code.
 */
export function __resetRoutingCacheForTests(): void {
  snapshot = null;
  inFlight = null;
  forcedStale = false;
  invalidateGen = 0;
}
