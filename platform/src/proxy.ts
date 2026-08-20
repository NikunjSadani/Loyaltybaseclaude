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

export const ROLE_ROUTES: Record<string, string[]> = {
  '/admin/gifsy': ['GIFSY_ADMIN'],                                                // Gifsy-internal only — checked before /admin
  '/admin':   ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'],
  '/sales':   ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'], // canonical UserRole enum — must match PORTAL_ROLES.sales (stale legacy codes here 307'd every sales login to /auth/login)
  '/partner': ['SSS', 'WHOLESALER', 'SUB_STOCKIST'],
}

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl
  const headers = new Headers(request.headers)
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

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
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
  // cookie past its maxAge, so `token` is typically ABSENT here) while the 7d refresh cookie
  // is still valid. Silently refresh SERVER-SIDE so the user isn't bounced to login ~hourly.
  const refreshToken = request.cookies.get('refresh_token')?.value
  if (refreshToken) {
    // A single refresh attempt. Parallel page requests may each land here; the backend's
    // rotation grace returns the successor tokens idempotently, so concurrent refreshes are safe.
    const refreshed = await refreshTokensViaBackend(refreshToken)
    if (refreshed) {
      let newPayload: JWTPayload | null = null
      try {
        newPayload = (await jwtVerify(refreshed.accessToken, secret)).payload
      } catch {
        newPayload = null
      }
      if (newPayload) {
        const res = forwardAuthed(request, headers, refreshed.accessToken, newPayload)
        // Persist the rotated pair on the outgoing response (access maxAge tracks the new
        // token's exp; refresh at 7d). Setting Set-Cookie is valid on both the next() and the
        // role-redirect responses forwardAuthed may return.
        res.cookies.set('token', refreshed.accessToken, sessionCookieOptions(accessCookieMaxAge(refreshed.accessToken)))
        if (refreshed.refreshToken) {
          res.cookies.set('refresh_token', refreshed.refreshToken, sessionCookieOptions(REFRESH_MAX_AGE))
        }
        return res
      }
    }
    // The refresh itself failed → the refresh token is truly dead/expired. Do NOT delete the
    // cookies (a contended/just-rotated refresh can fail transiently while the session is still
    // alive; deleting would strand other tabs). Bounce to login WITH ?expired=1 so the login
    // page surfaces the "session expired" notice.
    return NextResponse.redirect(new URL('/auth/login?expired=1', request.url))
  }

  // No refresh token at all → never established a session (or fully logged out) → plain login.
  return NextResponse.redirect(new URL('/auth/login', request.url))
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
    '/((?!_next/static|_next/image|favicon.ico|logos/|favicons/|icons/|images/|brand/|sw.js|offline.html).*)',
  ],
}
