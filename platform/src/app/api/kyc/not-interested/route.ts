import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data   }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const schema = z.object({
  outletId: z.string().min(1, 'outletId is required'),
});

/**
 * POST /api/kyc/not-interested
 *
 * Mark an outlet as "Not Interested" by the sales agent.
 * - Sets outlet.kycIntent  = NOT_INTERESTED
 * - Sets outlet.isActive   = false  (deactivated)
 * - Records who and when
 *
 * Auth: any authenticated sales user.
 * The outletId in the request body corresponds to Outlet.outletCode.
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);

    const body   = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return err(parsed.error.issues[0].message);

    const { outletId } = parsed.data;

    // Look up the outlet by its outletCode (the public ID like OUT-2026-001)
    const outlet = await prisma.outlet.findUnique({
      where: { outletCode: outletId },
    });

    if (!outlet) return err(`Outlet "${outletId}" not found`, 404);
    if (!outlet.isActive && outlet.kycIntent === 'NOT_INTERESTED') {
      // Already marked — idempotent
      return ok({ outletId, alreadyMarked: true });
    }

    // Mark as not interested and deactivate
    await prisma.outlet.update({
      where: { outletCode: outletId },
      data: {
        kycIntent:   'NOT_INTERESTED',
        kycIntentBy: authUser.userId,
        kycIntentAt: new Date(),
        isActive:    false,
      },
    });

    return ok({ outletId, markedAt: new Date().toISOString() });
  } catch (e: any) {
    console.error('[kyc/not-interested]', e);
    return err('Internal server error', 500);
  }
}
