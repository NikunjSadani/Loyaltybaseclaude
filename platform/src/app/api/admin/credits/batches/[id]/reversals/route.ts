import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'] as const;

// GET /api/admin/credits/batches/[id]/reversals
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

  const reversals = await prisma.creditReversal.findMany({
    where: { batchId: id, clientId },
    orderBy: { requestedAt: 'desc' },
  });

  return ok(reversals);
}

// POST /api/admin/credits/batches/[id]/reversals — initiate a reversal (credits:approve_reversal used for the initiation action)
const createSchema = z.object({
  outletId:        z.string(),
  outletName:      z.string(),
  fieldId:         z.string(),
  fieldName:       z.string(),
  awardType:       z.enum(['POINTS', 'PAYOUT']),
  originalAmount:  z.number().positive(),
  requestedAmount: z.number().positive(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role as typeof ALLOWED_ROLES[number])) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);
  const denied = await requirePermission(user as { role: string; clientId: string },'credits:approve_reversal');
  if (denied) return denied;
  const { id } = await params;

  const batch = await prisma.creditBatch.findFirst({
    where: { id, clientId },
  });
  if (!batch) return err('Batch not found', 404);
  if (batch.status === 'PENDING_CONFIRM') {
    return err('Cannot reverse a batch that has not been confirmed');
  }

  let body: unknown;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Validation error');

  const { outletId, outletName, fieldId, fieldName, awardType, originalAmount, requestedAmount } = parsed.data;

  if (requestedAmount > originalAmount) {
    return err('Requested reversal amount cannot exceed original amount');
  }

  // Check for existing pending reversal for the same outlet+field in this batch
  const existingPending = await prisma.creditReversal.findFirst({
    where: {
      batchId:  id,
      clientId,
      outletId,
      fieldId,
      status:   'PENDING_GIFSY',
    },
  });
  if (existingPending) {
    return err('A pending reversal already exists for this outlet and field in this batch');
  }

  const reversal = await prisma.creditReversal.create({
    data: {
      clientId,
      batchId:        id,
      outletId,
      outletName,
      fieldId,
      fieldName,
      period:         batch.period,
      awardType,
      originalAmount,
      requestedAmount,
      requestedBy:    user.userId,
    },
  });

  return ok(reversal, 201);
}
