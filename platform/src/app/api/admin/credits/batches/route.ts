import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'] as const;

// ─── Batch code generator: CB-YYYY-MM-NNN ────────────────────────────────────

async function generateBatchCode(clientId: string, period: string): Promise<string> {
  const prefix = `CB-${period}`;
  const count = await prisma.creditBatch.count({
    where: { clientId, batchCode: { startsWith: prefix } },
  });
  return `${prefix}-${String(count + 1).padStart(3, '0')}`;
}

// GET /api/admin/credits/batches — list batches, newest first, no rows in list
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role as typeof ALLOWED_ROLES[number])) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);

  const batches = await prisma.creditBatch.findMany({
    where:   { clientId },
    orderBy: { uploadedAt: 'desc' },
    select: {
      id: true, batchCode: true, period: true, status: true,
      uploadedBy: true, uploadedAt: true,
      confirmedBy: true, confirmedAt: true,
      totalOutlets: true, totalPoints: true, totalPayoutInr: true,
    },
  });

  return ok(batches);
}

// POST /api/admin/credits/batches — create a new batch
const uploadRowSchema = z.object({
  rowNum:    z.number(),
  outletId:  z.string(),
  outletName: z.string(),
  fieldId:   z.string(),
  fieldName: z.string(),
  amount:    z.number(),
  narration: z.string().default(''),
  awardType: z.enum(['POINTS', 'PAYOUT']),
  status:    z.enum(['OK', 'ERROR', 'SKIP']),
  errors:    z.array(z.string()).default([]),
});

const createBatchSchema = z.object({
  period:        z.string().regex(/^\d{4}-\d{2}$/, 'Period must be YYYY-MM'),
  totalOutlets:  z.number().int().min(0),
  totalPoints:   z.number().min(0),
  totalPayoutInr: z.number().min(0),
  rows:          z.array(uploadRowSchema),
});

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role as typeof ALLOWED_ROLES[number])) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);

  let body: unknown;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const parsed = createBatchSchema.safeParse(body);
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Validation error');

  const { period, totalOutlets, totalPoints, totalPayoutInr, rows } = parsed.data;

  const batchCode = await generateBatchCode(clientId, period);

  const batch = await prisma.creditBatch.create({
    data: {
      clientId,
      batchCode,
      period,
      uploadedBy:    user?.userId ?? '',
      totalOutlets,
      totalPoints,
      totalPayoutInr,
      rows:          rows as object[],
    },
  });

  return ok(batch, 201);
}
