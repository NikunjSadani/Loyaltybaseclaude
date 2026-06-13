/**
 * DELETE /api/admin/sales/batches/[batchId]
 *
 * Deletes a SalesUploadBatch and all its OutletSalesRecord rows (cascade
 * is defined in the Prisma schema: OutletSalesRecord.batch onDelete: Cascade).
 *
 * Guards:
 *  - 401 if unauthenticated
 *  - 403 if role is not CLIENT_ADMIN / GIFSY_ADMIN
 *  - 404 if batchId not found
 *  - 403 if batch belongs to a different tenant (cross-tenant guard)
 *
 * Auth:   CLIENT_ADMIN and GIFSY_ADMIN only.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'];

const ok  = (data: unknown) => NextResponse.json({ success: true,  data  });
const err = (msg: string, status: number) => NextResponse.json({ success: false, error: msg }, { status });

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const user = getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role)) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);
  if (!clientId) return err('Missing tenant context', 400);

  const { batchId } = await ctx.params;

  try {
    // ── Fetch batch ─────────────────────────────────────────────────────────
    const batch = await prisma.salesUploadBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) return err('Batch not found', 404);

    // ── Cross-tenant guard ──────────────────────────────────────────────────
    if (batch.clientId !== clientId) return err('Forbidden', 403);

    // ── Count records before delete (cascade removes them) ─────────────────
    const deletedRecordCount = await prisma.outletSalesRecord.count({
      where: { batchId },
    });

    // ── Delete (cascade removes OutletSalesRecord rows automatically) ───────
    await prisma.salesUploadBatch.delete({ where: { id: batchId } });

    return ok({ deletedBatchId: batchId, deletedRecordCount });
  } catch (dbErr: any) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[admin/sales/batches DELETE] DB unavailable in dev');
      return err('Database unavailable in local dev — use production to delete real batches', 503);
    }
    console.error('[admin/sales/batches DELETE]', dbErr);
    return err('Failed to delete batch', 500);
  }
}
