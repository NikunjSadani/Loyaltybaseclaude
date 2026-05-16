import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const patchSchema = z.object({
  status: z.enum(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'RE_UPLOAD_REQUIRED']).optional(),
  reason: z.string().optional(),
  assignedToId: z.string().optional(),
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const { id } = await params

    const submission = await prisma.kycSubmission.findUnique({
      where: { id },
      include: {
        outlet: true,
        documents: true,
        statusHistory: {
          orderBy: { createdAt: 'desc' },
        },
        assignedTo: { select: { id: true, name: true, mobile: true } },
        user: { select: { id: true, name: true, mobile: true, role: true } },
      },
    })

    if (!submission) return err('KYC submission not found', 404)

    // Sales users can only view their assigned submissions
    if (authUser.role !== 'GIFSY_ADMIN' && submission.userId !== authUser.userId && submission.assignedToId !== authUser.userId) {
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

    const { id } = await params
    const body = await req.json()
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.errors[0].message)

    const { status, reason, assignedToId } = parsed.data

    // Reason is mandatory for REJECTED and RE_UPLOAD_REQUIRED
    if ((status === 'REJECTED' || status === 'RE_UPLOAD_REQUIRED') && !reason) {
      return err('Reason is mandatory for REJECTED or RE_UPLOAD_REQUIRED status')
    }

    const submission = await prisma.kycSubmission.findUnique({ where: { id } })
    if (!submission) return err('KYC submission not found', 404)

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.kycSubmission.update({
        where: { id },
        data: {
          ...(status && { status }),
          ...(assignedToId && { assignedToId }),
          updatedAt: new Date(),
        },
      })

      if (status) {
        await tx.kycStatusHistory.create({
          data: {
            submissionId: id,
            status,
            reason: reason ?? null,
            changedById: authUser.userId,
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
