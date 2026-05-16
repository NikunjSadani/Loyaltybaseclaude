import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const CONVERSION_RATE = parseFloat(process.env.POINTS_CONVERSION_RATE ?? '1') // 1 point = ₹1 by default

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const wallet = await prisma.wallet.findFirst({
      where: { userId: authUser.userId },
    })

    if (!wallet) {
      return ok({
        earned: 0,
        locked: 0,
        redeemable: 0,
        redeemed: 0,
        expired: 0,
        available: 0,
        currency: 'POINTS',
        conversionRate: CONVERSION_RATE,
      })
    }

    const redeemable = Math.max(0, wallet.earned - wallet.locked - wallet.redeemed)
    const available = Math.max(0, redeemable - wallet.expired)

    return ok({
      earned: wallet.earned,
      locked: wallet.locked,
      redeemable,
      redeemed: wallet.redeemed,
      expired: wallet.expired ?? 0,
      available,
      currency: 'POINTS',
      conversionRate: CONVERSION_RATE,
    })
  } catch (e: any) {
    console.error('[wallet GET]', e)
    return err('Failed to fetch wallet', 500)
  }
}
