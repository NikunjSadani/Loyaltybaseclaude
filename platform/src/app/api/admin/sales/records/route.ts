/**
 * GET /api/admin/sales/records
 *
 * Returns OutletSalesRecord rows for a given month (and optionally outlet type).
 *
 * Auth:   CLIENT_ADMIN and GIFSY_ADMIN only.
 * Method: GET
 *   Query params:
 *     month        — "YYYY-MM" (required)
 *     outletType   — one of RETAILER | WHOLESALER | SUB_STOCKIST | SSS_TOT (optional)
 *     limit        — max rows to return (default 1000)
 *
 * Response:
 *  {
 *    data: OutletSalesRecord[],
 *    count: number
 *  }
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'];

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const user = await getAuthUser(req);
  if (!user || !ALLOWED_ROLES.includes(user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const clientId = getClientIdFromRequest(req);
  if (!clientId) {
    return NextResponse.json({ error: 'Missing tenant context' }, { status: 400 });
  }

  // ── Query params ───────────────────────────────────────────────────────────
  const { searchParams } = new URL(req.url);
  const month      = searchParams.get('month') ?? '';
  const outletType = searchParams.get('outletType') ?? undefined;
  const limit      = Math.min(Number(searchParams.get('limit') ?? '1000'), 10000);

  if (!month) {
    return NextResponse.json({ error: 'month query param is required' }, { status: 400 });
  }

  // ── Query DB ───────────────────────────────────────────────────────────────
  const records = await prisma.outletSalesRecord.findMany({
    where: {
      clientId,
      month,
      ...(outletType ? { outletType } : {}),
    },
    orderBy: { outletCode: 'asc' },
    take: limit,
  });

  return NextResponse.json({ data: records, count: records.length });
}
