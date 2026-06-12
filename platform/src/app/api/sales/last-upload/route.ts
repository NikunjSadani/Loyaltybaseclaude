import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown) => NextResponse.json({ success: true,  data });
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

/**
 * GET /api/sales/last-upload
 *
 * Returns the createdAt timestamp of the most recent successful sales data
 * upload for the calling tenant.
 *
 * Multi-tenant: clientId is derived from the request (header / JWT); a tenant
 * can never read another tenant's upload timestamp.
 *
 * Response:
 *   { success: true, data: { lastUploadedAt: string | null } }
 */
export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return err('Unauthorized', 401);

  const clientId = getClientIdFromRequest(req);

  const latest = await prisma.salesUpload.findFirst({
    where: {
      clientId,
      status: { in: ['COMPLETED', 'PARTIALLY_COMPLETED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  return ok({ lastUploadedAt: latest?.createdAt?.toISOString() ?? null });
}
