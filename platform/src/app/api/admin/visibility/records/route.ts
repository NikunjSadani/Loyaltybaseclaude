/**
 * GET /api/admin/visibility/records
 *
 * Returns paginated OutletVisibilityRecord rows for the current client.
 * Partner roles (RETAILER, WHOLESALER, SUB_STOCKIST) are blocked.
 *
 * Query params:
 *   month  — YYYY-MM filter (optional)
 *   status — PENDING | UNDER_REVIEW | APPROVED (optional)
 *   page   — 1-indexed page number (default 1)
 *   limit  — rows per page, max 100 (default 50)
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) =>
  NextResponse.json({ success: true,  data   }, { status });
const err = (message: string, status: number) =>
  NextResponse.json({ success: false, error: message }, { status });

/** Partner roles are external traders — they cannot see admin visibility data */
const partnerRoles = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (partnerRoles.includes(authUser.role)) return err('Forbidden', 403);

    const clientId = getClientIdFromRequest(req);
    const { searchParams } = new URL(req.url);

    const month  = searchParams.get('month')  ?? '';
    const status = searchParams.get('status') ?? '';
    const page   = Math.max(1, parseInt(searchParams.get('page')  ?? '1',  10));
    const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)));
    const skip   = (page - 1) * limit;

    // Build Prisma where clause
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = { clientId };
    if (month)  where.month  = month;
    if (status) where.status = status;

    const [records, total] = await Promise.all([
      prisma.outletVisibilityRecord.findMany({
        where,
        orderBy: [{ month: 'desc' }, { outletCode: 'asc' }],
        skip,
        take: limit,
        include: {
          uploadBatch: {
            select: {
              fileName:         true,
              createdAt:        true,
              uploadedByUserId: true,
            },
          },
        },
      }),
      prisma.outletVisibilityRecord.count({ where }),
    ]);

    return ok({ records, total, page, limit });
  } catch (e) {
    console.error('[visibility/records] unexpected error:', e);
    return err('Internal server error', 500);
  }
}
