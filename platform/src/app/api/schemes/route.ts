import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schemeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  incentiveType: z.string().min(1),
  calculationMethod: z.enum(['FLAT', 'PERCENTAGE', 'SLAB', 'PER_UNIT', 'HYBRID']),
  startDate: z.string().transform((s) => new Date(s)),
  endDate: z.string().transform((s) => new Date(s)),
  holdingPeriodDays: z.number().int().min(0).default(0),
  targetValue: z.number().optional(),
  eligibility: z.record(z.string(), z.any()).optional(),
  rules: z.record(z.string(), z.any()).optional(),
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

    const sp = req.nextUrl.searchParams
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    // For non-admin users: return only schemes they are enrolled in
    let where: any = { status: 'ACTIVE', isDeleted: false }

    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      const enrollments = await prisma.schemeEligibility.findMany({
        where: { userId: authUser.userId, status: 'ACTIVE' },
        select: { schemeId: true },
      })
      where.id = { in: enrollments.map((e) => e.schemeId) }
    }

    const [schemes, total] = await Promise.all([
      prisma.scheme.findMany({
        where,
        include: {
          slabs: { orderBy: { minValue: 'asc' } },
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

    const body = await req.json()
    const parsed = schemeSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { slabs, ...schemeData } = parsed.data

    const scheme = await prisma.scheme.create({
      data: {
        ...schemeData,
        status: 'ACTIVE',
        isDeleted: false,
        createdById: authUser.userId,
        slabs: slabs
          ? {
              create: slabs,
            }
          : undefined,
      },
      include: { slabs: true },
    })

    return ok({ scheme }, 201)
  } catch (e: any) {
    console.error('[schemes POST]', e)
    return err('Failed to create scheme', 500)
  }
}
