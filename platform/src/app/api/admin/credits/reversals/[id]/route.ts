import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const patchSchema = z.object({
  action:         z.enum(['approve', 'reject']),
  approvedAmount: z.number().positive().optional(),
  remarks:        z.string().optional(),
});

// PATCH /api/admin/credits/reversals/[id] — approve or reject
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'GIFSY_ADMIN') return err('Forbidden — GIFSY_ADMIN only', 403);

  const clientId = getClientIdFromRequest(req);
  const { id } = await params;

  const reversal = await prisma.creditReversal.findFirst({
    where: { id, clientId },
  });
  if (!reversal) return err('Reversal not found', 404);
  if (reversal.status !== 'PENDING_GIFSY') {
    return err(`Reversal is already ${reversal.status}`);
  }

  let body: unknown;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Validation error');

  const { action, approvedAmount, remarks } = parsed.data;

  if (action === 'approve' && approvedAmount !== undefined) {
    if (approvedAmount > Number(reversal.requestedAmount)) {
      return err('Approved amount cannot exceed requested amount');
    }
  }

  const newStatus =
    action === 'reject' ? 'REJECTED'
    : approvedAmount !== undefined && approvedAmount < Number(reversal.requestedAmount) ? 'PARTIAL'
    : 'APPROVED';

  const updated = await prisma.creditReversal.update({
    where: { id },
    data: {
      status:         newStatus,
      approvedAmount: action === 'approve' ? (approvedAmount ?? Number(reversal.requestedAmount)) : null,
      approvedBy:     user.userId,
      approvedAt:     new Date(),
      remarks:        remarks ?? null,
    },
  });

  return ok(updated);
}
