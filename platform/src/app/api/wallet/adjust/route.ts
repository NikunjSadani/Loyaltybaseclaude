import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  partnerId: z.string().min(1),
  amount: z.number().int().positive(),
  type: z.enum(['CREDIT', 'DEBIT']),
  reason: z.string().min(1, 'Reason is required'),
  approvedBy: z.string().min(1, 'Approver is required'),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)
    const clientId = getClientIdFromRequest(req)

    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { partnerId, amount, type, reason, approvedBy } = parsed.data

    const wallet = await prisma.wallet.findFirst({ where: { partnerId, partner: { user: { clientId } } } })
    if (!wallet) return err('Wallet not found for this partner', 404)

    if (type === 'DEBIT' && wallet.redeemablePoints < amount) {
      return err('Insufficient wallet balance for debit')
    }

    const transactionType = type === 'CREDIT' ? 'CREDIT_ADJUSTMENT' : 'DEBIT_ADJUSTMENT'
    const balanceBefore = wallet.redeemablePoints

    const result = await prisma.$transaction(async (tx) => {
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          earnedPoints: type === 'CREDIT' ? { increment: amount } : { decrement: amount },
          redeemablePoints: type === 'CREDIT' ? { increment: amount } : { decrement: amount },
          lifetimeEarned: type === 'CREDIT' ? { increment: amount } : undefined,
          lastTransactionAt: new Date(),
        },
      })

      const txRecord = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          transactionType,
          points: type === 'CREDIT' ? amount : -amount,
          balanceBefore,
          balanceAfter: updatedWallet.redeemablePoints,
          balanceType: 'REDEEMABLE',
          description: `Manual ${type.toLowerCase()} by admin. Reason: ${reason}`,
        },
      })

      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'WALLET',
          entityId: wallet.id,
          actorId: authUser.userId,
          metadata: {
            partnerId,
            amount,
            type,
            reason,
            approvedBy,
            transactionId: txRecord.id,
          },
        },
      })

      return { updatedWallet, txRecord }
    })

    return ok({
      transactionId: result.txRecord.id,
      newBalance: result.updatedWallet.redeemablePoints,
    })
  } catch (e: any) {
    console.error('[wallet/adjust]', e)
    return err('Failed to adjust wallet', 500)
  }
}
