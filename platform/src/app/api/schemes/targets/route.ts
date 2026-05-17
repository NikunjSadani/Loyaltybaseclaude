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

    const targetUserId = sp.get('userId') && authUser.role === 'GIFSY_ADMIN'
      ? sp.get('userId')!
      : authUser.userId

    const [targets, total] = await Promise.all([
      prisma.schemeTarget.findMany({
        where: { userId: targetUserId },
        include: {
          scheme: {
            select: { id: true, name: true, endDate: true },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.schemeTarget.count({ where: { userId: targetUserId } }),
    ])

    const enriched = targets.map((t) => ({
      ...t,
      schemeName: t.scheme?.name,
      deadline: t.scheme?.endDate,
      percentage: t.targetValue > 0
        ? Math.min(100, Math.round((t.achievedValue / t.targetValue) * 100))
        : 0,
      incentiveEarnable: t.projectedIncentive ?? 0,
    }))

    return ok({
      targets: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[schemes/targets]', e)
    return err('Failed to fetch targets', 500)
  }
}
