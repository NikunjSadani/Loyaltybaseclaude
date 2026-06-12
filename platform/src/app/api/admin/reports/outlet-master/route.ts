/**
 * GET /api/admin/reports/outlet-master
 *
 * Downloads the full Outlet Master as an Excel (.xlsx) file.
 *
 * In DEMO_MODE: returns demo data (10 rows, all sections populated).
 * In production: queries Outlet → ChannelPartner → KycSubmission →
 *   KycDocument → SalesUserAssignment chain and maps to OutletMasterRow.
 *
 * Admin-only (GIFSY_ADMIN | CLIENT_ADMIN).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/auth'
import {
  generateOutletMasterExcel,
  DEMO_OUTLET_MASTER_ROWS,
} from '@/lib/outlet-master-export'

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN'])

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req)
  if (!authUser)                       return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.has(authUser.role)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // ── DEMO_MODE ──────────────────────────────────────────────────────────────
  if (process.env.DEMO_MODE === 'true') {
    const bytes = Buffer.from(generateOutletMasterExcel(DEMO_OUTLET_MASTER_ROWS))
    const today = new Date().toISOString().split('T')[0]
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="outlet-master-${today}.xlsx"`,
        'Cache-Control':       'no-store',
      },
    })
  }

  // ── Production ─────────────────────────────────────────────────────────────
  // TODO: Query the DB and map to OutletMasterRow[]
  // 1. prisma.outlet.findMany({ include: { partner: { include: { kycSubmissions: { include: { documents: true } } } }, salesAssignments: true, outletType: true } })
  // 2. Map each outlet to OutletMasterRow (derive hierarchy from salesAssignments)
  // 3. Call generateOutletMasterExcel(rows)
  // Until then, return the demo data:
  const bytes = Buffer.from(generateOutletMasterExcel(DEMO_OUTLET_MASTER_ROWS))
  const today = new Date().toISOString().split('T')[0]
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="outlet-master-${today}.xlsx"`,
      'Cache-Control':       'no-store',
    },
  })
}
