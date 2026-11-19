/**
 * Next.js Edge Proxy (proxy.ts) — tenant resolution + auth.
 *
 * Runs on every request before any page or API route.
 *
 * Step 1 — Tenant resolution:
 *   Resolves the tenant slug from the hostname and forwards it as a
 *   request header so layouts and API routes can read it via next/headers.
 *   Headers set: x-tenant-slug, x-tenant-valid, x-tenant-color, x-tenant-name
 *
 * Step 2 — Auth:
 *   Validates JWT, enforces role-based route access.
 *   DEMO_MODE=true bypasses JWT and injects demo headers.
 */

import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server'
import { jwtVerify, type JWTPayload } from 'jose'
import { resolveTenantSync } from '@/lib/platform/tenant-resolution'
import { ensureWarm, refreshIfStale } from '@/lib/platform/tenant-routing-cache'
import { resolveTrustedHost } from '@/lib/platform/edge-trust'
import {
  REFRESH_MAX_AGE,
  accessCookieMaxAge,
  refreshTokensViaBackend,
  sessionCookieOptions,
  type RefreshOutcome,
} from '@/lib/auth-refresh'

// Refuse to run in production without a real JWT_SECRET — never fall back to a weak default.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set in production')
}

// DEMO_MODE skips JWT verification entirely (injects a GIFSY_ADMIN identity) — a full
// auth bypass that must NEVER be reachable in production. Fail closed at boot.
if (process.env.NODE_ENV === 'production' && process.env.DEMO_MODE === 'true') {
  throw new Error('DEMO_MODE must not be enabled in production')
}

const PUBLIC_PATHS = [
  '/auth/login',
  '/api/auth/send-otp',
  '/api/auth/verify-otp',
  // Tokenized media/document view endpoints (backend @Public — the signed, tenant-scoped,
  // single-object, expiring `token` query param is the SOLE authority; see
  // scheme-report.controller `viewMedia` + kyc.controller `viewDocument`). These links are
  // clicked from a DOWNLOADED .xlsx report (scheme enrollment media; outlet-master KYC docs),
  // which carries NO session cookie — so the edge auth gate below would 401 them before they
  // ever reach the @Public backend. They MUST bypass it. (startsWith is safe: the only routes
  // under either prefix are the two @Public GETs; nothing sensitive shares them.)
  '/api/schemes/media/view',
  '/api/kyc/documents/view',
  '/_next',
  '/favicon.ico',
]

// EXACT-match public paths (no prefix matching). `/api/public/branding-assets` streams tenant
// branding images (logo / wordmarks / favicon) that the SIGN-IN page and browser tab render
// BEFORE login; the backend route is @Public and only ever serves validated `branding/` image
// keys (api tenant-routing/public-branding-asset.controller.ts), so the edge must not 401 it.
const PUBLIC_EXACT_PATHS = new Set(['/api/public/branding-assets'])

/** Headers only the proxy may set on the forwarded request (any client-sent value is dropped). */
const INTERNAL_REQUEST_HEADERS = [
  'x-tenant-slug',
  'x-tenant-valid',
  'x-tenant-color', // legacy (no longer set, no reader) — still never trust a client value
  'x-tenant-name',  // legacy (no longer set, no reader)
  'x-pathname',
  'x-user-id',
  'x-user-role',
  'x-partner-id',
  'x-session-refreshed', // SESSION_REFRESHED_HEADER — set only by the proxy's silent refresh
  'x-session-refresh-failed', // SESSION_REFRESH_FAILED_HEADER — set only by the proxy (F3)
] as const

export const ROLE_ROUTES: Record<string, string[]> = {
  '/admin/gifsy': ['GIFSY_ADMIN'],                                                // Gifsy-internal only — checked before /admin
  // GIFSY_STAFF is admitted to the /admin portal (their home is /gifsy, but an ASSUMED
  // staff lands on /admin/* for the brand they picked — RBAC Option-X P5). The loop above
  // still enforces the /admin/gifsy entry independently, so staff remain blocked from the
  // owner-only /admin/gifsy pages; fine-grained per-page gating is done client-side
  // (AdminRouteGuard, which admits assumed staff) and per-endpoint in the backend. Omitting
  // GIFSY_STAFF here 307'd every assumed-staff brand click to /auth/login = infinite loop.
  '/admin':   ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER', 'GIFSY_STAFF'],
  '/sales':   ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'], // canonical UserRole enum — must match PORTAL_ROLES.sales (stale legacy codes here 307'd every sales login to /auth/login)
  '/partner': ['SSS', 'WHOLESALER', 'SUB_STOCKIST'],
}

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl
  const headers = new Headers(request.headers)
  // Strip every INTERNAL header a client could forge BEFORE anything else, so only this proxy
  // can set the values render code / route handlers trust (x-tenant-slug drives
  // getTenantConfig; x-user-* identity is only ever injected after JWT verification). Covers
  // every branch — including the unknown-host /not-found rewrite and the PUBLIC_PATHS
  // passthroughs, which previously forwarded a client-sent x-tenant-slug / x-user-* as-is.
  for (const h of INTERNAL_REQUEST_HEADERS) headers.delete(h)
  // Expose the request path to Server Components (root layout reads this to gate the
  // per-portal PWA <head> meta to /sales + /partner only).
  headers.set('x-pathname', pathname)

  // §A-DOMAIN Phase 2: cold-start warm + stale-while-revalidate for the DB routing map.
  // `ensureWarm` AWAITS a single fetch ONLY on a genuine cold start (null snapshot on a
  // fresh instance) so a DB-only BRANDED host (label ≠ slug) resolves to the right slug
  // on the very first request instead of the bare label; once warm it is instant. Then
  // `waitUntil` refreshes a stale-but-present snapshot in the background without blocking.
  // Both swallow their own errors (registry fallback), so neither can reject.
  await ensureWarm()
  if (event && typeof event.waitUntil === 'function') {
    event.waitUntil(refreshIfStale())
  } else {
    void refreshIfStale()
  }

  // ── Step 1: Tenant resolution ──────────────────────────────────────────────
  // S1 — only TRUST the client-controllable x-forwarded-host when the request came
  // through the edge worker (x-edge-secret). See lib/platform/edge-trust.ts.
  const hostname =
    resolveTrustedHost((n) => request.headers.get(n)) ??
    request.nextUrl.hostname
  // DB-aware sync resolution (DB map merged over registry; registry-only on cold
  // start). Returns both the slug and the branding-overlaid config in one pass.
  const { slug, config: clientConfig } = resolveTenantSync(hostname)

  if (slug === null) {
    // Bare domain / no subdomain — serve platform root without a tenant
    headers.set('x-tenant-slug',  '')
    headers.set('x-tenant-valid', 'false')
  } else {
    if (!clientConfig) {
      // The GIFSY operator console resolves to slug 'gifsy' — the platform operator,
      // NOT a tenant in CLIENT_REGISTRY. Let it through as a no-tenant platform context
      // (like the bare-domain branch above) rather than 404'ing the login page. Data
      // scope still comes from the JWT clientId, never this header. Any OTHER unknown
      // slug is a genuine 404.
      if (slug === 'gifsy') {
        headers.set('x-tenant-slug',  'gifsy')
        headers.set('x-tenant-valid', 'false')
      } else {
        const url = request.nextUrl.clone()
        url.pathname = '/not-found'
        const res = NextResponse.rewrite(url, { request: { headers } })
        res.headers.set('x-tenant-slug',  slug)
        res.headers.set('x-tenant-valid', 'false')
        return res
      }
    } else {
      headers.set('x-tenant-slug',  clientConfig.slug)
      headers.set('x-tenant-valid', 'true')
      // (x-tenant-color / x-tenant-name intentionally dropped — they had no reader and,
      //  now that branding is DB-influenced, an unsanitized value header is a needless
      //  sink. SSR branding is resolved via getTenantConfig(), not these headers.)
    }
  }

  // ── Step 2: Auth ───────────────────────────────────────────────────────────
  // PWA manifest routes (/sales/manifest.webmanifest, /partner/manifest.webmanifest)
  // are fetched by the browser with `credentials: omit` → no cookie → auth below would
  // 307 them to /auth/login and the install prompt would silently fail. Let them through
  // WITHOUT auth, but AFTER tenant resolution (Step 1) so the per-tenant manifest still
  // sees x-tenant-slug. (Can't exclude via the matcher — that would also drop the tenant
  // header and collapse every manifest to the default tenant.)
  if (pathname.endsWith('.webmanifest')) {
    return NextResponse.next({ request: { headers } })
  }

  if (PUBLIC_EXACT_PATHS.has(pathname) || PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next({ request: { headers } })
  }

  if (pathname === '/') {
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  // DEMO MODE: skip auth entirely
  if (process.env.DEMO_MODE === 'true') {
    headers.set('x-user-id',   'demo-admin-id')
    headers.set('x-user-role', 'GIFSY_ADMIN')
    return NextResponse.next({ request: { headers } })
  }

  // AF-6: the access token is read ONLY from the httpOnly `token` cookie — never from a
  // client-supplied Authorization header. The token is no longer mirrored to localStorage,
  // so a stored-XSS has nothing to exfiltrate. We strip any inbound Authorization header
  // (a page may still send a now-empty `Bearer null`) and INJECT our own from the cookie so
  // the backend's JwtStrategy (which reads `Authorization: Bearer`) keeps working unchanged
  // — the injected request headers ride the next.config `/api/*`→backend rewrite.
  headers.delete('authorization')

  // Wave 3 — active-outlet selection. The picker/switcher store the chosen ChannelPartner
  // id in the httpOnly `active_partner_id` cookie; we forward it to the backend as
  // `x-active-partner-id` (the backend RE-AUTHORIZES it — a foreign id → 403, so it's UX
  // state, not a credential). Hygiene: STRIP any client-supplied inbound value FIRST so the
  // header is set SOLELY from the cookie, never from a forged request header. Absent cookie →
  // no header → backend uses the login's own partner, byte-identical to today.
  headers.delete('x-active-partner-id')

  const token = request.cookies.get('token')?.value
  const isApi = pathname.startsWith('/api/')
  const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? '')

  // Verify the current access token, if we have one. A verify failure (expired signature or
  // tampered) leaves `payload` null and falls through to the refresh / 401 handling below.
  let payload: JWTPayload | null = null
  if (token) {
    try {
      payload = (await jwtVerify(token, secret)).payload
    } catch {
      payload = null
    }
  }

  // Happy path — a valid, unexpired access token: role-gate + forward with injected auth.
  if (token && payload) {
    return forwardAuthed(request, headers, token, payload)
  }

  // From here the access token is missing or expired/invalid.
  //
  // /api/* requests: keep 401ing. The client SessionExpiryGuard patch owns the XHR path —
  // it silently refreshes on the 401 and retries transparently, so the rolling session
  // trigger for active (XHR) use is UNCHANGED. Refreshing here would double-rotate.
  if (isApi) {
    return NextResponse.json(
      { success: false, error: token ? 'Invalid token' : 'Unauthorized' },
      { status: 401 },
    )
  }

  // PAGE navigation / hard reload: the ~60m access cookie has expired (the browser drops a
  // cookie past its maxAge, so `token` is typically ABSENT here) while the 30d refresh cookie
  // is still valid. Silently refresh SERVER-SIDE so the user isn't bounced to login ~hourly.
  const refreshToken = request.cookies.get('refresh_token')?.value
  if (refreshToken) {
    // One cold page load fans out into many parallel proxy hits (the document, RSC payloads,
    // prefetches, un-excluded assets) that ALL carry the same refresh cookie. They share ONE
    // in-flight backend refresh per refresh token in this instance (dedupe), and the backend
    // makes concurrent refreshes of the same token converge on one successor pair (claim +
    // mint in a single row-locked transaction) — see auth.service.ts refreshToken.
    const isDocument = isDocumentRequest(request)
    let outcome = await refreshAndVerify(refreshToken, secret)
    if (outcome.kind === 'transient' && isDocument && !isStaticAssetPath(pathname)) {
      // A document navigation decides the user's fate, so one TRANSIENT failure (network blip,
      // timeout, 5xx) must not log them out: retry ONCE after a short pause. A DEFINITE refusal
      // (401/403 — revoked, expired, swept, reuse) is never retried: it can't change, and a
      // replay of a refused token only adds noise. Static-asset paths never get the retry.
      await new Promise((resolve) => setTimeout(resolve, DOCUMENT_REFRESH_RETRY_DELAY_MS))
      outcome = await refreshAndVerify(refreshToken, secret)
    }
    if (outcome.kind === 'ok') {
      const { refreshed, payload: newPayload } = outcome
      // B1: tell route handlers / server actions in THIS request that the pair was already rotated
      // here (Next merges our Set-Cookie into their cookies()), so refreshSession must NOT rotate
      // again. Internal header — any client-sent value was stripped at the top of the proxy.
      headers.set(SESSION_REFRESHED_HEADER, '1')
      const res = forwardAuthed(request, headers, refreshed.accessToken, newPayload)
      // Persist the rotated pair on the outgoing response (access maxAge tracks the new
      // token's exp; refresh at 30d). Setting Set-Cookie is valid on both the next() and the
      // role-redirect responses forwardAuthed may return.
      res.cookies.set('token', refreshed.accessToken, sessionCookieOptions(accessCookieMaxAge(refreshed.accessToken)))
      if (refreshed.refreshToken) {
        res.cookies.set('refresh_token', refreshed.refreshToken, sessionCookieOptions(REFRESH_MAX_AGE))
      }
      return res
    }
    // The refresh failed. Do NOT delete the cookies either way (a transient failure leaves the
    // session alive; deleting would strand other tabs).
    if (request.headers.get('next-action')) {
      // F3 — a SERVER ACTION (notably refreshSession, fired by SessionExpiryGuard): a 401/503 here
      // reaches the client only as an opaque thrown error, so the guard could not tell a dead
      // session from a blip. Let the action run UNAUTHENTICATED instead (no Bearer / x-user-*
      // injected — every server action authenticates to the backend with its own cookies and the
      // backend validates them) and tell it what happened, so refreshSession returns a typed
      // { ok:false[, transient] } with HTTP 200. Internal header — stripped from client input.
      headers.set(SESSION_REFRESH_FAILED_HEADER, outcome.kind)
      return NextResponse.next({ request: { headers } })
    }
    if (!isDocument) {
      // NOT a document (RSC payload / prefetch / server action / asset): never redirect to login
      // from here — one such sub-request failing must not bounce the user. A non-OK response lets
      // the page-level request decide: an RSC navigation that gets one falls back to a full
      // document navigation (which retries above), a prefetch is dropped. 401 = the session is
      // definitely gone; 503 = transient (retryable).
      return outcome.kind === 'dead'
        ? NextResponse.json(
            { success: false, error: 'Unauthorized' },
            { status: 401, headers: { 'cache-control': 'no-store' } },
          )
        : NextResponse.json(
            { success: false, error: 'Session refresh temporarily unavailable' },
            { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '1' } },
          )
    }
    // A document whose refresh definitively failed (or failed transiently twice) → bounce to
    // login WITH ?expired=1 so the login page surfaces the "session expired" notice.
    return NextResponse.redirect(new URL('/auth/login?expired=1', request.url))
  }

  // No refresh token at all → never established a session (or fully logged out) → plain login.
  return NextResponse.redirect(new URL('/auth/login', request.url))
}

/** Pause before the single retry of a TRANSIENTLY failed document-navigation refresh. */
export const DOCUMENT_REFRESH_RETRY_DELAY_MS = 200

/**
 * Internal request header the proxy sets on the FORWARDED request when it rotated the session in
 * this request. `refreshSession` (lib/auth-actions.ts) reads it to avoid a second rotation.
 */
export const SESSION_REFRESHED_HEADER = 'x-session-refreshed'

/**
 * Internal request header carrying a FAILED proxy refresh's outcome ('dead' | 'transient') to a
 * server action (F3). refreshSession uses it to answer without a second backend exchange.
 */
export const SESSION_REFRESH_FAILED_HEADER = 'x-session-refresh-failed'

/**
 * Static-asset paths (by file extension or a known public asset folder). A request for one is
 * never worth the document retry, even when it lacks Sec-Fetch-Dest (old / non-browser client).
 */
const STATIC_ASSET_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|json|txt|xml|webmanifest|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf)$/i
export function isStaticAssetPath(pathname: string): boolean {
  return STATIC_ASSET_EXT.test(pathname)
}

/**
 * Is this a top-level DOCUMENT navigation (the request that decides whether to show login)?
 * Everything else — RSC payload fetches (`RSC: 1`), router/browser prefetches, server-action
 * POSTs (`Next-Action`), and sub-resources (`Sec-Fetch-Dest` image/script/style/empty/…) — is
 * NOT, and must never redirect to login on a failed refresh. With no Sec-Fetch-Dest at all
 * (an old or non-browser client) we keep the pre-existing behaviour and treat it as a document
 * (the caller still skips the retry for static-asset paths).
 */
export function isDocumentRequest(request: NextRequest): boolean {
  const h = request.headers
  if (h.get('rsc') || h.get('next-router-prefetch') || h.get('next-action')) return false
  const purpose = `${h.get('purpose') ?? ''} ${h.get('sec-purpose') ?? ''}`.toLowerCase()
  if (purpose.includes('prefetch')) return false
  const dest = h.get('sec-fetch-dest')
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'frame'
  return true
}

/**
 * In-flight refreshes keyed by a SHA-256 of the refresh token (the raw token is never used as
 * a key, logged, or retained after settle). Concurrent proxy hits for the same refresh cookie
 * in this instance share ONE backend call; the entry is removed as soon as it settles, so a
 * later (retry) attempt always makes a fresh call and nothing outlives the request burst.
 */
const inflightRefreshes = new Map<string, Promise<RefreshOutcome>>()

async function refreshKey(refreshToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Exported for tests: one backend refresh per refresh token at a time, in this instance. */
export async function dedupedRefresh(refreshToken: string): Promise<RefreshOutcome> {
  const key = await refreshKey(refreshToken)
  const existing = inflightRefreshes.get(key)
  if (existing) return existing
  const pending = refreshTokensViaBackend(refreshToken).finally(() => {
    inflightRefreshes.delete(key)
  })
  inflightRefreshes.set(key, pending)
  return pending
}

type VerifiedOutcome =
  | { kind: 'ok'; refreshed: { accessToken: string; refreshToken?: string }; payload: JWTPayload }
  | { kind: 'dead' }
  | { kind: 'transient' }

/** Refresh (deduped) and verify the new access token. An unverifiable token counts as `dead`. */
async function refreshAndVerify(refreshToken: string, secret: Uint8Array): Promise<VerifiedOutcome> {
  const outcome = await dedupedRefresh(refreshToken)
  if (outcome.kind !== 'ok') return { kind: outcome.kind }
  try {
    return {
      kind: 'ok',
      refreshed: { accessToken: outcome.accessToken, refreshToken: outcome.refreshToken },
      payload: (await jwtVerify(outcome.accessToken, secret)).payload,
    }
  } catch {
    return { kind: 'dead' }
  }
}

/**
 * Role-gate a verified identity and forward the request to the backend with the injected auth
 * headers. Returns a role-failure redirect to /auth/login, or the next() passthrough carrying
 * the Bearer + identity headers. `headers` has already had any inbound authorization /
 * x-active-partner-id stripped by the caller.
 */
function forwardAuthed(
  request: NextRequest,
  headers: Headers,
  token: string,
  payload: JWTPayload,
): NextResponse {
  const { pathname } = request.nextUrl
  const role = payload.role as string

  for (const [prefix, allowedRoles] of Object.entries(ROLE_ROUTES)) {
    if (pathname.startsWith(prefix) && !allowedRoles.includes(role)) {
      // ROLE_ROUTES lists only PAGE prefixes (/admin, /admin/gifsy, /sales, /partner) —
      // an /api/* path never matches one (it starts with '/api/'), so a wrong-role match
      // here is always a page request → redirect to login. API-route role enforcement is
      // the BACKEND's job (the NestJS role guards on each endpoint); the edge proxy only
      // authenticates the /api/* request (Bearer injection below) and gates PAGE access.
      return NextResponse.redirect(new URL('/auth/login', request.url))
    }
  }

  // Hand the verified token to the backend as a Bearer header.
  headers.set('authorization', `Bearer ${token}`)
  headers.set('x-user-id',   payload.sub as string) // JWT user id is the `sub` claim, not `userId`
  headers.set('x-user-role', role)
  if (payload.partnerId) headers.set('x-partner-id', payload.partnerId as string)

  // Wave 3 — inject the active-outlet selection SOLELY from the httpOnly cookie (the
  // inbound header was stripped above). Only set when present, so the absent-cookie
  // path is byte-identical to today. The backend re-authorizes the id (foreign → 403).
  const activePartnerId = request.cookies.get('active_partner_id')?.value
  if (activePartnerId) headers.set('x-active-partner-id', activePartnerId)

  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: [
    // sw.js + offline.html are static PUBLIC PWA assets — they MUST be fetchable
    // without auth (the browser fetches /sw.js to register the service worker), so
    // they are excluded from the auth middleware like the other static prefixes.
    // `brand/` holds the per-tenant wordmarks (public/brand/*.png) — the LOGIN page (no
    // token) renders them, so without this exclusion each wordmark 307s to /auth/login →
    // broken image on the sign-in screen.
    // `Logos/` (capital L) is the folder actually committed under public/ (bajaj.png,
    // deoleo*.png); the lowercase `logos/` entry matches nothing on a case-sensitive host,
    // so without it a pre-auth request for /Logos/* was 307'd to /auth/login.
    '/((?!_next/static|_next/image|favicon.ico|logos/|Logos/|favicons/|icons/|images/|brand/|sw.js|offline.html).*)',
  ],
}
