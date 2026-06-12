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
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'MIS_USER') {
      return err('Forbidden', 403)
    }
    const clientId = getClientIdFromRequest(req)

    const sp = req.nextUrl.searchParams
    const status = sp.get('status') ?? undefined
    const payoutMode = sp.get('mode') ?? undefined
    const partnerId = sp.get('partnerId') ?? undefined
    const dateFrom = sp.get('dateFrom') ? new Date(sp.get('dateFrom')!) : undefined
    const dateTo = sp.get('dateTo') ? new Date(sp.get('dateTo')!) : undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: any = { batch: { clientId } }
    if (status) where.status = status
    if (payoutMode) where.payoutMode = payoutMode
    if (partnerId) where.partnerId = partnerId
    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = dateFrom
      if (dateTo) where.createdAt.lte = dateTo
    }

    const [transactions, total] = await Promise.all([
      prisma.payoutTransaction.findMany({
        where,
        include: {
          partner: { select: { id: true, businessName: true } },
          batch: { select: { id: true, batchCode: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payoutTransaction.count({ where }),
    ])

    return ok({
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[payouts/transactions]', e)
    return err('Failed to fetch payout transactions', 500)
  }
}
