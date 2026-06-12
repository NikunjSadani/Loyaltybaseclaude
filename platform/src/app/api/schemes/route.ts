import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schemeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  schemeType: z.enum(['PURCHASE_INCENTIVE', 'VISIBILITY', 'GROWTH_INCENTIVE', 'REFERRAL', 'WELCOME_BONUS', 'MILESTONE', 'SLAB_BASED', 'TARGET_BASED']),
  rewardType: z.enum(['POINTS', 'CASHBACK', 'GIFT_CARD', 'PHYSICAL_GIFT', 'VOUCHER']),
  startDate: z.string().transform((s) => new Date(s)),
  endDate: z.string().transform((s) => new Date(s)),
  holdingPeriodDays: z.number().int().min(0).default(30),
  pointsPerRupee: z.number().optional(),
  fixedPoints: z.number().int().optional(),
  maxPointsPerCycle: z.number().int().optional(),
  budgetPaise: z.number().int().optional(),
  termsAndConditions: z.string().optional(),
  isStackable: z.boolean().default(false),
  priority: z.number().int().default(0),
  imageUrl: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  slabs: z
    .array(
      z.object({
        minValue: z.number(),
        maxValue: z.number().optional(),
        payoutValue: z.number(),
        isOverachievement: z.boolean().default(false),
      })
    )
    .optional(),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const clientId = getClientIdFromRequest(req)
    const sp = req.nextUrl.searchParams
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    // For non-admin users: return only schemes they are eligible for
    let where: any = { clientId, status: 'ACTIVE', deletedAt: null }

    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      const eligibilities = await prisma.schemeEligibility.findMany({
        where: { specificPartnerId: authUser.userId },
        select: { schemeId: true },
      })
      where.id = { in: eligibilities.map((e) => e.schemeId) }
    }

    const [schemes, total] = await Promise.all([
      prisma.scheme.findMany({
        where,
        include: {
          rules: { orderBy: { createdAt: 'asc' } },
          eligibility: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.scheme.count({ where }),
    ])

    return ok({ schemes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  } catch (e: any) {
    console.error('[schemes GET]', e)
    return err('Failed to fetch schemes', 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden - Admin only', 403)
    }

    const clientId = getClientIdFromRequest(req)
    const body = await req.json()
    const parsed = schemeSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { slabs: _slabs, ...schemeData } = parsed.data

    const scheme = await prisma.scheme.create({
      data: {
        ...schemeData,
        status: 'ACTIVE',
        createdByUserId: authUser.userId,
        clientId,
      },
    })

    return ok({ scheme }, 201)
  } catch (e: any) {
    console.error('[schemes POST]', e)
    return err('Failed to create scheme', 500)
  }
}
