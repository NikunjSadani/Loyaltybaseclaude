import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN' && authUser.role !== 'MIS_USER') {
      return err('Forbidden', 403)
    }

    const sp = req.nextUrl.searchParams
    const partnerClass = sp.get('class') ?? undefined
    const kycStatus = sp.get('kycStatus') ?? undefined
    const tier = sp.get('tier') ?? undefined
    const regionId = sp.get('regionId') ?? undefined
    const search = sp.get('search') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: any = { isActive: true }
    if (partnerClass) where.partnerClass = partnerClass.toUpperCase()
    if (kycStatus) where.kycStatus = kycStatus
    if (tier) where.tier = tier
    if (regionId) where.regionId = regionId
    if (search) {
      where.OR = [
        { firmName: { contains: search, mode: 'insensitive' } },
        { user: { mobile: { contains: search } } },
        { panNumber: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [partners, total] = await Promise.all([
      prisma.channelPartner.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, mobile: true, email: true, status: true } },
          wallet: { select: { earned: true, redeemed: true, locked: true } },
          outlets: { select: { id: true, name: true, city: true, status: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.channelPartner.count({ where }),
    ])

    return ok({ partners, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  } catch (e: any) {
    console.error('[admin/channel-partners GET]', e)
    return err('Failed to fetch channel partners', 500)
  }
}
