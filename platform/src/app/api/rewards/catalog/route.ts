import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    const sp = req.nextUrl.searchParams
    const category = sp.get('category') ?? undefined
    const minPoints = sp.get('minPoints') ? parseInt(sp.get('minPoints')!, 10) : undefined
    const maxPoints = sp.get('maxPoints') ? parseInt(sp.get('maxPoints')!, 10) : undefined
    const inStock = sp.get('inStock')
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: any = {
      status: 'ACTIVE',
      deletedAt: null,
      clientId,
    }
    if (minPoints !== undefined || maxPoints !== undefined) {
      where.pointsCost = {}
      if (minPoints !== undefined) where.pointsCost.gte = minPoints
      if (maxPoints !== undefined) where.pointsCost.lte = maxPoints
    }

    // Get user's wallet balance to filter eligible items
    const partner = await prisma.channelPartner.findFirst({ where: { userId: authUser.userId, user: { clientId } } })
    const wallet = partner ? await prisma.wallet.findFirst({ where: { partnerId: partner.id } }) : null
    const userBalance = wallet ? wallet.redeemablePoints : 0

    const [items, total] = await Promise.all([
      prisma.rewardCatalog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { pointsCost: 'asc' },
      }),
      prisma.rewardCatalog.count({ where }),
    ])

    const enriched = items.map((item) => ({
      ...item,
      isAffordable: userBalance >= item.pointsCost,
    }))

    return ok({
      items: enriched,
      userBalance,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[rewards/catalog]', e)
    return err('Failed to fetch reward catalog', 500)
  }
}
