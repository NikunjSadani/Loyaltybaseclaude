/**
 * POST /api/admin/outlets/reactivate
 *
 * Reactivates multiple previously-deactivated outlets by their outletCode.
 * Sets Outlet.isActive = true.
 *
 * Body: { outletCodes: string[] }
 *   outletCodes — the admin-defined outlet identifiers (e.g. "OUT-2026-001").
 *   Max 500 per request.
 *
 * Admin-only. (H2 fix — reactivation endpoint that accepts outletCode strings)
 */

import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN'])
const ok  = (data: unknown) => NextResponse.json({ success: true,  data  })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req)
  if (!authUser)                       return err('Unauthorized', 401)
  if (!ADMIN_ROLES.has(authUser.role)) return err('Forbidden', 403)
  const clientId = getClientIdFromRequest(req)

  let body: { outletCodes?: unknown }
  try {
    body = await req.json()
  } catch {
    return err('Invalid JSON body')
  }

  const { outletCodes } = body

  if (!Array.isArray(outletCodes) || outletCodes.length === 0) {
    return err('outletCodes must be a non-empty array')
  }
  if (outletCodes.length > 500) {
    return err('Maximum 500 outlets per reactivation request')
  }

  // ── DEMO_MODE ───────────────────────────────────────────────────────────────
  if (process.env.DEMO_MODE === 'true') {
    return ok({ reactivated: outletCodes.length, message: 'Reactivation complete (demo mode)' })
  }

  // Verify outlets exist and are currently inactive (not soft-deleted)
  // Scoped to tenant via partnerId → user.clientId
  const outlets = await prisma.outlet.findMany({
    where: {
      outletCode: { in: outletCodes as string[] },
      isActive:   false,
      deletedAt:  null,
      partner: { user: { clientId } },
    },
    select: { id: true, outletCode: true },
  })

  if (outlets.length === 0) {
    return err('No inactive outlets found for the given outlet codes')
  }

  const inactiveIds = outlets.map(o => o.id)

  // Mark outlets active again
  await prisma.outlet.updateMany({
    where: { id: { in: inactiveIds } },
    data:  { isActive: true, reactivatedAt: new Date() } as any,
  })

  const notFound = (outletCodes as string[]).filter(
    c => !outlets.some(o => o.outletCode === c)
  )

  return ok({
    reactivated: outlets.length,
    notFound,
    message: `${outlets.length} outlet(s) reactivated${notFound.length > 0 ? `. ${notFound.length} code(s) not found or already active.` : '.'}`,
  })
}
