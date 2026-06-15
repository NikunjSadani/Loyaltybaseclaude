import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'] as const;

const patchSchema = z.object({
  action: z.enum(['activate', 'deactivate']),
});

// PATCH /api/admin/credits/fields/[id]
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role as typeof ALLOWED_ROLES[number])) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);
  const denied = await requirePermission(user as { role: string; clientId: string },'credits:manage_fields');
  if (denied) return denied;
  const { id } = await params;

  const field = await prisma.creditField.findFirst({
    where: { id, clientId },
  });
  if (!field) return err('Field not found', 404);

  let body: unknown;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Validation error');

  const updated = await prisma.creditField.update({
    where: { id },
    data: { isActive: parsed.data.action === 'activate' },
  });

  return ok(updated);
}
