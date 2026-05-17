import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const createSchema = z.object({
  payoutMode: z.enum(['UPI', 'BANK_TRANSFER', 'GIFT_CARD', 'PHYSICAL_GIFT']),
  notes: z.string().optional(),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'MIS_USER') {
      return err('Forbidden', 403)
    }

    const sp = req.nextUrl.searchParams
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const [batches, total] = await Promise.all([
      prisma.payoutBatch.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { transactions: true } },
        },
      }),
      prisma.payoutBatch.count(),
    ])

    return ok({ batches, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  } catch (e: any) {
    console.error('[payouts/batches GET]', e)
    return err('Failed to fetch payout batches', 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const body = await req.json()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { payoutMode, notes } = parsed.data

    const batchCode = `PB-${Date.now()}`
    const batch = await prisma.payoutBatch.create({
      data: {
        batchCode,
        payoutMode,
        status: 'DRAFT',
        notes: notes ?? null,
        createdByUserId: authUser.userId,
      },
    })

    return ok({ batch }, 201)
  } catch (e: any) {
    console.error('[payouts/batches POST]', e)
    return err('Failed to create payout batch', 500)
  }
}
