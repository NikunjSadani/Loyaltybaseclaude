/**
 * GET /api/admin/sales/batches
 *
 * Returns the upload batch history for the calling tenant, newest first.
 * Used by the admin/sales page to render the "Upload History" section
 * and surface delete controls.
 *
 * Auth:   CLIENT_ADMIN and GIFSY_ADMIN only.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'];

const ok  = (data: unknown) => NextResponse.json({ success: true,  data  });
const err = (msg: string, status: number) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role)) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);
  if (!clientId) return err('Missing tenant context', 400);

  try {
    const batches = await prisma.salesUploadBatch.findMany({
      where:   { clientId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id:            true,
        month:         true,
        totalRows:     true,
        acceptedCount: true,
        rejectedCount: true,
        status:        true,
        createdAt:     true,
      },
    });
    return ok(batches);
  } catch (dbErr: any) {
    // DB unreachable in local dev (Cloud SQL private VPC) — return empty list
    // so the UI shows "No uploads yet" rather than crashing.
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[admin/sales/batches GET] DB unavailable in dev — returning empty list');
      return ok([]);
    }
    console.error('[admin/sales/batches GET]', dbErr);
    return err('Failed to fetch upload history', 500);
  }
}
