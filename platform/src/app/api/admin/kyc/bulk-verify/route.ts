/**
 * POST /api/admin/kyc/bulk-verify
 *
 * Parses a Gifsy-filled KYC approval sheet and returns a preview of
 * what will change.  (No commit mode needed for this DEMO milestone.)
 *
 * Body: multipart/form-data with a 'file' field (the .xlsx sheet).
 *
 * Auth: Gifsy-operated — GIFSY_ADMIN only, requires kyc:gifsy_approve permission.
 *
 * Spec: docs/plans/KYC-APPROVAL-REVAMP.md § 3.4c
 */

import { NextRequest, NextResponse } from 'next/server'
import * as XLSX                     from 'xlsx'
import { getAuthUser }               from '@/lib/auth'
import { requirePermission }         from '@/lib/rbac/require-permission'
import { demoKycApprovalEntries }    from '@/lib/kyc-review-dump'
import { parseKycApprovalSheet }     from '@/lib/kyc-bulk-verify'

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

  const clientId = (authUser as { clientId?: string }).clientId
  if (!clientId) {
    return NextResponse.json({ success: false, error: 'No tenant bound to the session.' }, { status: 400 })
  }

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
  const validIds = new Set(demoKycApprovalEntries().map(e => e.submissionId))
  const result   = parseKycApprovalSheet(rawRows, validIds)

  return NextResponse.json({ success: true, data: result })
}
