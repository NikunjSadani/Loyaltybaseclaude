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
    const transactionType = sp.get('type') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    // Resolve target partner ID
    const targetUserId = sp.get('userId') && authUser.role === 'GIFSY_ADMIN'
      ? sp.get('userId')!
      : authUser.userId

    const channelPartner = await prisma.channelPartner.findFirst({
      where: { userId: targetUserId, user: { clientId } },
    })

    if (!channelPartner) {
      return ok({ transactions: [], pagination: { page, limit, total: 0, pages: 0 } })
    }

    const wallet = await prisma.wallet.findFirst({
      where: { partnerId: channelPartner.id },
    })

    if (!wallet) {
      return ok({ transactions: [], pagination: { page, limit, total: 0, pages: 0 } })
    }

    const where: any = { walletId: wallet.id }
    if (transactionType) where.transactionType = transactionType

    const [transactions, total] = await Promise.all([
      prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.walletTransaction.count({ where }),
    ])

    const passbook = transactions.map((t) => ({
      id: t.id,
      transactionType: t.transactionType,
      description: t.description ?? getDefaultDescription(t.transactionType),
      points: t.points,
      date: t.createdAt,
      balanceType: t.balanceType,
      balanceAfter: t.balanceAfter,
      referenceType: t.referenceType,
      referenceId: t.referenceId,
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

function getDefaultDescription(transactionType: string): string {
  const map: Record<string, string> = {
    CREDIT_POINTS_EARNED: 'Points earned',
    CREDIT_BONUS: 'Bonus points credited',
    CREDIT_REVERSAL: 'Points reversed to wallet',
    CREDIT_ADJUSTMENT: 'Manual credit adjustment',
    DEBIT_REDEMPTION: 'Points redeemed',
    DEBIT_EXPIRY: 'Points expired',
    DEBIT_ADJUSTMENT: 'Manual debit adjustment',
    LOCK_HOLDING: 'Points locked',
    UNLOCK_HOLDING: 'Points unlocked',
  }
  return map[transactionType] ?? 'Wallet transaction'
}
