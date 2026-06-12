/**
 * POST /api/admin/users/bulk-edit
 *
 * Performs batch mutations on sales users. Supported actions:
 *
 *   "resign"
 *     Mark the selected employees as resigned:
 *       • SalesUser.isActive = false, deletedAt = now
 *       • User.status = INACTIVE
 *       • Soft-unassign all active outlet assignments (SalesUserAssignment.unassignedAt = now)
 *
 *   "reassign_outlet"
 *     Move one or more outlets from their current XSR to a new XSR:
 *       Body: { action: "reassign_outlet", outletIds: string[], newXsrEmployeeCode: string }
 *       • Closes existing active SalesUserAssignment for each outlet
 *       • Creates a new SalesUserAssignment with the new XSR
 *
 * Body (resign):
 *   { action: "resign", employeeCodes: string[] }
 *
 * Body (reassign_outlet):
 *   { action: "reassign_outlet", outletIds: string[], newXsrEmployeeCode: string }
 *
 * Admin-only (GIFSY_ADMIN or CLIENT_ADMIN).
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

  const { action } = body

  // ── DEMO_MODE ─────────────────────────────────────────────────────────────
  if (process.env.DEMO_MODE === 'true') {
    if (action === 'resign') {
      return ok({ resigned: (body.employeeCodes ?? []).length, message: 'Resigned (demo mode)' })
    }
    if (action === 'reassign_outlet') {
      return ok({ reassigned: (body.outletIds ?? []).length, message: 'Reassigned (demo mode)' })
    }
    return err(`Unknown action: ${action}`)
  }

  // ── Resign ────────────────────────────────────────────────────────────────
  if (action === 'resign') {
    const { employeeCodes } = body
    if (!Array.isArray(employeeCodes) || employeeCodes.length === 0) {
      return err('employeeCodes must be a non-empty array')
    }
    if (employeeCodes.length > 200) {
      return err('Maximum 200 employees per bulk-resign request')
    }

    const salesUsers = await prisma.salesUser.findMany({
      where:  { employeeCode: { in: employeeCodes }, deletedAt: null, user: { clientId } },
      select: { id: true, userId: true, employeeCode: true },
    })

    if (salesUsers.length === 0) {
      return err('No active employees found for the given codes')
    }

    const salesUserIds = salesUsers.map(s => s.id)
    const userIds      = salesUsers.map(s => s.userId)
    const now          = new Date()

    await prisma.$transaction(async (tx) => {
      // Deactivate SalesUser records
      await tx.salesUser.updateMany({
        where: { id: { in: salesUserIds } },
        data:  { isActive: false, deletedAt: now },
      })

      // Deactivate User accounts
      await tx.user.updateMany({
        where: { id: { in: userIds } },
        data:  { status: 'INACTIVE' },
      })

      // Soft-unassign all active outlet assignments
      await tx.salesUserAssignment.updateMany({
        where: { salesUserId: { in: salesUserIds }, unassignedAt: null },
        data:  { unassignedAt: now },
      })

      // Audit log
      await tx.auditLog.create({
        data: {
          action:     'UPDATE',
          entityType: 'SALES_USER',
          entityId:   'BULK',
          actorId:    authUser.userId,
          newValues:  { status: 'RESIGNED', employeeCodes },
          metadata:   { action: 'bulk_resign', count: salesUsers.length },
        },
      })
    })

    return ok({ resigned: salesUsers.length, notFound: employeeCodes.length - salesUsers.length })
  }

  // ── Reassign outlet XSR ───────────────────────────────────────────────────
  if (action === 'reassign_outlet') {
    const { outletIds, newXsrEmployeeCode } = body

    if (!Array.isArray(outletIds) || outletIds.length === 0) {
      return err('outletIds must be a non-empty array')
    }
    if (!newXsrEmployeeCode || typeof newXsrEmployeeCode !== 'string') {
      return err('newXsrEmployeeCode is required')
    }
    if (outletIds.length > 200) {
      return err('Maximum 200 outlets per reassignment request')
    }

    // Validate new XSR
    const newXsr = await prisma.salesUser.findFirst({
      where:  { employeeCode: newXsrEmployeeCode.trim(), deletedAt: null, isActive: true },
      select: { id: true },
    })
    if (!newXsr) {
      return err(`XSR with employee code ${newXsrEmployeeCode} not found or inactive`)
    }

    // Verify outlets exist (scoped to tenant)
    const outlets = await prisma.outlet.findMany({
      where:  { id: { in: outletIds }, deletedAt: null, partner: { user: { clientId } } },
      select: { id: true, partnerId: true },
    })
    if (outlets.length === 0) {
      return err('No active outlets found for the given IDs')
    }

    const now = new Date()

    await prisma.$transaction(async (tx) => {
      for (const outlet of outlets) {
        // Close existing active assignment(s) for this outlet
        await tx.salesUserAssignment.updateMany({
          where: { outletId: outlet.id, unassignedAt: null },
          data:  { unassignedAt: now },
        })

        // Create new assignment
        await tx.salesUserAssignment.create({
          data: {
            salesUserId: newXsr.id,
            outletId:    outlet.id,
            partnerId:   outlet.partnerId,
            assignedAt:  now,
          },
        })
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          action:     'UPDATE',
          entityType: 'OUTLET',
          entityId:   'BULK',
          actorId:    authUser.userId,
          newValues:  { newXsrEmployeeCode, outletIds },
          metadata:   { action: 'bulk_reassign_outlet', count: outlets.length },
        },
      })
    })

    return ok({
      reassigned: outlets.length,
      notFound:   outletIds.length - outlets.length,
    })
  }

  return err(`Unknown action: ${action}. Valid actions: resign, reassign_outlet`)
}
