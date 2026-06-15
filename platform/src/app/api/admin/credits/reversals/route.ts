import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

// GET /api/admin/credits/reversals — list reversals (GIFSY_ADMIN only)
// ?status=PENDING_GIFSY  — filter by status
// ?period=YYYY-MM        — filter by period
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'GIFSY_ADMIN') return err('Forbidden — GIFSY_ADMIN only', 403);

  const clientId = getClientIdFromRequest(req);
  const denied = await requirePermission(user as { role: string; clientId: string },'credits:read');
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') ?? undefined;
  const period = searchParams.get('period') ?? undefined;

  const where: Prisma.CreditReversalWhereInput = { clientId };
  if (status) where.status = status as Prisma.EnumCreditReversalStatusFilter | undefined;
  if (period) where.period = period;

  const reversals = await prisma.creditReversal.findMany({
    where,
    orderBy: { requestedAt: 'desc' },
  });

  return ok(reversals);
}
