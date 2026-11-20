/**
 * POST /auth/session-refresh — SessionExpiryGuard's silent-refresh endpoint (S1/M3, 2026-11-20).
 *
 * Replaces calling the `refreshSession` server action from the guard. A failed server-action call
 * reaches the client only as an opaque thrown error, so the guard could not tell a dead session from
 * a blip — and the old workaround (letting server actions through the proxy unauthenticated) widened
 * the attack surface. A route handler answers a REAL status instead:
 *   200 { ok: true }                 — rotated; the new httpOnly cookies are set on this response
 *   401 { ok: false }                — the session is definitively dead (→ guard sends to login)
 *   503 { ok: false, transient: true } — could not refresh right now (→ guard keeps the session)
 *
 * It lives OUTSIDE /api (every /api/* path is rewritten to the backend before local handlers run) and
 * is a PUBLIC edge path: it is authenticated by the httpOnly refresh cookie itself.
 * CSRF: POST only, and it requires the custom `x-session-refresh: 1` header — a cross-site page can't
 * send that without a CORS preflight we never grant, and the session cookies are SameSite=Lax anyway.
 * A browser-reported cross-site request (Sec-Fetch-Site) is refused outright.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { refreshSession } from '@/lib/auth-actions';

export const dynamic = 'force-dynamic';

/** Header the guard must send (CSRF). Not exported: route files may only export handlers/config. */
const SESSION_REFRESH_HEADER = 'x-session-refresh';

const noStore = { 'cache-control': 'no-store' };

export async function POST(request: NextRequest) {
  if (request.headers.get(SESSION_REFRESH_HEADER) !== '1') {
    return NextResponse.json({ ok: false, error: 'Missing refresh header' }, { status: 400, headers: noStore });
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') {
    return NextResponse.json({ ok: false, error: 'Cross-site refresh refused' }, { status: 403, headers: noStore });
  }

  // Any failure of the exchange itself (sync or async) is TRANSIENT — never a logout.
  let result: { ok: boolean; transient?: boolean };
  try {
    result = await refreshSession();
  } catch {
    result = { ok: false, transient: true };
  }
  if (result.ok) return NextResponse.json({ ok: true }, { status: 200, headers: noStore });
  if (result.transient) {
    return NextResponse.json(
      { ok: false, transient: true },
      { status: 503, headers: { ...noStore, 'retry-after': '2' } },
    );
  }
  return NextResponse.json({ ok: false }, { status: 401, headers: noStore });
}
