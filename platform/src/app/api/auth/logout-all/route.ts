import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { revokeAllSessionsForUser } from '@/lib/session';

const ok = (data: unknown, status = 200) =>
  NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) =>
  NextResponse.json({ success: false, error: message }, { status });

/**
 * POST /api/auth/logout-all
 *
 * Revokes every active session for the authenticated user (all devices) and
 * clears the `token` cookie so the current client is also logged out.
 *
 * - Requires authentication (getAuthUser must return a non-null identity).
 * - Returns the number of sessions that were revoked in the response body.
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);

    const count = await revokeAllSessionsForUser(authUser.userId);

    const response = ok({ message: 'Logged out of all devices', revoked: count });

    // Clear the token cookie so cookie-based clients are immediately logged out.
    response.headers.set(
      'Set-Cookie',
      'token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );

    return response;
  } catch (e: unknown) {
    console.error('[auth/logout-all]', e);
    return err('Logout failed', 500);
  }
}
