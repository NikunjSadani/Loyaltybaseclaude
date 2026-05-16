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
      include: { user: true, outlet: true },
    })

    if (!submission) return err('KYC submission not found', 404)
    if (submission.status === 'APPROVED') return err('Already approved')

    await prisma.$transaction(async (tx) => {
      // Transition to APPROVED
      await tx.kycSubmission.update({
        where: { id },
        data: { status: 'APPROVED', updatedAt: new Date() },
      })

      // Log status history
      await tx.kycStatusHistory.create({
        data: {
          submissionId: id,
          status: 'APPROVED',
          changedById: authUser.userId,
        },
      })

      // Activate outlet
      await tx.outlet.update({
        where: { id: submission.outletId },
        data: { status: 'ACTIVE' },
      })

      // Activate user account
      await tx.user.update({
        where: { id: submission.userId },
        data: { status: 'ACTIVE' },
      })

      // Create or activate wallet for user
      const existingWallet = await tx.wallet.findFirst({
        where: { userId: submission.userId },
      })
      if (!existingWallet) {
        await tx.wallet.create({
          data: {
            userId: submission.userId,
            earned: 0,
            locked: 0,
            redeemed: 0,
            expired: 0,
            status: 'ACTIVE',
          },
        })
      } else {
        await tx.wallet.update({
          where: { id: existingWallet.id },
          data: { status: 'ACTIVE' },
        })
      }

      // Assign applicable schemes (find active schemes for the user's class)
      const activeSchemes = await tx.scheme.findMany({
        where: { status: 'ACTIVE', isDeleted: false },
      })

      for (const scheme of activeSchemes) {
        const existing = await tx.schemeEnrollment.findFirst({
          where: { userId: submission.userId, schemeId: scheme.id },
        })
        if (!existing) {
          await tx.schemeEnrollment.create({
            data: {
              userId: submission.userId,
              schemeId: scheme.id,
              enrolledAt: new Date(),
              status: 'ACTIVE',
            },
          })
        }
      }

      // Log audit entry
      await tx.auditLog.create({
        data: {
          action: 'KYC_APPROVED',
          entityType: 'KYC_SUBMISSION',
          entityId: id,
          performedById: authUser.userId,
          metadata: { submissionId: id, userId: submission.userId },
        },
      })
    })

    // Send notification
    await sendNotification(submission.userId, NotificationEvent.KYC_APPROVED, {
      name: submission.ownerName ?? submission.user.mobile,
    }).catch((e) => console.error('[kyc/approve notification]', e))

    return ok({ message: 'KYC approved successfully' })
  } catch (e: any) {
    console.error('[kyc/[id]/approve]', e)
    return err('Failed to approve KYC submission', 500)
  }
}
