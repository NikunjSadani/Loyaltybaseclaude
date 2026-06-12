/**
 * POST /api/kyc/[id]/approve
 *
 * Final Gifsy-Admin approval. Only valid when the submission is in
 * PENDING_GIFSY state (field approver SO/ASM/RSM has already acted).
 *
 * On success:
 *   - Submission → APPROVED
 *   - User account → ACTIVE
 *   - Partner wallet created (if not existing)
 *   - Audit log + status history recorded
 *   - KYC_APPROVED notification sent to partner
 */

import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { sendNotification } from '@/lib/notifications'
import { NotificationEvent } from '@/types'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden — Gifsy Admin only', 403)
    const clientId = getClientIdFromRequest(req)

    // DEMO_MODE bypass
    if (process.env.DEMO_MODE === 'true') {
      return ok({ message: 'KYC approved (demo mode)' })
    }

    const { id } = await params

    const submission = await prisma.kycSubmission.findFirst({
      where: { id, user: { clientId } },
      include: { user: true, partner: true },
    })
    if (!submission) return err('KYC submission not found', 404)
    if (submission.status === 'APPROVED') return err('Already approved')

    // Guard: field approver must have acted first
    if (submission.status !== 'PENDING_GIFSY') {
      return err(
        `Cannot approve — submission is in "${submission.status}". ` +
        `The field approver (SO / ASM / RSM) must act first via POST /api/kyc/${id}/first-approve.`,
        409,
      )
    }

    await prisma.$transaction(async (tx) => {
      // Transition to APPROVED
      await tx.kycSubmission.update({
        where: { id },
        data:  { status: 'APPROVED', approvedAt: new Date() },
      })

      // Status history
      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: id,
          fromStatus:      'PENDING_GIFSY' as any,
          toStatus:        'APPROVED'      as any,
          changedByUserId: authUser.userId,
          notes:           'Final approval by Gifsy Admin',
          metadata:        { stage: 'GIFSY' },
        },
      })

      // Activate the user's account
      await tx.user.update({
        where: { id: submission.userId },
        data:  { status: 'ACTIVE' },
      })

      // Create wallet if not already present
      if (submission.partnerId) {
        const existingWallet = await tx.wallet.findFirst({
          where: { partnerId: submission.partnerId },
        })
        if (!existingWallet) {
          await tx.wallet.create({ data: { partnerId: submission.partnerId } })
        }
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          action:     'APPROVE',
          entityType: 'KYC_SUBMISSION',
          entityId:   id,
          actorId:    authUser.userId,
          oldValues:  { status: 'PENDING_GIFSY' },
          newValues:  { status: 'APPROVED' },
          metadata:   { stage: 'GIFSY', submissionId: id, userId: submission.userId },
        },
      })
    })

    await sendNotification(submission.userId, NotificationEvent.KYC_APPROVED, {
      name: submission.user.name ?? submission.user.phone,
    }).catch((e) => console.error('[kyc/approve notification]', e))

    return ok({ message: 'KYC approved successfully' })
  } catch (e: any) {
    console.error('[kyc/[id]/approve]', e)
    return err('Failed to approve KYC submission', 500)
  }
}
