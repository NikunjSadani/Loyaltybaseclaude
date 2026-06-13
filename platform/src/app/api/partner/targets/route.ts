import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data    }, { status })
const err = (msg: string,   status = 400) => NextResponse.json({ success: false, error: msg }, { status })

/**
 * GET /api/partner/targets
 *
 * Returns the logged-in partner user's active scheme targets for the current
 * client. Used by the Partner Targets page to replace mock achievement data
 * with real values (leaderboard pattern: mock shown first, API updates silently).
 *
 * Response shape:
 *   { targets: [{ id, schemeId, schemeName, period, targetValue, achievedValue, percentage, status }] }
 */
export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const clientId = getClientIdFromRequest(req)
    const sp       = req.nextUrl.searchParams
    const period   = sp.get('period') ?? null  // e.g. "2026-05"; null = all active

    // Build period date bounds once — used in both Prisma where and JS fallback
    let periodStart: Date | null = null
    let periodEnd:   Date | null = null
    if (period) {
      const [y, m] = period.split('-').map(Number)
      if (!isNaN(y) && !isNaN(m)) {
        periodStart = new Date(y, m - 1, 1)
        periodEnd   = new Date(y, m, 0)
      }
    }

    // Period filter pushed into Prisma where so take:20 applies after filtering
    const schemeWhere: Record<string, unknown> = { clientId }
    if (periodStart && periodEnd) {
      schemeWhere['AND'] = [
        { OR: [{ startDate: null }, { startDate: { lte: periodEnd } }] },
        { OR: [{ endDate:   null }, { endDate:   { gte: periodStart } }] },
      ]
    }

    const schemeTargets = await prisma.schemeTarget.findMany({
      where: {
        userId:  authUser.userId,
        status:  'ACTIVE',
        scheme:  schemeWhere,
      },
      include: {
        scheme: {
          select: {
            id:        true,
            name:      true,
            endDate:   true,
            startDate: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    const targets = schemeTargets
      .map((t) => ({
        id:              t.id,
        schemeId:        t.schemeId,
        schemeName:      t.scheme?.name ?? '',
        period:          period ?? '',
        targetValue:     t.targetValue,
        achievedValue:   t.achievedValue,
        percentage:      t.targetValue > 0
                           ? Math.min(100, Math.round((t.achievedValue / t.targetValue) * 100))
                           : 0,
        status:          t.status,
        incentiveEarnable: t.projectedIncentive ?? 0,
      }))

    return ok({ targets })
  } catch (e: unknown) {
    console.error('[partner/targets]', e)
    return err('Failed to fetch partner targets', 500)
  }
}
