import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const CONVERSION_RATE = parseFloat(process.env.POINTS_CONVERSION_RATE ?? '1') // 1 point = ₹1 by default

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    // Look up the channel partner for this user
    const channelPartner = await prisma.channelPartner.findFirst({
      where: { userId: authUser.userId, user: { clientId } },
    })

    if (!channelPartner) {
      return ok({
        earnedPoints: 0,
        lockedPoints: 0,
        redeemablePoints: 0,
        redeemedPoints: 0,
        expiredPoints: 0,
        currency: 'POINTS',
        conversionRate: CONVERSION_RATE,
      })
    }

    const wallet = await prisma.wallet.findFirst({
      where: { partnerId: channelPartner.id },
    })

    if (!wallet) {
      return ok({
        earnedPoints: 0,
        lockedPoints: 0,
        redeemablePoints: 0,
        redeemedPoints: 0,
        expiredPoints: 0,
        currency: 'POINTS',
        conversionRate: CONVERSION_RATE,
      })
    }

    return ok({
      earnedPoints: wallet.earnedPoints,
      lockedPoints: wallet.lockedPoints,
      redeemablePoints: wallet.redeemablePoints,
      redeemedPoints: wallet.redeemedPoints,
      expiredPoints: wallet.expiredPoints,
      lifetimeEarned: wallet.lifetimeEarned,
      lifetimeRedeemed: wallet.lifetimeRedeemed,
      currency: 'POINTS',
      conversionRate: CONVERSION_RATE,
    })
  } catch (e: any) {
    console.error('[wallet GET]', e)
    return err('Failed to fetch wallet', 500)
  }
}
