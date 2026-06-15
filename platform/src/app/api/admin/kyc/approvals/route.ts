/**
 * GET /api/admin/kyc/approvals
 *
 * Returns the list of KYC submissions pending Gifsy approval, with full
 * field-level state for the approval page.
 *
 * Auth: Gifsy-operated — GIFSY_ADMIN only, requires kyc:gifsy_approve permission.
 *
 * TODO(P3): query real PENDING_GIFSY submissions from the database.
 *
 * Spec: docs/plans/KYC-APPROVAL-REVAMP.md § 3.4d
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser }               from '@/lib/auth'
import { requirePermission }         from '@/lib/rbac/require-permission'
import { demoKycApprovalEntries }    from '@/lib/kyc-review-dump'

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

  const clientId = (authUser as { clientId?: string }).clientId
  if (!clientId) {
    return NextResponse.json({ success: false, error: 'No tenant bound to the session.' }, { status: 400 })
  }

  // TODO(P3): query real PENDING_GIFSY submissions from prisma.kycSubmission.findMany(…)
  const entries = demoKycApprovalEntries()

  return NextResponse.json({
    success: true,
    data:    { entries },
  })
}
