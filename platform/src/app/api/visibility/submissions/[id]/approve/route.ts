import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

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
    const clientId = getClientIdFromRequest(req)

    const { id } = await params

    const submission = await prisma.visibilitySubmission.findFirst({
      where: { id, partner: { user: { clientId } } },
    })
    if (!submission) return err('Submission not found', 404)
    if (submission.status === 'APPROVED') return err('Already approved')

    await prisma.$transaction(async (tx) => {
      const prevStatus = submission.status

      await tx.visibilitySubmission.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedByUserId: authUser.userId,
          reviewedAt: new Date(),
        },
      })

      await tx.visibilityApproval.create({
        data: {
          submissionId: id,
          reviewerUserId: authUser.userId,
          fromStatus: prevStatus,
          toStatus: 'APPROVED',
        },
      })

      await tx.auditLog.create({
        data: {
          action: 'APPROVE',
          entityType: 'VISIBILITY_SUBMISSION',
          entityId: id,
          actorId: authUser.userId,
        },
      })
    })

    return ok({ message: 'Submission approved successfully' })
  } catch (e: any) {
    console.error('[visibility/submissions/[id]/approve]', e)
    return err('Failed to approve submission', 500)
  }
}
