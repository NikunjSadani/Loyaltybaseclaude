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

    const submission = await prisma.kycSubmission.findUnique({
      where: { id },
      include: { user: true, partner: true },
    })

    if (!submission) return err('KYC submission not found', 404)
    if (submission.status === 'APPROVED') return err('Already approved')

    await prisma.$transaction(async (tx) => {
      // Transition to APPROVED
      await tx.kycSubmission.update({
        where: { id },
        data: { status: 'APPROVED', approvedAt: new Date() },
      })

      // Log status history
      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: id,
          toStatus: 'APPROVED',
          changedByUserId: authUser.userId,
        },
      })

      // Activate user account
      await tx.user.update({
        where: { id: submission.userId },
        data: { status: 'ACTIVE' },
      })

      // Create wallet for channel partner if they don't have one
      if (submission.partnerId) {
        const existingWallet = await tx.wallet.findFirst({
          where: { partnerId: submission.partnerId },
        })
        if (!existingWallet) {
          await tx.wallet.create({
            data: {
              partnerId: submission.partnerId,
            },
          })
        }
      }

      // Log audit entry
      await tx.auditLog.create({
        data: {
          action: 'APPROVE',
          entityType: 'KYC_SUBMISSION',
          entityId: id,
          actorId: authUser.userId,
          metadata: { submissionId: id, userId: submission.userId },
        },
      })
    })

    // Send notification
    await sendNotification(submission.userId, NotificationEvent.KYC_APPROVED, {
      name: submission.user.name ?? submission.user.phone,
    }).catch((e) => console.error('[kyc/approve notification]', e))

    return ok({ message: 'KYC approved successfully' })
  } catch (e: any) {
    console.error('[kyc/[id]/approve]', e)
    return err('Failed to approve KYC submission', 500)
  }
}
