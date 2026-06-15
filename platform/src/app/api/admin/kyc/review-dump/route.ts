/**
 * GET /api/admin/kyc/review-dump
 *
 * Exports the PENDING_GIFSY KYC submission queue as a review dump:
 *   xlsx → Excel with context cols pre-filled + blank verification cols for Gifsy
 *   json → { success:true, data:{ rows } } (for the pending-queue UI table)
 *
 * Auth: Gifsy-operated — GIFSY_ADMIN only, requires kyc:gifsy_approve permission.
 *
 * TODO(P3): query real PENDING_GIFSY submissions from the database.
 *
 * Spec: docs/plans/KYC-APPROVAL-REVAMP.md § 3.4b
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser }               from '@/lib/auth'
import { requirePermission }         from '@/lib/rbac/require-permission'
import {
  demoKycReviewRows,
  generateKycReviewDumpExcel,
}                                    from '@/lib/kyc-review-dump'

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const authUser = await getAuthUser(req)
  if (!authUser) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (authUser.role !== 'GIFSY_ADMIN') {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const denied = await requirePermission(
    authUser as { role: string; clientId: string },
    'kyc:gifsy_approve',
  )
  if (denied) return denied

  // ── Parse params ───────────────────────────────────────────────────────────
  const format = req.nextUrl.searchParams.get('format') ?? 'json'

  // ── Data: always demo for now ──────────────────────────────────────────────
  // TODO(P3): query real PENDING_GIFSY submissions from prisma.kycSubmission.findMany(…)
  const rows = demoKycReviewRows()

  // ── Response ───────────────────────────────────────────────────────────────
  if (format === 'xlsx') {
    const bytes  = generateKycReviewDumpExcel(rows)
    const buf    = Buffer.from(bytes)
    const today  = new Date().toISOString().split('T')[0]
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="kyc-review-dump-${today}.xlsx"`,
        'Cache-Control':       'no-store',
      },
    })
  }

  // Default: JSON (pending-queue table in the UI)
  return NextResponse.json({
    success: true,
    data:    { rows },
  })
}
