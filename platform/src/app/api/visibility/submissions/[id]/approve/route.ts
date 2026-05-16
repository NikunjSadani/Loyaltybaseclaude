import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { sendNotification } from '@/lib/notifications'
import { NotificationEvent } from '@/types'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const { id } = await params

    const submission = await prisma.visibilitySubmission.findUnique({
      where: { id },
    })
    if (!submission) return err('Submission not found', 404)
    if (submission.status === 'APPROVED') return err('Already approved')

    await prisma.$transaction(async (tx) => {
      await tx.visibilitySubmission.update({
        where: { id },
        data: { status: 'APPROVED', approvedAt: new Date(), approvedById: authUser.userId },
      })

      // Generate visibility payout eligibility
      await tx.visibilityPayout.create({
        data: {
          submissionId: id,
          userId: submission.submittedById,
          status: 'ELIGIBLE',
          programId: submission.programId,
        },
      })

      await tx.auditLog.create({
        data: {
          action: 'VISIBILITY_APPROVED',
          entityType: 'VISIBILITY_SUBMISSION',
          entityId: id,
          performedById: authUser.userId,
        },
      })
    })

    await sendNotification(submission.submittedById, NotificationEvent.REDEMPTION_CONFIRMED, {
      type: 'visibility_approved',
      submissionId: id,
    }).catch((e) => console.error('[visibility/approve notification]', e))

    return ok({ message: 'Submission approved successfully' })
  } catch (e: any) {
    console.error('[visibility/submissions/[id]/approve]', e)
    return err('Failed to approve submission', 500)
  }
}
