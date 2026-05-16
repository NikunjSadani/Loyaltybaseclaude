import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

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

    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.errors[0].message)

    const { partnerId, amount, type, reason, approvedBy } = parsed.data

    const wallet = await prisma.wallet.findFirst({ where: { userId: partnerId } })
    if (!wallet) return err('Wallet not found for this partner', 404)

    if (type === 'DEBIT' && wallet.earned < amount) {
      return err('Insufficient wallet balance for debit')
    }

    const result = await prisma.$transaction(async (tx) => {
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          earned: type === 'CREDIT' ? { increment: amount } : { decrement: amount },
        },
      })

      const txRecord = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          userId: partnerId,
          type,
          bucket: 'EARNED',
          amount: type === 'CREDIT' ? amount : -amount,
          balanceAfter: updatedWallet.earned,
          description: `Manual ${type.toLowerCase()} by admin. Reason: ${reason}`,
        },
      })

      await tx.auditLog.create({
        data: {
          action: `WALLET_MANUAL_${type}`,
          entityType: 'WALLET',
          entityId: wallet.id,
          performedById: authUser.userId,
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
      newBalance: result.updatedWallet.earned,
    })
  } catch (e: any) {
    console.error('[wallet/adjust]', e)
    return err('Failed to adjust wallet', 500)
  }
}
