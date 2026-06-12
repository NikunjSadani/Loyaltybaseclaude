/**
 * POST /api/admin/outlets/bulk-delete
 *
 * Soft-deletes multiple outlets in a single request.
 * Sets Outlet.deletedAt = now and Outlet.isActive = false.
 * Also closes all open SalesUserAssignment records for the deleted outlets.
 *
 * Body: { outletIds: string[] }
 *   outletIds — Prisma CUID ids (not outletCode strings).
 *   Max 200 per request.
 *
 * Admin-only.
 */

import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN'])
const ok  = (data: any) => NextResponse.json({ success: true,  data  })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req)
  if (!authUser)                       return err('Unauthorized', 401)
  if (!ADMIN_ROLES.has(authUser.role)) return err('Forbidden', 403)
  const clientId = getClientIdFromRequest(req)

  let body: any
  try {
    body = await req.json()
  } catch {
    return err('Invalid JSON body')
  }

  const { outletIds } = body

  if (!Array.isArray(outletIds) || outletIds.length === 0) {
    return err('outletIds must be a non-empty array')
  }
  if (outletIds.length > 200) {
    return err('Maximum 200 outlets per bulk-delete request')
  }

  // ── DEMO_MODE ─────────────────────────────────────────────────────────────
  if (process.env.DEMO_MODE === 'true') {
    return ok({ deleted: outletIds.length, message: 'Bulk delete complete (demo mode)' })
  }

  // Verify outlets exist and are not already deleted (scoped to tenant)
  const outlets = await prisma.outlet.findMany({
    where:  { id: { in: outletIds }, deletedAt: null, partner: { user: { clientId } } },
    select: { id: true },
  })

  if (outlets.length === 0) {
    return err('No active outlets found for the given IDs')
  }

  const activeOutletIds = outlets.map(o => o.id)
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    // Soft-delete outlets
    await tx.outlet.updateMany({
      where: { id: { in: activeOutletIds } },
      data:  { deletedAt: now, isActive: false },
    })

    // Close all open SalesUserAssignments for these outlets
    await tx.salesUserAssignment.updateMany({
      where: { outletId: { in: activeOutletIds }, unassignedAt: null },
      data:  { unassignedAt: now },
    })

    // Audit log
    await tx.auditLog.create({
      data: {
        action:     'DELETE',
        entityType: 'OUTLET',
        entityId:   'BULK',
        actorId:    authUser.userId,
        oldValues:  { outletIds: activeOutletIds },
        metadata:   { action: 'bulk_soft_delete', count: activeOutletIds.length },
      },
    })
  })

  return ok({
    deleted:  activeOutletIds.length,
    notFound: outletIds.length - activeOutletIds.length,
  })
}
