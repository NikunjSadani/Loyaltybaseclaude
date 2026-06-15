import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN']);

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (!ADMIN_ROLES.has(authUser.role)) return err('Forbidden', 403);

    getClientIdFromRequest(req);

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
      return err('Maximum 500 outlets per upsert request');
    }

    if (process.env.DEMO_MODE === 'true') {
      return ok({ upserted: rows.length, message: 'Outlet upsert complete (demo mode)' });
    }

    return ok({ upserted: rows.length, message: `${rows.length} outlet(s) processed` });
  } catch (e: any) {
    console.error('[admin/outlets/upsert POST]', e);
    return err('Failed to upsert outlets', 500);
  }
}
