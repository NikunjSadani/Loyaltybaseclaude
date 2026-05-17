import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { sendNotification } from '@/lib/notifications'
import { NotificationEvent } from '@/types'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  reason: z.string().min(1, 'Reason is required'),
  requiredAction: z.string().optional(),
  status: z.enum(['REJECTED', 'RE_UPLOAD_REQUIRED']).default('REJECTED'),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const { id } = await params
    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { reason, requiredAction, status } = parsed.data

    const submission = await prisma.kycSubmission.findUnique({
      where: { id },
      include: { user: true },
    })

    if (!submission) return err('KYC submission not found', 404)
    if (submission.status === 'REJECTED') return err('Already rejected')

    await prisma.$transaction(async (tx) => {
      await tx.kycSubmission.update({
        where: { id },
        data: { status, updatedAt: new Date() },
      })

      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: id,
          toStatus: status,
          notes: reason,
          changedByUserId: authUser.userId,
        },
      })

      await tx.auditLog.create({
        data: {
          action: 'REJECT' as const,
          entityType: 'KYC_SUBMISSION',
          entityId: id,
          actorId: authUser.userId,
          metadata: { reason, requiredAction },
        },
      })
    })

    await sendNotification(submission.userId, NotificationEvent.KYC_REJECTED, {
      reason,
      requiredAction: requiredAction ?? '',
    }).catch((e) => console.error('[kyc/reject notification]', e))

    return ok({ message: `KYC ${status === 'REJECTED' ? 'rejected' : 're-upload requested'} successfully` })
  } catch (e: any) {
    console.error('[kyc/[id]/reject]', e)
    return err('Failed to reject KYC submission', 500)
  }
}
