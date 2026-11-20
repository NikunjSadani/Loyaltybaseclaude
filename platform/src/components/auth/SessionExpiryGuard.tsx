'use client';

import { useEffect, useState } from 'react';
import { loginUrlWithNext } from '@/lib/return-to';

/**
 * Pure decision: is this API response a SESSION expiry the guard should handle (refresh, maybe login)?
 *
 * Deliberate scope:
 *  - ONLY 401 that carries the session marker `x-auth-failure: session` (set by the proxy and by the
 *    API's JwtAuthGuard). A business 401 without it (e.g. a "wrong OTP" from some endpoint) is NEVER a
 *    session expiry: no refresh, no resend, no logout (H1, 2026-11-20).
 *  - 403 (authenticated but not permitted) is never handled here — RBAC errors surface in-page.
 *  - ONLY same-origin `/api/*` calls, EXCLUDING `/api/auth/*` (the login flow's own 4xx).
 *  - Never when already on an `/auth/*` page (avoids a redirect loop).
 */
export function shouldRedirectOnAuth(
  status: number,
  url: string,
  pathname: string,
  authFailure: string | null | undefined,
): boolean {
  if (status !== 401) return false;
  if (authFailure !== 'session') return false;
  if (!url.includes('/api/')) return false;
  if (url.includes('/api/auth/')) return false;
  if (pathname.startsWith('/auth/')) return false;
  return true;
}

/**
 * Pure decision: should a 403 surface a "no permission" notice (RBAC Option-X P6)?
 *
 * ONLY 403 (authenticated but forbidden) on a same-origin /api/* call, EXCLUDING
 * /api/auth/* (its 4xx are the login/OTP flow, not RBAC). 403 is NOT a redirect —
 * the page stays put and a clear toast is shown instead of a raw error. The toast
 * listener further scopes the notice to GIFSY_STAFF.
 */
export function shouldNotifyForbidden(status: number, url: string): boolean {
  if (status !== 403) return false;
  if (!url.includes('/api/')) return false;
  if (url.includes('/api/auth/')) return false;
  return true;
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Refresh machinery (2026-11-20 audit rounds)
//
//  - The guard refreshes through POST /auth/session-refresh (route handler) and reads a REAL status:
//    200 ok · 401 dead (→ login) · 503 / network / timeout → "unavailable" · any other status →
//    "error" (both transient: the session is KEPT, never a login bounce).
//  - Single-flight per tab and across tabs (M4): a Web Lock serialises refreshes; a tab that waited
//    skips its exchange if another tab refreshed < 5 s ago (shared cookie jar). Each exchange is
//    bounded by a 7 s timeout (H4) so a stuck request (iOS resume) can't hold the lock forever.
//  - A transient outcome is handled ONCE per refresh, shows a role=status banner with "Retry now",
//    and retries in the background: 2/4/8/16/30 s, then every 60 s for as long as needed (M4); also
//    immediately when the browser comes back online or the tab becomes visible / focused again.
//  - NO automatic reload after recovery (H2/H3): a reload could throw away unsaved input or captured
//    photos. The banner just disappears, later requests work again, and a `session:restored` window
//    event lets a page that wants to re-fetch do so (opt-in).
//  - Any successful /api response proves the session works → banner cleared, retries cancelled.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SESSION_REFRESH_PATH = '/auth/session-refresh';
/** Backoff before each automatic refresh retry while transient (ms); the last value repeats forever. */
export const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];
/**
 * Per-attempt timeout for the refresh exchange (H4 / H-A b). It must cover the WHOLE path — browser → route
 * handler → API (the Next→API leg gives up at 5 s, and the API never commits later than 4 s after it received
 * the call) — with margin, so the browser never gives up on a rotation that is still able to commit.
 */
export const REFRESH_EXCHANGE_TIMEOUT_MS = 10_000;
/** Body of the typed TRANSIENT error handed to callers instead of the raw 401 (session alive, unreachable). */
export const CONNECTION_PROBLEM_MESSAGE = 'Connection problem — please retry.';
const RECONNECT_SINCE_KEY = 'gifsy:reconnect-since'; // set by the proxy's Reconnecting page
/** Another tab's refresh newer than this is reused instead of refreshing again (M4). */
export const CROSS_TAB_FRESH_MS = 5_000;
const CROSS_TAB_KEY = 'gifsy:session-refreshed-at';
const RECONNECT_PAGE_KEY = 'gifsy:reconnect-attempt'; // set by the proxy's Reconnecting page
const LOCK_NAME = 'gifsy-session-refresh';

type Outcome = 'ok' | 'dead' | 'unavailable' | 'error';
export type BannerState = null | { kind: 'offline' } | { kind: 'unavailable' } | { kind: 'error' };

// Module-level state: install the fetch patch once per app session; redirect at most once.
let installed = false;
let redirecting = false;
let originalFetch: typeof window.fetch | null = null;
let refreshing: Promise<Outcome> | null = null;
let banner: BannerState = null;
let bannerListener: ((b: BannerState) => void) | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function setBanner(next: BannerState) {
  banner = next;
  bannerListener?.(next);
}

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** M-3 — AbortSignal.timeout is missing on older Safari: fall back to an AbortController + timer. */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  const AS = typeof AbortSignal !== 'undefined' ? (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }) : undefined;
  if (AS && typeof AS.timeout === 'function') return AS.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * The response callers get while the session is alive-but-unreachable: a typed TRANSIENT error (503,
 * `transient: true`, `x-session-transient: 1`) instead of the raw 401 — so pages say "Connection problem —
 * retry", never "your session has expired".
 */
function transientResponse(): Response {
  return new Response(JSON.stringify({ success: false, error: CONNECTION_PROBLEM_MESSAGE, transient: true }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'x-session-transient': '1' },
  });
}

/** One refresh exchange against the route handler (bounded by REFRESH_EXCHANGE_TIMEOUT_MS). */
async function exchangeOnce(): Promise<Outcome> {
  // M4 — another tab refreshed moments ago: the cookie jar is shared, nothing to do.
  const stamp = Number(safeStorage('local')?.getItem(CROSS_TAB_KEY) ?? 0);
  if (stamp && Date.now() - stamp < CROSS_TAB_FRESH_MS) return 'ok';
  try {
    const res = await originalFetch!(SESSION_REFRESH_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-session-refresh': '1' },
      signal: timeoutSignal(REFRESH_EXCHANGE_TIMEOUT_MS),
    });
    if (res.status === 200) {
      try {
        safeStorage('local')?.setItem(CROSS_TAB_KEY, String(Date.now()));
      } catch {
        /* storage full / blocked — the lock still serialises */
      }
      return 'ok';
    }
    if (res.status === 401) return 'dead';
    return res.status === 503 ? 'unavailable' : 'error';
  } catch {
    return 'unavailable'; // network failure / timeout — never proof the session is gone
  }
}

/** Single-flight per tab; serialised across tabs with a Web Lock when available (M4). */
function refreshOnce(): Promise<Outcome> {
  if (!refreshing) {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    const run = locks?.request ? locks.request(LOCK_NAME, () => exchangeOnce()) : exchangeOnce();
    refreshing = Promise.resolve(run as Promise<Outcome>)
      .catch(() => 'unavailable' as const)
      .then((outcome) => {
        // The outcome is handled ONCE here, however many callers were waiting on it.
        if (outcome === 'ok') onRecovered();
        else if (outcome === 'dead') onDead();
        else onTransient(outcome);
        return outcome;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function onTransient(kind: 'unavailable' | 'error') {
  if (redirecting) return;
  if (isOffline()) {
    setBanner({ kind: 'offline' }); // the `online` / visibility / focus listeners retry
    return;
  }
  setBanner({ kind });
  if (retryTimer) return;
  const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
  attempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void refreshOnce();
  }, delay);
}

function onRecovered() {
  attempt = 0;
  clearRetry();
  if (banner) {
    setBanner(null);
    // Opt-in for pages that want to re-fetch what failed (no automatic reload — H2).
    try {
      window.dispatchEvent(new CustomEvent('session:restored'));
    } catch {
      /* ignore */
    }
  }
}

/** The refresh endpoint said the session is DEFINITIVELY gone → sign in again (once). */
function onDead() {
  clearRetry();
  if (redirecting) return;
  redirecting = true;
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  } catch {
    /* storage blocked — proceed to login anyway */
  }
  window.location.assign(loginUrlWithNext(`${window.location.pathname}${window.location.search}`, { expired: '1' }));
}

/** Any successful /api response proves the session works. */
function onApiSuccess() {
  if (banner) {
    attempt = 0;
    clearRetry();
    setBanner(null);
  }
}

/** "Retry now" from the banner, and the online / visible / focus triggers. */
export function retrySessionNow() {
  if (!banner) return;
  attempt = 0;
  clearRetry();
  void refreshOnce();
}

/** Test-only: reset module state between cases. */
export function __resetSessionGuardForTests() {
  installed = false;
  redirecting = false;
  originalFetch = null;
  refreshing = null;
  banner = null;
  attempt = 0;
  clearRetry();
}

/**
 * SessionExpiryGuard — graceful recovery from an expired / invalid token.
 *
 * When an access token expires the proxy answers `/api/*` calls with a marked 401. This patches
 * window.fetch to detect such a 401 (see shouldRedirectOnAuth) and FIRST attempt a silent refresh using
 * the httpOnly refresh-token cookie — on success the original request is retried transparently. Only a
 * DEFINITE refusal (the refresh endpoint answers 401) bounces the user to /auth/login; anything else
 * keeps the session and shows a small reconnect banner. Mounted once, app-wide, in the root layout.
 */
export default function SessionExpiryGuard() {
  const [shown, setShown] = useState<BannerState>(banner);

  useEffect(() => {
    bannerListener = setShown;
    return () => {
      if (bannerListener === setShown) bannerListener = null;
    };
  }, []);

  useEffect(() => {
    if (installed || typeof window === 'undefined') return;
    installed = true;

    // A page that loads normally ends any Reconnecting-page backoff cycle (proxy C2 page).
    try {
      window.sessionStorage.removeItem(RECONNECT_PAGE_KEY);
      window.sessionStorage.removeItem(RECONNECT_SINCE_KEY);
    } catch {
      /* ignore */
    }

    // M4 — retry as soon as there is a reason to believe it can work.
    window.addEventListener('online', retrySessionNow);
    window.addEventListener('focus', retrySessionNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') retrySessionNow();
    });

    const realFetch = window.fetch.bind(window);
    originalFetch = realFetch;
    const patched: typeof window.fetch = async (input, init) => {
      const res = await realFetch(input, init);
      try {
        const url = extractUrl(input);
        // RBAC Option-X P6: a forbidden (403) /api call surfaces a clear "no permission"
        // toast instead of a raw error. Fire-and-forget event; the listener (staff-scoped)
        // decides whether to show it. Never blocks or alters the response.
        if (shouldNotifyForbidden(res.status, url)) {
          window.dispatchEvent(new CustomEvent('api:forbidden', { detail: { url } }));
        }
        if (res.ok && url.includes('/api/') && !url.includes('/api/auth/')) onApiSuccess();
        if (
          !redirecting &&
          shouldRedirectOnAuth(res.status, url, window.location.pathname, res.headers?.get?.('x-auth-failure'))
        ) {
          // Try a silent refresh before giving up (single-flight across concurrent 401s).
          const refreshed = await refreshOnce();
          if (refreshed === 'unavailable' || refreshed === 'error') {
            // Not proof of a dead session: keep it, and hand the caller a typed TRANSIENT error (not the
            // raw 401); the banner + background retries take it from here (handled once in refreshOnce).
            return transientResponse();
          }
          if (refreshed === 'ok' && !redirecting) {
            // New cookie is set — retry the original request once (unpatched, so a
            // second 401 can't recurse into another refresh).
            const retry = await realFetch(input, init);
            const retryMarker = retry.headers?.get?.('x-auth-failure');
            if (retry.status !== 401 || retryMarker !== 'session') return retry;
          }
          // The refresh endpoint said DEAD (already redirected in refreshOnce), or the refresh
          // succeeded but the retry still fails SESSION auth → the session is dead.
          onDead();
        }
      } catch {
        /* the guard must NEVER break a fetch */
      }
      return res;
    };
    window.fetch = patched;
    // Intentionally not restored on unmount: the patch must persist for the whole app
    // session, and restoring could race with in-flight requests.
  }, []);

  if (!shown) return null;
  const message =
    shown.kind === 'offline'
      ? 'You are offline. You are still signed in — we will reconnect when you are back online.'
      : shown.kind === 'error'
        ? 'Something went wrong while keeping you signed in. You are still signed in.'
        : 'Connection to the server was interrupted. Reconnecting…';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="session-reconnect-banner"
      style={{
        // TOP of the screen (below the safe area) so it never covers bottom navigation or a submit bar.
        position: 'fixed', left: 16, right: 16, top: 'calc(env(safe-area-inset-top, 0px) + 8px)', zIndex: 1000,
        maxWidth: 560, margin: '0 auto',
        display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderRadius: 8, background: '#1f2937', color: '#fff', fontSize: 14,
        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
      }}
    >
      <span>{message}</span>
      <button type="button" onClick={retrySessionNow} style={{ color: '#fff', textDecoration: 'underline', whiteSpace: 'nowrap' }}>
        Retry now
      </button>
    </div>
  );
}
