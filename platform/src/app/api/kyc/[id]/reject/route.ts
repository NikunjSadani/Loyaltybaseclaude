/**
 * POST /api/kyc/[id]/reject
 *
 * Allowed callers:
 *   - GIFSY_ADMIN          — can reject at any stage (final authority)
 *   - SALES_SO             — can reject when status is PENDING_SO_APPROVAL
 *   - SALES_ASM            — can reject when status is PENDING_ASM_APPROVAL
 *   - SALES_STATE_HEAD     — can reject when status is PENDING_RSM_APPROVAL
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { sendNotification } from '@/lib/notifications'
import { NotificationEvent } from '@/types'
import { canFirstApprove } from '@/lib/kyc-approval'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  reason:         z.string().min(1, 'Reason is required'),
  requiredAction: z.string().optional(),
  status:         z.enum(['REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED'])
                   .default('REJECTED'),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    // DEMO_MODE bypass
    if (process.env.DEMO_MODE === 'true') {
      return ok({ message: 'KYC rejected (demo mode)' })
    }

    const { id } = await params
    const body   = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)
    const { reason, requiredAction, status } = parsed.data

    const submission = await prisma.kycSubmission.findFirst({
      where: { id, user: { clientId } },
      include: { user: true },
    })
    if (!submission)                    return err('KYC submission not found', 404)
    if (submission.status === 'REJECTED') return err('Already rejected')

    // ── Permission check ──────────────────────────────────────────────────────
    // Gifsy admin can reject at any stage.
    // Field approvers can only reject when the submission is currently awaiting them.
    const isGifsyAdmin    = authUser.role === 'GIFSY_ADMIN'
    const isFieldApprover = canFirstApprove(authUser.role, submission.status)

    if (!isGifsyAdmin && !isFieldApprover) {
      return err(
        `Your role (${authUser.role}) cannot reject a submission in status "${submission.status}"`,
        403,
      )
    }

    // ── Determine the stage label for audit history ───────────────────────────
    const stage = isGifsyAdmin ? 'GIFSY' : 'FIRST_APPROVER'

    await prisma.$transaction(async (tx) => {
      await tx.kycSubmission.update({
        where: { id },
        data:  { status: status as any, rejectionReason: reason },
      })

      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: id,
          fromStatus:      submission.status as any,
          toStatus:        status as any,
          changedByUserId: authUser.userId,
          notes:           reason,
          metadata:        { stage, requiredAction, approverRole: authUser.role },
        },
      })

      await tx.auditLog.create({
        data: {
          action:     'REJECT' as const,
          entityType: 'KYC_SUBMISSION',
          entityId:   id,
          actorId:    authUser.userId,
          oldValues:  { status: submission.status },
          newValues:  { status },
          metadata:   { stage, reason, requiredAction },
        },
      })
    })

    await sendNotification(submission.userId, NotificationEvent.KYC_REJECTED, {
      reason,
      requiredAction: requiredAction ?? '',
    }).catch((e) => console.error('[kyc/reject notification]', e))

    return ok({
      message: status === 'REJECTED'
        ? 'KYC rejected successfully'
        : 'Re-upload requested successfully',
    })
  } catch (e: any) {
    console.error('[kyc/[id]/reject]', e)
    return err('Failed to reject KYC submission', 500)
  }
}
