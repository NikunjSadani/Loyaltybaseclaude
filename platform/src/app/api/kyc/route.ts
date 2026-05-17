import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const kycSchema = z.object({
  // Partner details (must already have channel partner record or partnerId)
  panNumber: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).optional(),
  gstNumber: z.string().optional(),
  reviewerNotes: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const body = await req.json()
    const parsed = kycSchema.safeParse(body)
    if (!parsed.success) {
      return err(parsed.error.issues[0].message)
    }
    const data = parsed.data

    // Find channel partner for this user
    const partner = await prisma.channelPartner.findFirst({
      where: { userId: authUser.userId },
    })

    // Check for existing pending submission
    const existing = await prisma.kycSubmission.findFirst({
      where: { userId: authUser.userId, status: { in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] } },
    })
    if (existing) return err('You already have a pending KYC submission')

    const submission = await prisma.kycSubmission.create({
      data: {
        userId: authUser.userId,
        partnerId: partner?.id ?? null,
        status: 'DRAFT',
        reviewerNotes: data.reviewerNotes ?? null,
      },
    })

    return ok({ submissionId: submission.id }, 201)
  } catch (e: any) {
    console.error('[kyc POST]', e)
    return err('Failed to create KYC submission', 500)
  }
}

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const sp = req.nextUrl.searchParams
    const status = sp.get('status') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    // Build where clause based on role
    const where: any = {}
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      // Non-admin users see only their own submissions
      where.userId = authUser.userId
    }
    if (status) where.status = status

    const [submissions, total] = await Promise.all([
      prisma.kycSubmission.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, phone: true } },
          partner: { select: { id: true, businessName: true } },
          documents: { select: { id: true, documentType: true, status: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.kycSubmission.count({ where }),
    ])

    // Count by status
    const statusCounts = await prisma.kycSubmission.groupBy({
      by: ['status'],
      where: authUser.role !== 'GIFSY_ADMIN' ? { userId: authUser.userId } : {},
      _count: { status: true },
    })

    return ok({
      submissions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      statusCounts: statusCounts.reduce((acc: any, s) => {
        acc[s.status] = s._count.status
        return acc
      }, {}),
    })
  } catch (e: any) {
    console.error('[kyc GET]', e)
    return err('Failed to fetch KYC submissions', 500)
  }
}
