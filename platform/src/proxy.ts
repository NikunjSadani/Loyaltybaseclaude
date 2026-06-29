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

import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { resolveSlugFromHostname, resolveClientConfig } from '@/lib/platform/tenant-resolution'

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
  '/_next',
  '/favicon.ico',
]

export const ROLE_ROUTES: Record<string, string[]> = {
  '/admin/gifsy': ['GIFSY_ADMIN'],                                                // Gifsy-internal only — checked before /admin
  '/admin':   ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'],
  '/sales':   ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'], // canonical UserRole enum — must match PORTAL_ROLES.sales (stale legacy codes here 307'd every sales login to /auth/login)
  '/partner': ['SSS', 'WHOLESALER', 'SUB_STOCKIST'],
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const headers = new Headers(request.headers)
  // Expose the request path to Server Components (root layout reads this to gate the
  // per-portal PWA <head> meta to /sales + /partner only).
  headers.set('x-pathname', pathname)

  // ── Step 1: Tenant resolution ──────────────────────────────────────────────
  const hostname =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    request.nextUrl.hostname
  const slug     = resolveSlugFromHostname(hostname)

  if (slug === null) {
    // Bare domain / no subdomain — serve platform root without a tenant
    headers.set('x-tenant-slug',  '')
    headers.set('x-tenant-valid', 'false')
  } else {
    const clientConfig = resolveClientConfig(slug)

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
      headers.set('x-tenant-color', clientConfig.branding.primaryColor)
      headers.set('x-tenant-name',  clientConfig.branding.displayName)
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
  const token = request.cookies.get('token')?.value

  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? '')
    const { payload } = await jwtVerify(token, secret)
    const role = payload.role as string

    for (const [prefix, allowedRoles] of Object.entries(ROLE_ROUTES)) {
      if (pathname.startsWith(prefix) && !allowedRoles.includes(role)) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
        }
        return NextResponse.redirect(new URL('/auth/login', request.url))
      }
    }

    // Hand the verified cookie token to the backend as a Bearer header.
    headers.set('authorization', `Bearer ${token}`)
    headers.set('x-user-id',   payload.sub as string) // JWT user id is the `sub` claim, not `userId`
    headers.set('x-user-role', role)
    if (payload.partnerId) headers.set('x-partner-id', payload.partnerId as string)

    return NextResponse.next({ request: { headers } })
  } catch {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }
}

export const config = {
  matcher: [
    // sw.js + offline.html are static PUBLIC PWA assets — they MUST be fetchable
    // without auth (the browser fetches /sw.js to register the service worker), so
    // they are excluded from the auth middleware like the other static prefixes.
    '/((?!_next/static|_next/image|favicon.ico|logos/|favicons/|icons/|images/|sw.js|offline.html).*)',
  ],
}
