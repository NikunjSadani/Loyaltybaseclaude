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
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '50', 10)
    const skip = (page - 1) * limit

    // Get the latest published snapshot
    const snapshot = await prisma.leaderboardSnapshot.findFirst({
      where: { isPublished: true, config: { clientId } },
      orderBy: { snapshotDate: 'desc' },
    })

    if (!snapshot) {
      return ok({ leaderboard: [], pagination: { page, limit, total: 0, pages: 0 } })
    }

    const [entries, total, currentPartner] = await Promise.all([
      prisma.leaderboardEntry.findMany({
        where: { snapshotId: snapshot.id },
        include: {
          partner: { select: { id: true, businessName: true, partnerClassId: true } },
        },
        orderBy: { rank: 'asc' },
        skip,
        take: limit,
      }),
      prisma.leaderboardEntry.count({ where: { snapshotId: snapshot.id } }),
      prisma.channelPartner.findUnique({ where: { userId: authUser.userId }, select: { id: true } }),
    ])

    const currentPartnerId = currentPartner?.id ?? null

    const ranked = entries.map((e) => ({
      rank: e.rank,
      partnerId: e.partnerId,
      partnerName: e.partner?.businessName ?? 'Unknown',
      score: e.score,
      rankChange: e.rankChange,
    }))

    return ok({
      leaderboard: ranked,
      currentPartnerId,
      snapshotDate: snapshot.snapshotDate,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[leaderboard]', e)
    return err('Failed to fetch leaderboard', 500)
  }
}
