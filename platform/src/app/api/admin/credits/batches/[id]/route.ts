import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'] as const;

// GET /api/admin/credits/batches/[id] — single batch with rows
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role as typeof ALLOWED_ROLES[number])) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);
  const denied = await requirePermission(user as { role: string; clientId: string },'credits:read');
  if (denied) return denied;
  const { id } = await params;

  const batch = await prisma.creditBatch.findFirst({
    where: { id, clientId },
  });
  if (!batch) return err('Batch not found', 404);

  return ok(batch);
}
