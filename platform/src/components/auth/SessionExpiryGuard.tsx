'use client';

import { useEffect, useState } from 'react';
import { loginUrlWithNext } from '@/lib/return-to';

/**
 * Pure decision: should an API response trigger a re-login redirect?
 *
 * Deliberate scope:
 *  - ONLY 401 (authentication failed → token missing/expired/invalid). 403 (Forbidden
 *    = authenticated but not permitted) is intentionally NOT handled, so RBAC errors
 *    still surface in-page instead of bouncing the user out.
 *  - ONLY same-origin `/api/*` calls, EXCLUDING `/api/auth/*` (the login flow itself
 *    legitimately returns 4xx on a bad OTP / expired OTP).
 *  - Never when already on an `/auth/*` page (avoids a redirect loop).
 */
export function shouldRedirectOnAuth(
  status: number,
  url: string,
  pathname: string,
): boolean {
  if (status !== 401) return false;
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
// Refresh machinery (2026-11-20 audit round: H3 / M1 / M2 / M4 / L3)
//
//  - The guard refreshes through POST /auth/session-refresh (route handler) and reads a REAL status:
//    200 ok · 401 dead (→ login) · anything else / network error → TRANSIENT (keep the session).
//  - Single-flight per tab, and across tabs (M4): a Web Lock serialises refreshes; a tab that waited
//    on the lock first checks whether another tab refreshed in the last few seconds (shared cookie
//    jar → already fixed) and skips its own exchange.
//  - TRANSIENT is counted ONCE per refresh outcome (H3), never per waiting caller, and never turns
//    into a login bounce. It shows a role=status "Reconnecting…" banner (M2) and retries the refresh
//    with exponential backoff (M1). Offline → no retries until the browser fires `online`.
//  - Once the session is restored, the page is reloaded ONCE to re-fetch the data that failed —
//    unless the user has typed on this page (unsaved input is never thrown away: banner instead),
//    and never more than once per RELOAD_WINDOW_MS (no reload loop).
//  - Any successful /api response proves the session works → banner cleared, backoff reset (L3).
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SESSION_REFRESH_PATH = '/auth/session-refresh';
/** Backoff before each automatic refresh retry while transient (ms). */
export const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
/** At most one post-recovery reload per this window (sessionStorage-tracked). */
export const RELOAD_WINDOW_MS = 10 * 60_000;
/** Another tab's refresh newer than this is reused instead of refreshing again (M4). */
export const CROSS_TAB_FRESH_MS = 5_000;
const CROSS_TAB_KEY = 'gifsy:session-refreshed-at';
const RELOAD_KEY = 'gifsy:session-reload-at';
const LOCK_NAME = 'gifsy-session-refresh';

type Outcome = 'ok' | 'dead' | 'transient';
export type BannerState =
  | null
  | { kind: 'reconnecting'; offline: boolean; exhausted: boolean }
  | { kind: 'restored-dirty' };

// Module-level state: install the fetch patch once per app session; redirect at most once.
let installed = false;
let redirecting = false;
let originalFetch: typeof window.fetch | null = null;
let refreshing: Promise<Outcome> | null = null;
let banner: BannerState = null;
let bannerListener: ((b: BannerState) => void) | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let waitingForOnline = false;
let dirtyPath: string | null = null; // pathname the user last typed on (unsaved-input heuristic)

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

function pageIsDirty(): boolean {
  return dirtyPath !== null && dirtyPath === window.location.pathname;
}

/** One refresh exchange against the route handler. */
async function exchangeOnce(): Promise<Outcome> {
  // M4 — another tab refreshed moments ago: the cookie jar is shared, nothing to do.
  const stamp = Number(safeStorage('local')?.getItem(CROSS_TAB_KEY) ?? 0);
  if (stamp && Date.now() - stamp < CROSS_TAB_FRESH_MS) return 'ok';
  try {
    const res = await originalFetch!(SESSION_REFRESH_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-session-refresh': '1' },
    });
    if (res.status === 200) {
      try {
        safeStorage('local')?.setItem(CROSS_TAB_KEY, String(Date.now()));
      } catch {
        /* storage full / blocked — the lock still serialises */
      }
      return 'ok';
    }
    return res.status === 401 ? 'dead' : 'transient';
  } catch {
    return 'transient'; // network failure — never proof the session is gone
  }
}

/** Single-flight per tab; serialised across tabs with a Web Lock when available (M4). */
function refreshOnce(): Promise<Outcome> {
  if (!refreshing) {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    const run = locks?.request ? locks.request(LOCK_NAME, () => exchangeOnce()) : exchangeOnce();
    refreshing = Promise.resolve(run as Promise<Outcome>)
      .catch(() => 'transient' as const)
      .then((outcome) => {
        // H3 — the outcome is handled ONCE here, however many callers were waiting on it.
        if (outcome === 'transient') onTransient();
        else if (outcome === 'ok') onRecovered();
        else onDead(); // also covers a BACKGROUND retry that finds the session dead
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

function onTransient() {
  if (redirecting) return;
  const offline = isOffline();
  if (offline) {
    setBanner({ kind: 'reconnecting', offline: true, exhausted: false });
    if (!waitingForOnline) {
      waitingForOnline = true;
      window.addEventListener(
        'online',
        () => {
          waitingForOnline = false;
          void refreshOnce();
        },
        { once: true },
      );
    }
    return;
  }
  const exhausted = attempt >= RECONNECT_BACKOFF_MS.length;
  setBanner({ kind: 'reconnecting', offline: false, exhausted });
  if (exhausted || retryTimer) return;
  const delay = RECONNECT_BACKOFF_MS[attempt];
  attempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void refreshOnce();
  }, delay);
}

function onRecovered() {
  const wasReconnecting = banner?.kind === 'reconnecting';
  attempt = 0;
  clearRetry();
  if (!wasReconnecting) return; // nothing failed visibly — nothing to recover
  if (pageIsDirty()) {
    setBanner({ kind: 'restored-dirty' }); // keep the user's unsaved input; let them retry
    return;
  }
  const store = safeStorage('session');
  const last = Number(store?.getItem(RELOAD_KEY) ?? 0);
  if (last && Date.now() - last < RELOAD_WINDOW_MS) {
    setBanner({ kind: 'restored-dirty' }); // reload cap reached — ask instead of looping
    return;
  }
  try {
    store?.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  setBanner(null);
  window.location.reload(); // re-fetch what failed while the session was being restored
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

/** Any successful /api response proves the session works (L3). */
function onApiSuccess() {
  if (banner?.kind === 'reconnecting') {
    attempt = 0;
    clearRetry();
    setBanner(null);
  }
}

/** Manual "Retry now" from the banner. */
export function retrySessionNow() {
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
  waitingForOnline = false;
  dirtyPath = null;
}

/**
 * SessionExpiryGuard — graceful recovery from an expired / invalid token.
 *
 * When an access token expires the proxy answers `/api/*` calls with 401. This patches
 * window.fetch to detect any qualifying 401 (see shouldRedirectOnAuth) and FIRST attempt
 * a silent refresh using the httpOnly refresh-token cookie (AF-6) — on success the
 * original request is retried transparently and the user never notices. Only a DEFINITE
 * refusal (the refresh endpoint answers 401) bounces the user to /auth/login; a transient
 * failure keeps the session and shows a "Reconnecting…" banner instead. Mounted once,
 * app-wide, in the root layout.
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

    // Unsaved-input heuristic: the user typed on this page since it loaded.
    const markDirty = () => {
      dirtyPath = window.location.pathname;
    };
    document.addEventListener('input', markDirty, true);
    document.addEventListener('change', markDirty, true);

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
        if (!redirecting && shouldRedirectOnAuth(res.status, url, window.location.pathname)) {
          // Try a silent refresh before giving up (single-flight across concurrent 401s).
          const refreshed = await refreshOnce();
          if (refreshed === 'transient') {
            // Not proof of a dead session: keep it, surface the original 401 to the caller; the
            // banner + background retries take it from here (counted once in refreshOnce).
            return res;
          }
          if (refreshed === 'ok' && !redirecting) {
            // New cookie is set — retry the original request once (unpatched, so a
            // second 401 can't recurse into another refresh).
            const retry = await realFetch(input, init);
            if (retry.status !== 401) return retry;
          }
          // The refresh endpoint said DEAD (already redirected in refreshOnce), or the refresh
          // succeeded but the retry still 401s → the session is dead.
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
    shown.kind === 'restored-dirty'
      ? 'Connection restored. Your unsaved changes are kept — please retry your last action.'
      : shown.offline
        ? 'You are offline. We will reconnect automatically when you are back online.'
        : shown.exhausted
          ? 'We still cannot reach the server. Your session is kept — please retry.'
          : 'Connection to the server was interrupted. Reconnecting…';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="session-reconnect-banner"
      style={{
        position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 1000, maxWidth: 560, margin: '0 auto',
        display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderRadius: 8, background: '#1f2937', color: '#fff', fontSize: 14,
        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
      }}
    >
      <span>{message}</span>
      {shown.kind === 'restored-dirty' ? (
        <button type="button" onClick={() => setBanner(null)} style={{ color: '#fff', textDecoration: 'underline' }}>
          Dismiss
        </button>
      ) : shown.offline ? null : (
        <button type="button" onClick={retrySessionNow} style={{ color: '#fff', textDecoration: 'underline' }}>
          Retry now
        </button>
      )}
    </div>
  );
}
