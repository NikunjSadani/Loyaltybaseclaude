import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const sp = req.nextUrl.searchParams
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit
    const status = sp.get('status') ?? undefined

    const where: any = {}
    if (authUser.role !== 'GIFSY_ADMIN') {
      // Find channel partner for this user
      const partner = await prisma.channelPartner.findFirst({ where: { userId: authUser.userId } })
      where.partnerId = partner?.id ?? 'none'
    }
    if (status) where.status = status

    const [orders, total] = await Promise.all([
      prisma.redemptionOrder.findMany({
        where,
        include: {
          reward: { select: { id: true, name: true, imageUrls: true } },
          partner: { select: { id: true, businessName: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.redemptionOrder.count({ where }),
    ])

    return ok({
      orders,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[rewards/orders]', e)
    return err('Failed to fetch orders', 500)
  }
}
