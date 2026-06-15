import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

type TxType = 'earn' | 'redeem' | 'hold' | 'expire' | 'credit'

function mapTxType(type: string): TxType {
  switch (type) {
    case 'CREDIT_POINTS_EARNED': return 'earn'
    case 'CREDIT_BONUS':
    case 'CREDIT_ADJUSTMENT':
    case 'CREDIT_REVERSAL':
    case 'UNLOCK_HOLDING':       return 'credit'
    case 'DEBIT_REDEMPTION':
    case 'DEBIT_ADJUSTMENT':     return 'redeem'
    case 'DEBIT_EXPIRY':         return 'expire'
    case 'LOCK_HOLDING':         return 'hold'
    default:                     return 'credit'
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const { id } = await params

    const submission = await prisma.kycSubmission.findFirst({
      where: { id },
      include: {
        partner: {
          select: {
            businessName: true,
            phone: true,
            outlets: {
              where:  { isPrimary: true, deletedAt: null },
              select: { outletCode: true },
              take:   1,
            },
            wallets: {
              include: {
                transactions: { orderBy: { createdAt: 'desc' }, take: 200 },
              },
            },
          },
        },
      },
    })

    if (!submission) return err('KYC submission not found', 404)

    const partner = submission.partner
    const wallet  = partner?.wallets[0] ?? null

    return ok({
      meta: {
        name:       partner?.businessName ?? 'Unknown',
        outletCode: partner?.outlets[0]?.outletCode ?? '',
        mobile:     partner?.phone ?? '',
        balance:    wallet?.redeemablePoints ?? 0,
        lifetime:   wallet?.lifetimeEarned ?? 0,
        redeemed:   wallet?.lifetimeRedeemed ?? 0,
      },
      transactions: (wallet?.transactions ?? []).map((tx) => ({
        id:          tx.id,
        date:        tx.createdAt.toISOString().split('T')[0],
        description: tx.description ?? '',
        type:        mapTxType(tx.transactionType),
        points:      tx.points,
        balance:     tx.balanceAfter,
        ref:         tx.referenceId ?? undefined,
      })),
    })
  } catch (e: any) {
    console.error('[kyc/[id]/ledger GET]', e)
    return err('Failed to fetch ledger', 500)
  }
}
