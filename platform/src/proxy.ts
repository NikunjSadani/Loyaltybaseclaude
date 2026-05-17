import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

const PUBLIC_PATHS = [
  '/auth/login',
  '/api/auth/send-otp',
  '/api/auth/verify-otp',
  '/_next',
  '/favicon.ico',
]

const ROLE_ROUTES: Record<string, string[]> = {
  '/admin': ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'],
  '/sales': ['HO', 'STATE_HEAD', 'ASM', 'SO', 'ISR'],
  '/partner': ['RETAILER', 'WHOLESALER', 'SUB_STOCKIST'],
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next()

  if (pathname === '/') {
    return NextResponse.redirect(new URL('/auth/login', request.url))
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

    const headers = new Headers(request.headers)
    headers.set('x-user-id', payload.userId as string)
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
