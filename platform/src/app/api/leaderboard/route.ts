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
    const partnerClass = sp.get('class') ?? undefined // retailer/wholesaler/sub_stockist
    const scope = sp.get('scope') ?? 'national' // national/state/territory
    const period = sp.get('period') ?? undefined // YYYY-MM
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '50', 10)
    const skip = (page - 1) * limit

    // Determine the period
    const now = new Date()
    const currentPeriod = period ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const [year, month] = currentPeriod.split('-').map(Number)
    const periodStart = new Date(year, month - 1, 1)
    const periodEnd = new Date(year, month, 0, 23, 59, 59)

    // Aggregate wallet earnings per user in the period
    const where: any = {
      type: 'CREDIT',
      createdAt: { gte: periodStart, lte: periodEnd },
    }

    const earnings = await prisma.walletTransaction.groupBy({
      by: ['userId'],
      where,
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      skip,
      take: limit,
    })

    // Fetch user & partner details
    const userIds = earnings.map((e) => e.userId)
    const users = await prisma.user.findMany({
      where: {
        id: { in: userIds },
        ...(partnerClass ? { partner: { partnerClass: partnerClass.toUpperCase() } } : {}),
      },
      include: {
        partner: { select: { id: true, firmName: true, partnerClass: true, regionId: true } },
      },
    })

    const userMap = new Map<string, typeof users[0]>(users.map((u) => [u.id, u]))

    // Get previous period scores for movement calculation
    const prevMonth = month === 1 ? 12 : month - 1
    const prevYear = month === 1 ? year - 1 : year
    const prevStart = new Date(prevYear, prevMonth - 1, 1)
    const prevEnd = new Date(prevYear, prevMonth, 0, 23, 59, 59)

    const prevEarnings = await prisma.walletTransaction.groupBy({
      by: ['userId'],
      where: { type: 'CREDIT', createdAt: { gte: prevStart, lte: prevEnd }, userId: { in: userIds } },
      _sum: { amount: true },
    })
    const prevRankMap = new Map(
      prevEarnings
        .sort((a, b) => (b._sum.amount ?? 0) - (a._sum.amount ?? 0))
        .map((e, i) => [e.userId, i + 1])
    )

    const ranked = earnings
      .map((e, i) => {
        const user = userMap.get(e.userId)
        const currentRank = skip + i + 1
        const prevRank = prevRankMap.get(e.userId)
        const movement = prevRank == null ? 'new' : prevRank > currentRank ? 'up' : prevRank < currentRank ? 'down' : 'same'

        return {
          rank: currentRank,
          userId: e.userId,
          partnerName: user?.partner?.firmName ?? user?.name ?? 'Unknown',
          partnerClass: user?.partner?.partnerClass ?? null,
          score: e._sum.amount ?? 0,
          movement,
          isCurrentUser: e.userId === authUser.userId,
        }
      })
      .filter((r) => userMap.has(r.userId)) // Filter out if class mismatch

    const total = await prisma.walletTransaction.groupBy({
      by: ['userId'],
      where,
      _count: true,
    })

    return ok({
      leaderboard: ranked,
      period: currentPeriod,
      scope,
      pagination: { page, limit, total: total.length, pages: Math.ceil(total.length / limit) },
    })
  } catch (e: any) {
    console.error('[leaderboard]', e)
    return err('Failed to fetch leaderboard', 500)
  }
}
