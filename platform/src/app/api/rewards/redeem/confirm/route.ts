import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser, verifyOTP } from '@/lib/auth'
import { sendNotification } from '@/lib/notifications'
import { NotificationEvent } from '@/types'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  orderId: z.string().min(1),
  otp: z.string().length(6),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { orderId, otp } = parsed.data

    // Find pending order
    const order = await prisma.redemptionOrder.findUnique({
      where: { id: orderId },
      include: {
        reward: true,
        partner: true,
      },
    })
    if (!order) return err('Redemption order not found', 404)
    if (order.partner?.userId !== authUser.userId) return err('Forbidden', 403)
    if (order.status !== 'PENDING') return err('Order is not awaiting confirmation')

    // Verify OTP
    const valid = await verifyOTP(authUser.userId, otp, 'REDEMPTION_CONFIRM')
    if (!valid) return err('Invalid or expired OTP', 401)

    const requiredPoints = order.totalPointsCost

    // Complete redemption in transaction
    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findFirst({ where: { partnerId: order.partnerId } })
      if (!wallet) throw new Error('Wallet not found')

      if (wallet.redeemablePoints < requiredPoints) {
        throw new Error('Insufficient redeemable points')
      }

      // Deduct points from wallet
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          redeemablePoints: { decrement: requiredPoints },
          redeemedPoints: { increment: requiredPoints },
          lifetimeRedeemed: { increment: requiredPoints },
        },
      })

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          transactionType: 'DEBIT_REDEMPTION',
          points: -requiredPoints,
          balanceBefore: wallet.redeemablePoints,
          balanceAfter: updatedWallet.redeemablePoints,
          balanceType: 'REDEEMABLE',
          referenceType: 'REDEMPTION_ORDER',
          referenceId: orderId,
          description: `Redemption confirmed for order ${orderId}`,
        },
      })

      // Update order status
      const confirmedOrder = await tx.redemptionOrder.update({
        where: { id: orderId },
        data: {
          status: 'CONFIRMED',
          pointsDeducted: requiredPoints,
        },
      })

      return { confirmedOrder, updatedWallet }
    })

    // Send confirmation notification
    await sendNotification(authUser.userId, NotificationEvent.REDEMPTION_CONFIRMED, {
      orderId,
      itemName: order.reward?.name ?? '',
      points: requiredPoints,
    }).catch((e) => console.error('[rewards/redeem/confirm notification]', e))

    return ok({
      orderId,
      status: 'CONFIRMED',
      message: 'Redemption confirmed successfully. Your order is being processed.',
    })
  } catch (e: any) {
    console.error('[rewards/redeem/confirm]', e)
    return err('Failed to confirm redemption', 500)
  }
}
