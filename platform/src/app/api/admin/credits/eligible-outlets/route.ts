import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'] as const;

// GET /api/admin/credits/eligible-outlets
// Returns active outlets belonging to active channel partners in this tenant.
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role as typeof ALLOWED_ROLES[number])) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);

  const outlets = await prisma.outlet.findMany({
    where: {
      isActive:  true,
      deletedAt: null,
      partner:   { clientId, isActive: true },
    },
    include: {
      outletType: { select: { code: true } },
    },
    orderBy: { outletCode: 'asc' },
  });

  const result = outlets.map((o) => ({
    id:    o.outletCode,
    name:  o.name,
    type:  o.outletType.code,
    phone: o.phone ?? undefined,
  }));

  return ok(result);
}
