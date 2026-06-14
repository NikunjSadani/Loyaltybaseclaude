import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'] as const;

// GET /api/admin/credits/fields
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role as typeof ALLOWED_ROLES[number])) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);
  const url = new URL(req.url);
  const activeOnly = url.searchParams.get('active') === 'true';

  const fields = await prisma.creditField.findMany({
    where: {
      clientId,
      ...(activeOnly ? { isActive: true } : {}),
    },
    orderBy: { order: 'asc' },
  });

  return ok(fields);
}

// POST /api/admin/credits/fields
const createSchema = z.object({
  name:            z.string().min(1, 'Name is required'),
  isSeparatePayout: z.boolean().default(false),
  outletTypeAwards: z.record(z.string(), z.string()).default({}),
});

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role as typeof ALLOWED_ROLES[number])) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);

  let body: unknown;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Validation error');

  const { name, isSeparatePayout, outletTypeAwards } = parsed.data;

  // Check duplicate name for this client
  const existing = await prisma.creditField.findFirst({
    where: { clientId, name },
  });
  if (existing) return err(`A field named "${name}" already exists.`);

  // Determine next order
  const maxOrderField = await prisma.creditField.findFirst({
    where: { clientId },
    orderBy: { order: 'desc' },
  });
  const nextOrder = (maxOrderField?.order ?? 0) + 1;

  const field = await prisma.creditField.create({
    data: {
      clientId,
      name,
      isSeparatePayout,
      outletTypeAwards: outletTypeAwards as object,
      order: nextOrder,
    },
  });

  return ok(field, 201);
}
