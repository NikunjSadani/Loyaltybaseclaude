/// <reference lib="webworker" />
// -----------------------------------------------------------------------------
// Loyaltybase PWA service worker (Serwist) — PWA phase F3.
//
// SHIPPED DISABLED. The browser only ever installs this SW if
// `ServiceWorkerRegister` registers it, and that component is gated behind the
// OFF-by-default flag `NEXT_PUBLIC_PWA_SW_ENABLED === 'true'` AND a /sales|/partner
// pathname check. With the flag unset, this file is built but never loaded by any
// client, so it cannot affect the current UAT.
//
// 🔴 MULTI-TENANT SECURITY (load-bearing — a mis-cached response = cross-tenant /
//    cross-session data leak):
//   - `/api/*` is NetworkOnly (never cached). All authenticated, tenant-scoped
//     JSON flows through `/api/*`.
//   - 🔴 Server navigations here are authenticated by the `token` COOKIE, NOT an
//     Authorization header (Bearer is only attached client-side to `/api/*` XHRs).
//     So navigations / RSC payloads / `/_next/data` are server-rendered with
//     per-tenant, per-session data yet carry NO auth header. They are therefore
//     ALL NetworkOnly — caching any of them would leak one user's/tenant's
//     rendered shell to the next session on a shared device. We deliberately do
//     NOT use Serwist's `defaultCache` (it NetworkFirst-caches exactly these
//     RSC/HTML/page-data responses). On offline, the precached static
//     /offline.html is served via `fallbacks` (it contains no session data).
//   - Only NON-sensitive, public static assets are cached: Next's content-hashed
//     build output (/_next/static, immutable) + public icons/fonts/images.
//     Content-hashing => automatic invalidation on every deploy.
//   - skipWaiting is NOT called automatically here; the client-side update prompt
//     calls it via postMessage so the user is at most one load behind, never
//     forced to reload mid-action.
// -----------------------------------------------------------------------------
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkOnly,
  Serwist,
  StaleWhileRevalidate,
} from 'serwist';

// Serwist injects the precache manifest of content-hashed build assets here.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Offline fallback document precached with the build (must exist in /public).
const OFFLINE_FALLBACK_URL = '/offline.html';

const serwist = new Serwist({
  // Precache ONLY the static app shell. No API, no tenant-scoped HTML.
  // Precache Next's content-hashed build assets PLUS the offline fallback. The
  // offline doc is given an explicit revision so it is precached (and so the
  // `fallbacks` entry below can be served with no network).
  precacheEntries: [
    ...(self.__SW_MANIFEST ?? []),
    { url: OFFLINE_FALLBACK_URL, revision: null },
  ],
  // (Serwist v9 drops precaches from prior SW versions automatically on activate.)
  // We deliberately do NOT auto-skipWaiting. The new SW waits until the client's
  // "New version available — Refresh" prompt explicitly tells it to activate.
  skipWaiting: false,
  // Take control of open clients as soon as we DO activate (post-prompt), so the
  // reload lands on the new SW immediately.
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // 1) HARD RULE — never cache the API surface. Same-origin `/api/*` proxies to
    //    the tenant-scoped NestJS backend. NetworkOnly => pure pass-through.
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/api/'),
      handler: new NetworkOnly(),
    },
    // 2) Belt-and-braces: never cache anything carrying an Authorization header
    //    (client-side authed XHRs are inherently per-user/per-tenant).
    {
      matcher: ({ request }) => request.headers.has('authorization'),
      handler: new NetworkOnly(),
    },
    // 3) 🔴 Never cache React Server Component / router-prefetch payloads. They
    //    embed per-tenant, per-session server-rendered data and are authed by the
    //    `token` COOKIE (no auth header) — so rules 1–2 do NOT catch them.
    {
      matcher: ({ request }) =>
        request.headers.has('RSC') || request.headers.has('Next-Router-Prefetch'),
      handler: new NetworkOnly(),
    },
    // 4) 🔴 Never cache navigations / HTML documents — server-rendered with
    //    tenant/user data. On network failure, `fallbacks` (below) serves the
    //    precached static /offline.html, which holds NO session data.
    {
      matcher: ({ request }) => request.mode === 'navigate',
      handler: new NetworkOnly(),
    },
    // 5) 🔴 Never cache Next data payloads — also per-session/per-tenant.
    {
      matcher: ({ url, sameOrigin }) =>
        sameOrigin && url.pathname.startsWith('/_next/data/'),
      handler: new NetworkOnly(),
    },
    // 6) Content-hashed, immutable build assets — CacheFirst is safe because the
    //    filename hash changes on every deploy (automatic invalidation).
    {
      matcher: ({ url, sameOrigin }) =>
        sameOrigin && url.pathname.startsWith('/_next/static/'),
      handler: new CacheFirst({
        cacheName: 'next-static',
        plugins: [
          new ExpirationPlugin({ maxEntries: 256, maxAgeSeconds: 365 * 24 * 60 * 60 }),
        ],
      }),
    },
    // 7) Public, NON-sensitive static assets only — icons/fonts/images (e.g.
    //    /icons/<slug>/…, /logos/…). These carry no tenant DATA (per-tenant
    //    branding art is public by nature). Cross-origin (GCS KYC docs etc.) is
    //    NOT same-origin, so it is never matched here.
    {
      matcher: ({ request, sameOrigin }) =>
        sameOrigin && ['image', 'font', 'style'].includes(request.destination),
      handler: new StaleWhileRevalidate({
        cacheName: 'static-assets',
        plugins: [
          new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 30 * 24 * 60 * 60 }),
        ],
      }),
    },
    // 8) Default-deny: anything else same-origin is NOT cached. (No `defaultCache`
    //    spread — it would NetworkFirst-cache the RSC/HTML/page-data above.)
    {
      matcher: ({ sameOrigin }) => sameOrigin,
      handler: new NetworkOnly(),
    },
  ],
  // Append the offline fallback to the precache so it's available with no network.
  fallbacks: {
    entries: [
      {
        url: OFFLINE_FALLBACK_URL,
        matcher: ({ request }) => request.destination === 'document',
      },
    ],
  },
});

// Allow the update prompt to trigger activation of the waiting SW.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

serwist.addEventListeners();
