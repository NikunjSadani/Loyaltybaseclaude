import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const patchSchema = z.object({
  status: z.enum(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'RE_UPLOAD_REQUIRED', 'PENDING_PENNY_DROP', 'PENDING_AGREEMENT', 'SUSPENDED']).optional(),
  rejectionReason: z.string().optional(),
  reviewerNotes: z.string().optional(),
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    const { id } = await params

    const submission = await prisma.kycSubmission.findFirst({
      where: { id, user: { clientId } },
      include: {
        documents: true,
        statusHistory: {
          orderBy: { createdAt: 'desc' },
        },
        user: { select: { id: true, name: true, phone: true, role: true } },
        partner: true,
      },
    })

    if (!submission) return err('KYC submission not found', 404)

    // Non-admin users can only view their own submissions
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN' && submission.userId !== authUser.userId) {
      return err('Forbidden', 403)
    }

    return ok({ submission })
  } catch (e: any) {
    console.error('[kyc/[id] GET]', e)
    return err('Failed to fetch KYC submission', 500)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Admin only', 403)
    const clientId = getClientIdFromRequest(req)

    const { id } = await params
    const body = await req.json()
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { status, rejectionReason, reviewerNotes } = parsed.data

    // Reason is mandatory for REJECTED and RE_UPLOAD_REQUIRED
    if ((status === 'REJECTED' || status === 'RE_UPLOAD_REQUIRED') && !rejectionReason) {
      return err('Rejection reason is mandatory for REJECTED or RE_UPLOAD_REQUIRED status')
    }

    const submission = await prisma.kycSubmission.findFirst({ where: { id, user: { clientId } } })
    if (!submission) return err('KYC submission not found', 404)

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.kycSubmission.update({
        where: { id },
        data: {
          ...(status && { status }),
          ...(rejectionReason && { rejectionReason }),
          ...(reviewerNotes && { reviewerNotes }),
        },
      })

      if (status) {
        await tx.kycStatusHistory.create({
          data: {
            kycSubmissionId: id,
            fromStatus: submission.status,
            toStatus: status,
            notes: rejectionReason ?? null,
            changedByUserId: authUser.userId,
          },
        })
      }

      return result
    })

    return ok({ submission: updated })
  } catch (e: any) {
    console.error('[kyc/[id] PATCH]', e)
    return err('Failed to update KYC submission', 500)
  }
}
