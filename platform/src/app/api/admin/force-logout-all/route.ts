import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { revokeAllSessions } from '@/lib/session';
import prisma from '@/lib/prisma';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok = (data: unknown, status = 200) =>
  NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) =>
  NextResponse.json({ success: false, error: message }, { status });

/**
 * POST /api/admin/force-logout-all
 *
 * Platform-wide force logout — revokes every active session across ALL users
 * and ALL tenants. Intended for use before rolling out updates that require
 * users to re-authenticate (e.g. JWT secret rotation, security patches).
 *
 * GIFSY_ADMIN ONLY — CLIENT_ADMIN is explicitly rejected because this action
 * is cross-tenant and must not be available to per-tenant administrators.
 *
 * After revoking all sessions, writes an AuditLog entry so the action is
 * traceable. The entityId is set to 'ALL' to indicate the platform-wide scope.
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);

    // GIFSY_ADMIN only — CLIENT_ADMIN and all other roles are rejected.
    // This is a cross-tenant operation; tenant-scoped admins must not trigger it.
    if (authUser.role !== 'GIFSY_ADMIN') {
      return err('Forbidden — Gifsy Admin only', 403);
    }

    const denied = await requirePermission(authUser as { role: string; clientId: string },'users:manage_roles');
    if (denied) return denied;

    const count = await revokeAllSessions();

    await prisma.auditLog.create({
      data: {
        action: 'LOGOUT',
        entityType: 'SESSION',
        entityId: 'ALL',
        actorId: authUser.userId,
        metadata: { revoked: count, reason: 'force-logout-all' },
      },
    });

    return ok({ message: 'All users logged out', revoked: count });
  } catch (e: unknown) {
    console.error('[admin/force-logout-all]', e);
    return err('Force logout failed', 500);
  }
}
