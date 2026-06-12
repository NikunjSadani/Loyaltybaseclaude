import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { generateOTP, storeOTP } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const deliveryAddressSchema = z.object({
  name: z.string().min(1),
  mobile: z.string().regex(/^\d{10}$/),
  address: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  pincode: z.string().length(6),
})

const schema = z.object({
  rewardId: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  deliveryAddress: deliveryAddressSchema,
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { rewardId, quantity, deliveryAddress } = parsed.data

    // Fetch reward item
    const item = await prisma.rewardCatalog.findFirst({
      where: { id: rewardId, status: 'ACTIVE', deletedAt: null, clientId },
    })
    if (!item) return err('Reward item not found or not available', 404)

    const requiredPoints = item.pointsCost * quantity

    // Find partner record
    const partner = await prisma.channelPartner.findFirst({
      where: { userId: authUser.userId, user: { clientId } },
    })
    if (!partner) return err('Partner account not found', 404)

    // Check wallet balance
    const wallet = await prisma.wallet.findFirst({ where: { partnerId: partner.id } })
    if (!wallet) return err('Wallet not found', 404)

    const available = wallet.redeemablePoints
    if (available < requiredPoints) {
      return err(`Insufficient points. Required: ${requiredPoints}, Available: ${available}`)
    }

    // Generate order number
    const orderNumber = `RDM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    // Create pending redemption order
    const order = await prisma.redemptionOrder.create({
      data: {
        partnerId: partner.id,
        rewardId,
        orderNumber,
        quantity,
        pointsDeducted: 0,
        totalPointsCost: requiredPoints,
        redemptionMode: item.redemptionMode,
        deliveryName: deliveryAddress.name,
        deliveryPhone: deliveryAddress.mobile,
        deliveryAddressLine1: deliveryAddress.address,
        deliveryCity: deliveryAddress.city,
        deliveryState: deliveryAddress.state,
        deliveryPincode: deliveryAddress.pincode,
        status: 'PENDING',
      },
    })

    // Generate and send OTP for confirmation
    const otp = generateOTP()
    await storeOTP(authUser.userId, otp, 'REDEMPTION_CONFIRM')

    // In production: send OTP via SMS/WhatsApp
    console.log(`[rewards/redeem] OTP for order ${order.id}: ${otp}`)

    return ok({
      orderId: order.id,
      orderNumber,
      requiredPoints,
      message: 'OTP sent to your registered mobile. Please confirm the redemption.',
    })
  } catch (e: any) {
    console.error('[rewards/redeem]', e)
    return err('Failed to initiate redemption', 500)
  }
}
