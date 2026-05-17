import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  reason: z.string().min(1, 'Reason is required'),
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

    const { reason } = parsed.data

    const submission = await prisma.visibilitySubmission.findUnique({ where: { id } })
    if (!submission) return err('Submission not found', 404)
    if (submission.status === 'REJECTED') return err('Already rejected')

    await prisma.$transaction(async (tx) => {
      const prevStatus = submission.status

      await tx.visibilitySubmission.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          reviewedByUserId: authUser.userId,
          reviewedAt: new Date(),
        },
      })

      await tx.visibilityApproval.create({
        data: {
          submissionId: id,
          reviewerUserId: authUser.userId,
          fromStatus: prevStatus,
          toStatus: 'REJECTED',
          notes: reason,
        },
      })

      await tx.auditLog.create({
        data: {
          action: 'REJECT',
          entityType: 'VISIBILITY_SUBMISSION',
          entityId: id,
          actorId: authUser.userId,
          metadata: { reason },
        },
      })
    })

    return ok({ message: 'Submission rejected successfully' })
  } catch (e: any) {
    console.error('[visibility/submissions/[id]/reject]', e)
    return err('Failed to reject submission', 500)
  }
}
