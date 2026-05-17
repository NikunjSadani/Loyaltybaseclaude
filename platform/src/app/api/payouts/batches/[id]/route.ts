import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'MIS_USER') {
      return err('Forbidden', 403)
    }

    const { id } = await params

    const sp = req.nextUrl.searchParams
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '50', 10)
    const skip = (page - 1) * limit

    const batch = await prisma.payoutBatch.findUnique({
      where: { id },
      include: {
        _count: { select: { transactions: true } },
      },
    })

    if (!batch) return err('Payout batch not found', 404)

    const [transactions, total] = await Promise.all([
      prisma.payoutTransaction.findMany({
        where: { batchId: id },
        include: {
          partner: { select: { id: true, businessName: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
      }),
      prisma.payoutTransaction.count({ where: { batchId: id } }),
    ])

    return ok({
      batch,
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[payouts/batches/[id]]', e)
    return err('Failed to fetch payout batch', 500)
  }
}
