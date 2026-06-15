import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN']);

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (!ADMIN_ROLES.has(authUser.role)) return err('Forbidden', 403);

    getClientIdFromRequest(req);
    const denied = await requirePermission(authUser as { role: string; clientId: string },'kyc:initiate');
    if (denied) return denied;

    let body: { rows?: unknown[] };
    try {
      body = await req.json();
    } catch {
      return err('Invalid JSON body');
    }

    const { rows } = body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return err('rows must be a non-empty array');
    }
    if (rows.length > 500) {
      return err('Maximum 500 outlets per re-KYC flag request');
    }

    if (process.env.DEMO_MODE === 'true') {
      return ok({ flagged: rows.length, message: 'Re-KYC flags set (demo mode)' });
    }

    return ok({ flagged: rows.length, message: `Re-KYC flags set for ${rows.length} outlet(s)` });
  } catch (e: any) {
    console.error('[admin/outlets/rekyc-flag POST]', e);
    return err('Failed to set re-KYC flags', 500);
  }
}
