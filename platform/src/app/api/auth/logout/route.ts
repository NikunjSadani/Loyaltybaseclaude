import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { revokeSession } from '@/lib/session';

const ok = (data: unknown, status = 200) =>
  NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) =>
  NextResponse.json({ success: false, error: message }, { status });

/**
 * POST /api/auth/logout
 *
 * Revokes the current device's session (identified by `sid` in the JWT) and
 * clears the `token` cookie so cookie-based clients are logged out client-side.
 *
 * - Requires authentication (getAuthUser must return a non-null identity).
 * - If `sid` is absent (DEMO_MODE path) the revoke is skipped; still returns 200.
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);

    // Revoke the current device's session only when a real sid is present.
    // DEMO_MODE tokens carry no sid — guard prevents a crash there.
    if (authUser.sid) {
      await revokeSession(authUser.sid);
    }

    const response = ok({ message: 'Logged out' });

    // Clear the token cookie so cookie-based clients are immediately logged out.
    response.headers.set(
      'Set-Cookie',
      'token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );

    return response;
  } catch (e: unknown) {
    console.error('[auth/logout]', e);
    return err('Logout failed', 500);
  }
}
