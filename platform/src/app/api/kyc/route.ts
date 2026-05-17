import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const kycSchema = z.object({
  // Outlet details
  outletName: z.string().min(1),
  outletAddress: z.string().min(1),
  outletCity: z.string().min(1),
  outletState: z.string().min(1),
  outletPincode: z.string().length(6),
  outletType: z.string().min(1),
  // Partner details
  ownerName: z.string().min(1),
  ownerMobile: z.string().regex(/^\d{10}$/),
  ownerEmail: z.string().email().optional(),
  panNumber: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).optional(),
  gstNumber: z.string().optional(),
  // Bank details
  bankAccountNumber: z.string().min(8),
  bankIfscCode: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  bankAccountHolderName: z.string().min(1),
  bankName: z.string().min(1),
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

    // Create outlet record and KYC submission in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const outlet = await tx.outlet.create({
        data: {
          name: data.outletName,
          address: data.outletAddress,
          city: data.outletCity,
          state: data.outletState,
          pincode: data.outletPincode,
          type: data.outletType,
          status: 'PENDING',
        },
      })

      const submission = await tx.kycSubmission.create({
        data: {
          userId: authUser.userId,
          outletId: outlet.id,
          status: 'DRAFT',
          ownerName: data.ownerName,
          ownerMobile: data.ownerMobile,
          ownerEmail: data.ownerEmail ?? null,
          panNumber: data.panNumber ?? null,
          gstNumber: data.gstNumber ?? null,
          bankAccountNumber: data.bankAccountNumber,
          bankIfscCode: data.bankIfscCode,
          bankAccountHolderName: data.bankAccountHolderName,
          bankName: data.bankName,
        },
      })

      return { submission, outlet }
    })

    return ok({ submissionId: result.submission.id, outletId: result.outlet.id }, 201)
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
    const state = sp.get('state') ?? undefined
    const assignedTo = sp.get('assigned_to') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    // Build where clause based on role
    const where: any = {}
    if (authUser.role !== 'GIFSY_ADMIN') {
      // Sales users see only their assigned submissions
      where.assignedToId = authUser.userId
    }
    if (status) where.status = status
    if (assignedTo) where.assignedToId = assignedTo
    if (state) {
      where.outlet = { state }
    }

    const [submissions, total] = await Promise.all([
      prisma.kycSubmission.findMany({
        where,
        include: {
          outlet: { select: { name: true, city: true, state: true } },
          assignedTo: { select: { id: true, name: true } },
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
      where: authUser.role !== 'GIFSY_ADMIN' ? { assignedToId: authUser.userId } : {},
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
