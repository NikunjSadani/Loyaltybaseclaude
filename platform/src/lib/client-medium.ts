/**
 * Usage Report — tell the API HOW each request was made: from the installed app (PWA launched from the home screen,
 * display-mode standalone) or from a browser tab. Design: docs/plans/USAGE-REPORT.md.
 *
 * Every same-origin `/api/*` fetch gets `X-Client-Medium: app | browser`. The header rides the Next proxy
 * (src/proxy.ts copies all request headers; it only strips its own internal ones) and the `/api → /v1` rewrite to
 * the API, where it is validated to exactly those two values (anything else = unknown) and recorded per user per
 * day (api/src/activity). Phone vs computer is derived on the API side from the User-Agent.
 *
 * How: one window.fetch patch, installed when this module is first evaluated in the browser (the root layout
 * imports <ClientMediumHeader/>), i.e. BEFORE any page effect issues its first request — so even a page's first
 * call is tagged. SessionExpiryGuard's own patch is installed later and wraps this one, so its silent-refresh
 * retry is tagged too. Raw fetch('/api/…') calls in pages and the api-client wrapper are both covered.
 *
 * Never throws and never changes a request beyond adding the header: any failure falls through to the original fetch.
 */

import { isWriteMethod, methodOf, noteApiMutation } from '@/lib/session-cache';

export type ClientMedium = 'app' | 'browser';

export const CLIENT_MEDIUM_HEADER = 'X-Client-Medium';

/**
 * Marks an AUTOMATIC request — a poll, refresh timer or beacon, not something a person did. The API skips activity
 * tracking entirely for it (no active day, no visit, no duration, no medium): owner rule, only REAL actions count.
 * Value is exactly '1'. Use `backgroundInit()` for raw fetch, or `api.get(url, { background: true })`.
 */
export const BACKGROUND_HEADER = 'X-Background';

/** The same fetch init, marked as an automatic/background request. */
export function backgroundInit(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(BACKGROUND_HEADER, '1');
  return { ...init, headers };
}

/**
 * True when the app is running as an installed PWA: the standard display-mode media query OR the legacy iOS
 * Safari `navigator.standalone` flag. (Shared with InstallBeacon — one definition of "installed app".)
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(display-mode: standalone)')?.matches) return true;
  } catch {
    /* matchMedia unavailable — fall through to the iOS flag */
  }
  try {
    return (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function detectClientMedium(): ClientMedium {
  return isStandaloneDisplay() ? 'app' : 'browser';
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

/** Same-origin `/api/...` only — never tag a third-party request (no header leaks to other hosts). */
export function isSameOriginApi(input: RequestInfo | URL): boolean {
  try {
    const raw = urlOf(input);
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const u = new URL(raw, origin);
    return u.origin === origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * The fetch `init` to use: unchanged for anything that is not a same-origin /api call; otherwise the same init with
 * the medium header added (an explicitly-set header is kept). Preserves a Request's own headers when `init` has none
 * (fetch replaces a Request's headers only when init.headers is given).
 */
export function withClientMedium(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  medium: ClientMedium = detectClientMedium(),
): RequestInit | undefined {
  if (!isSameOriginApi(input)) return init;
  const base =
    init?.headers !== undefined
      ? init.headers
      : typeof Request !== 'undefined' && input instanceof Request
        ? input.headers
        : undefined;
  const headers = new Headers(base);
  if (!headers.has(CLIENT_MEDIUM_HEADER)) headers.set(CLIENT_MEDIUM_HEADER, medium);
  return { ...(init ?? {}), headers };
}

/**
 * A write that changes NO data a cached read shows: an automatic/background request (X-Background: 1 — push
 * re-subscribe on every Bajaj load, install beacon) or any /api/push/* call. Clearing the read cache for these made
 * Profile re-fetch /api/sales/outlets + /api/sales/me seconds after the lists had loaded them (staging, 2026-11-21).
 */
export function isCacheNeutralWrite(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const path = new URL(raw, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').pathname;
    if (path.startsWith('/api/push/')) return true;
    const headers = new Headers(init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
    return headers.get(BACKGROUND_HEADER) === '1';
  } catch {
    return false; // unknown → treat as a real write (clearing is the safe side)
  }
}

let installed = false;

/** Patch window.fetch once (idempotent, browser-only, never throws). */
export function installClientMediumHeader(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  try {
    const original = window.fetch.bind(window);
    const patched: typeof window.fetch = (input, init) => {
      let nextInit = init;
      let write = false;
      try {
        nextInit = withClientMedium(input, init);
        // Request-volume work (2026-11-21): any same-origin /api WRITE clears the client read cache
        // (lib/session-cache.ts) when it starts AND when it settles, so a KYC submit / capture / redemption /
        // approval / settings save is followed by fresh reads — never a cached pre-write answer.
        write = isSameOriginApi(input) && isWriteMethod(methodOf(input, init)) && !isCacheNeutralWrite(input, nextInit);
        if (write) noteApiMutation('POST');
      } catch {
        nextInit = init; // tagging must never break a request
      }
      const res = original(input, nextInit);
      if (!write) return res;
      return res.finally(() => {
        try { noteApiMutation('POST'); } catch { /* never break a request */ }
      });
    };
    window.fetch = patched;
  } catch {
    installed = false;
  }
}

/** Test-only: forget the install so a test can patch a fresh window.fetch. */
export function __resetClientMediumForTests(): void {
  installed = false;
}
