/**
 * Next.js 16 Proxy (formerly Middleware).
 *
 * Handles JWT-based route protection and role-based access control.
 * The `middleware.ts` convention was renamed to `proxy.ts` in Next.js 16.
 *
 * Reads the JWT from:
 *   1. Authorization: Bearer <token> header
 *   2. `auth_token` cookie
 *
 * Route access matrix:
 *   /admin/*   → GIFSY_ADMIN, CLIENT_ADMIN, MIS_USER
 *   /sales/*   → SALES_MANAGER, AREA_SALES_MANAGER, TERRITORY_SALES_OFFICER, SALES_EXECUTIVE
 *   /partner/* → RETAILER, WHOLESALER, SUB_STOCKIST
 *   /api/*     → all authenticated users (per-route handlers enforce finer ACL)
 *   /login, /  → public
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth';
import type { TokenPayload } from '@/lib/auth';

// ─── Role sets ────────────────────────────────────────────────────────────────

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER']);

const SALES_ROLES = new Set([
  'SALES_MANAGER',
  'AREA_SALES_MANAGER',
  'TERRITORY_SALES_OFFICER',
  'SALES_EXECUTIVE',
]);

const PARTNER_ROLES = new Set(['RETAILER', 'WHOLESALER', 'SUB_STOCKIST']);

// ─── Public paths ─────────────────────────────────────────────────────────────

const PUBLIC_PATHS = new Set(['/', '/login', '/signup', '/forgot-password']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractToken(request: NextRequest): string | null {
  // 1. Authorization header
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Cookie
  const cookieToken = request.cookies.get('auth_token')?.value;
  return cookieToken ?? null;
}

function isAuthorized(role: string, pathname: string): boolean {
  if (pathname.startsWith('/admin')) return ADMIN_ROLES.has(role);
  if (pathname.startsWith('/sales')) return SALES_ROLES.has(role);
  if (pathname.startsWith('/partner')) return PARTNER_ROLES.has(role);
  // /api/* and other authenticated routes: any valid role allowed
  return true;
}

// ─── Proxy function ───────────────────────────────────────────────────────────

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Allow static assets, Next.js internals and public paths through
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/auth') || // auth endpoints are always public
    pathname.includes('.') // static files (favicon.ico, etc.)
  ) {
    return NextResponse.next();
  }

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // Extract + verify JWT
  const token = extractToken(request);
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  let payload: TokenPayload | null = null;
  try {
    payload = verifyToken(token);
  } catch {
    payload = null;
  }

  if (!payload) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Role-based access control
  if (!isAuthorized(payload.role, pathname)) {
    return NextResponse.json(
      { success: false, error: 'Forbidden: insufficient role' },
      { status: 403 }
    );
  }

  // Attach user identity to request headers for downstream route handlers
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-user-id', payload.userId);
  requestHeaders.set('x-user-role', payload.role);
  if (payload.partnerId) {
    requestHeaders.set('x-partner-id', payload.partnerId);
  }

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

// ─── Matcher ──────────────────────────────────────────────────────────────────

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
