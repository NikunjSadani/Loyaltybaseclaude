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

const PUBLIC_PATHS = [
  '/auth/login',
  '/api/auth/send-otp',
  '/api/auth/verify-otp',
  '/_next',
  '/favicon.ico',
]

const ROLE_ROUTES: Record<string, string[]> = {
  '/admin/gifsy': ['GIFSY_ADMIN'],                                                // Gifsy-internal only — checked before /admin
  '/admin':   ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'],
  '/sales':   ['HO', 'STATE_HEAD', 'ASM', 'SO', 'XSR', 'SALES_EXECUTIVE', 'TERRITORY_SALES_OFFICER', 'AREA_SALES_MANAGER', 'SALES_MANAGER'],
  '/partner': ['SSS', 'WHOLESALER', 'SUB_STOCKIST'],
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const headers = new Headers(request.headers)

  // ── Step 1: Tenant resolution ──────────────────────────────────────────────
  const hostname = request.headers.get('host') ?? request.nextUrl.hostname
  const slug     = resolveSlugFromHostname(hostname)

  if (slug === null) {
    // Bare domain / no subdomain — serve platform root without a tenant
    headers.set('x-tenant-slug',  '')
    headers.set('x-tenant-valid', 'false')
  } else {
    const clientConfig = resolveClientConfig(slug)

    if (!clientConfig) {
      // Unknown slug — rewrite to 404
      const url = request.nextUrl.clone()
      url.pathname = '/not-found'
      const res = NextResponse.rewrite(url, { request: { headers } })
      res.headers.set('x-tenant-slug',  slug)
      res.headers.set('x-tenant-valid', 'false')
      return res
    }

    headers.set('x-tenant-slug',  clientConfig.slug)
    headers.set('x-tenant-valid', 'true')
    headers.set('x-tenant-color', clientConfig.branding.primaryColor)
    headers.set('x-tenant-name',  clientConfig.branding.displayName)
  }

  // ── Step 2: Auth ───────────────────────────────────────────────────────────
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

  const token =
    request.headers.get('authorization')?.replace('Bearer ', '') ||
    request.cookies.get('token')?.value

  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  try {
    const secret = new TextEncoder().encode(
      process.env.JWT_SECRET || 'changeme-in-production-use-strong-secret'
    )
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

    headers.set('x-user-id',   payload.userId as string)
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
    '/((?!_next/static|_next/image|favicon.ico|logos/|favicons/|icons/|images/).*)',
  ],
}
