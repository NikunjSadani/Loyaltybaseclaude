/**
 * POST /api/admin/kyc/bulk-verify
 *
 * Parses a Gifsy-filled KYC verification sheet and either previews or commits
 * the bulk verification result.
 *
 * Query params:
 *   mode   preview (default) | commit
 *
 * Body: multipart/form-data with a 'file' field (the .xlsx sheet).
 *
 * Auth: Gifsy-operated — GIFSY_ADMIN only, requires kyc:gifsy_approve permission.
 *
 * Mode=preview  → parse + validate, return KycVerifyResult for UI dry-run display.
 * Mode=commit   → if no errors, return DEMO no-op summary.
 *                 TODO(P3): persist field-level verification + status transitions
 *                           + KycStatusHistory entries.
 *
 * Spec: docs/plans/KYC-APPROVAL-REVAMP.md § 3.4c
 */

import { NextRequest, NextResponse } from 'next/server'
import * as XLSX                     from 'xlsx'
import { getAuthUser }               from '@/lib/auth'
import { requirePermission }         from '@/lib/rbac/require-permission'
import { demoKycReviewRows }         from '@/lib/kyc-review-dump'
import { parseKycVerificationRows }  from '@/lib/kyc-bulk-verify'

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
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
  const mode = req.nextUrl.searchParams.get('mode') ?? 'preview'

  // ── Read uploaded file ─────────────────────────────────────────────────────
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid form data' }, { status: 400 })
  }

  const file = form.get('file')
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ success: false, error: 'No file uploaded' }, { status: 400 })
  }

  // Reject oversized uploads (demo cap; real per-request limits belong at the edge/proxy).
  if (typeof file.size === 'number' && file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ success: false, error: 'File too large (max 5 MB).' }, { status: 400 })
  }

  // ── Parse Excel ────────────────────────────────────────────────────────────
  let rawRows: Record<string, string>[]
  try {
    const buf   = Buffer.from(await file.arrayBuffer())
    const wb    = XLSX.read(buf, { type: 'buffer' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    rawRows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
      defval: '',
      raw:    false,
    })
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to parse Excel file — ensure it is a valid .xlsx' },
      { status: 400 },
    )
  }

  // ── Validate rows ──────────────────────────────────────────────────────────
  // TODO(P3): load real pending IDs from prisma.kycSubmission.findMany({ where: { status: 'PENDING_GIFSY' } })
  const validIds = new Set(demoKycReviewRows().map(r => r.submissionId))
  const result   = parseKycVerificationRows(rawRows, validIds)

  // ── Preview mode ───────────────────────────────────────────────────────────
  if (mode !== 'commit') {
    return NextResponse.json({ success: true, data: result })
  }

  // ── Commit mode ────────────────────────────────────────────────────────────
  if (result.errors.length > 0) {
    return NextResponse.json(
      {
        success: false,
        error:   'Resolve all errors before committing.',
        data:    result,
      },
      { status: 400 },
    )
  }

  // DEMO no-op — no records persisted.
  // TODO(P3): persist field-level verification + status transitions + KycStatusHistory entries:
  //   For each previewRow with decision=APPROVE:
  //     - Write bankVerified, bankNameMatch, pennyDropRef, gstRegistrationType, gstLegalName,
  //       gstStatus, addressApproved, ownerApproved onto KycSubmission (or KycVerificationItem).
  //     - Advance KycSubmission.status → APPROVED.
  //     - Append immutable KycStatusHistory row: { status: 'APPROVED', changedById: authUser.userId, note: … }.
  //   For RE_UPLOAD: status → RE_UPLOAD_REQUIRED, history row.
  //   For REJECT: status → REJECTED, history row.
  return NextResponse.json({
    success: true,
    data: {
      committed: result.summary,
      message:   'Demo mode — no records persisted.',
    },
  })
}
