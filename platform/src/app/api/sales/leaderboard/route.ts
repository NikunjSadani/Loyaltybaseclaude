import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

type ScopeFilter = 'rm' | 'state' | 'national'

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const scope = (req.nextUrl.searchParams.get('scope') ?? 'rm') as ScopeFilter

    const me = await prisma.salesUser.findFirst({
      where:   { userId: authUser.userId, deletedAt: null },
      include: { hierarchyLevel: { select: { code: true, id: true } } },
    })
    if (!me) return ok({ entries: [] })

    /* ── Determine peer set ── */
    let peerWhere: any = { deletedAt: null, hierarchyLevelId: me.hierarchyLevelId }

    if (scope === 'rm') {
      if (me.reportingToId) {
        const siblings = await prisma.salesUser.findMany({
          where:  { reportingToId: me.reportingToId, deletedAt: null },
          select: { id: true },
        })
        peerWhere = { id: { in: siblings.map((s) => s.id) } }
      } else {
        peerWhere = { id: me.id }
      }
    } else if (scope === 'state') {
      peerWhere = { deletedAt: null, hierarchyLevelId: me.hierarchyLevelId, region: me.region }
    }
    // 'national' uses just hierarchyLevelId (already set above)

    const peers = await prisma.salesUser.findMany({
      where:   peerWhere,
      include: { user: { select: { name: true } } },
    })

    const peerIds = peers.map((p) => p.id)
    const peersById = Object.fromEntries(peers.map((p) => [p.id, p]))

    /* ── Current and last month date ranges ── */
    const now        = new Date()
    const curStart   = new Date(now.getFullYear(), now.getMonth(), 1)
    const curEnd     = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
    const lastStart  = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const lastEnd    = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

    /* ── Get all active outlet assignments for all peers ── */
    const assignments = await prisma.salesUserAssignment.findMany({
      where: {
        salesUserId:  { in: peerIds },
        outletId:     { not: null },
        unassignedAt: null,
      },
      select: {
        salesUserId: true,
        outlet:      { select: { partnerId: true } },
      },
    })

    /* salesUserId → unique partnerIds */
    const userPartners: Record<string, Set<string>> = {}
    for (const a of assignments) {
      if (!a.outlet?.partnerId) continue
      if (!userPartners[a.salesUserId]) userPartners[a.salesUserId] = new Set()
      userPartners[a.salesUserId].add(a.outlet.partnerId)
    }

    const allPartnerIds = [...new Set(assignments.map((a) => a.outlet?.partnerId).filter(Boolean) as string[])]

    /* ── Fetch targets + achievements for current and last month ── */
    const [curTargets, lastTargets] = allPartnerIds.length
      ? await Promise.all([
          prisma.target.findMany({
            where: {
              partnerId:       { in: allPartnerIds },
              period:          'MONTHLY',
              periodStartDate: { lte: curEnd },
              periodEndDate:   { gte: curStart },
            },
            include: { achievements: { orderBy: { calculatedAt: 'desc' }, take: 1 } },
          }),
          prisma.target.findMany({
            where: {
              partnerId:       { in: allPartnerIds },
              period:          'MONTHLY',
              periodStartDate: { lte: lastEnd },
              periodEndDate:   { gte: lastStart },
            },
            include: { achievements: { orderBy: { calculatedAt: 'desc' }, take: 1 } },
          }),
        ])
      : [[], []]

    /* partnerId → achievement % */
    const curAchMap: Record<string, number>  = {}
    for (const t of curTargets) {
      const pct = t.achievements[0]?.achievementPercent
      if (pct !== undefined) curAchMap[t.partnerId] = Number(pct)
    }
    const lastAchMap: Record<string, number> = {}
    for (const t of lastTargets) {
      const pct = t.achievements[0]?.achievementPercent
      if (pct !== undefined) lastAchMap[t.partnerId] = Number(pct)
    }

    /* ── Compute per-user stats ── */
    const rows = peerIds.map((uid) => {
      const peer      = peersById[uid]
      const partners  = [...(userPartners[uid] ?? [])]
      const curPcts   = partners.map((pid) => curAchMap[pid]).filter((v) => v !== undefined)
      const lastPcts  = partners.map((pid) => lastAchMap[pid]).filter((v) => v !== undefined)
      const curAch    = curPcts.length  ? Math.round(curPcts.reduce((a, b) => a + b, 0)  / curPcts.length)  : 0
      const lastAch   = lastPcts.length ? Math.round(lastPcts.reduce((a, b) => a + b, 0) / lastPcts.length) : 0
      return { uid, name: peer.user.name, territory: peer.region ?? peer.zone ?? '', curAch, lastAch, activeOutlets: partners.length }
    })

    /* ── Rank current month ── */
    rows.sort((a, b) => b.curAch - a.curAch)
    rows.forEach((r, i) => Object.assign(r, { curRank: i + 1 }))

    /* ── Rank last month, compute change ── */
    const lastRankMap: Record<string, number> = {}
    ;[...rows].sort((a, b) => b.lastAch - a.lastAch).forEach((r, i) => {
      lastRankMap[r.uid] = i + 1
    })

    const entries = rows.map((r: any) => ({
      name:           r.name,
      territory:      r.territory,
      achievementPct: r.curAch,
      activeOutlets:  r.activeOutlets,
      change:         (lastRankMap[r.uid] ?? r.curRank) - r.curRank,
      isMe:           r.uid === me.id,
    }))

    return ok({ entries, scope })
  } catch (e: any) {
    console.error('[sales/leaderboard GET]', e)
    return err('Failed to fetch leaderboard', 500)
  }
}
