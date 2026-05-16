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
    const type = sp.get('type') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    // Admins can view any user's wallet; partners see their own
    const targetUserId = sp.get('userId') && authUser.role === 'GIFSY_ADMIN'
      ? sp.get('userId')!
      : authUser.userId

    const where: any = { userId: targetUserId }
    if (type) where.type = type

    const [transactions, total] = await Promise.all([
      prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          invoice: { select: { invoiceNumber: true } },
        },
      }),
      prisma.walletTransaction.count({ where }),
    ])

    const passbook = transactions.map((t) => ({
      id: t.id,
      type: t.type,
      description: t.description ?? getDefaultDescription(t.type),
      points: t.amount,
      date: t.createdAt,
      status: 'COMPLETED',
      reference: t.invoice?.invoiceNumber ?? t.id,
      bucket: t.bucket,
      balanceAfter: t.balanceAfter,
    }))

    return ok({
      transactions: passbook,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[wallet/transactions]', e)
    return err('Failed to fetch wallet transactions', 500)
  }
}

function getDefaultDescription(type: string): string {
  const map: Record<string, string> = {
    CREDIT: 'Points credited',
    DEBIT: 'Points debited',
    LOCK: 'Points locked for redemption',
    UNLOCK: 'Points unlocked',
    EXPIRE: 'Points expired',
    REVERSE: 'Points reversed',
  }
  return map[type] ?? 'Wallet transaction'
}
