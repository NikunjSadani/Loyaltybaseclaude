/**
 * POST /api/kyc/[id]/first-approve
 *
 * Used by the field approver (SO, ASM, or RSM) to approve a KYC submission
 * at the first stage. After this, the submission moves to PENDING_GIFSY for
 * final Gifsy-Admin approval.
 *
 * Only the role that matches the current KYC status can act:
 *   SALES_SO         → PENDING_SO_APPROVAL
 *   SALES_ASM        → PENDING_ASM_APPROVAL
 *   SALES_STATE_HEAD → PENDING_RSM_APPROVAL
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { sendNotification } from '@/lib/notifications'
import { NotificationEvent } from '@/types'
import { canFirstApprove, nextStatusAfterFirstApprove } from '@/lib/kyc-approval'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  remarks: z.string().optional(),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    // DEMO_MODE: bypass DB — return a simulated success so the frontend can be
    // tested end-to-end before a real database is connected.
    if (process.env.DEMO_MODE === 'true') {
      return ok({
        message:    'KYC first-approved (demo mode)',
        nextStatus: 'PENDING_GIFSY',
      })
    }

    const { id } = await params

    const body   = await req.json().catch(() => ({}))
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)
    const { remarks } = parsed.data

    // ── Fetch submission ──────────────────────────────────────────────────────
    const submission = await prisma.kycSubmission.findFirst({
      where: { id, user: { clientId } },
      include: {
        user:    { select: { id: true, name: true, phone: true } },
        partner: { select: { id: true, businessName: true } },
      },
    })
    if (!submission) return err('KYC submission not found', 404)

    // ── Permission check ──────────────────────────────────────────────────────
    // canFirstApprove uses our pure logic: only the correct role for the current status
    if (!canFirstApprove(authUser.role, submission.status)) {
      return err(
        `Your role (${authUser.role}) cannot approve a submission in status "${submission.status}"`,
        403,
      )
    }

    // ── Status transition ─────────────────────────────────────────────────────
    const nextStatus = nextStatusAfterFirstApprove(submission.status)

    await prisma.$transaction(async (tx) => {
      // Update submission
      await tx.kycSubmission.update({
        where: { id },
        data:  { status: nextStatus as any, reviewedAt: new Date() },
      })

      // Log status history
      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: id,
          fromStatus:      submission.status as any,
          toStatus:        nextStatus as any,
          changedByUserId: authUser.userId,
          notes:           remarks ?? `Approved by ${authUser.role}`,
        },
      })

      // Audit log
      await tx.auditLog.create({
        data: {
          action:     'APPROVE',
          entityType: 'KYC_SUBMISSION',
          entityId:   id,
          actorId:    authUser.userId,
          oldValues:  { status: submission.status },
          newValues:  { status: nextStatus },
          metadata:   { stage: 'FIRST_APPROVER', approverRole: authUser.role, remarks },
        },
      })
    })

    // ── Notify partner ────────────────────────────────────────────────────────
    await sendNotification(
      submission.userId,
      NotificationEvent.KYC_UNDER_REVIEW,
      { name: submission.user.name ?? submission.user.phone },
    ).catch((e) => console.error('[kyc/first-approve notification]', e))

    return ok({
      message:    'KYC first-approval recorded successfully',
      nextStatus,
      submissionId: id,
    })
  } catch (e: any) {
    console.error('[kyc/[id]/first-approve]', e)
    return err('Failed to process first approval', 500)
  }
}
