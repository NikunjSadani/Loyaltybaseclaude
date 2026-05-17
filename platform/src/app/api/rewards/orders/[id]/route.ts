import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const patchSchema = z.object({
  status: z.enum(['CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED', 'FAILED', 'CANCELLED', 'RETURNED']).optional(),
  trackingNumber: z.string().optional(),
  trackingUrl: z.string().url().optional(),
  notes: z.string().optional(),
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const { id } = await params

    const order = await prisma.redemptionOrder.findUnique({
      where: { id },
      include: {
        reward: true,
        partner: { select: { id: true, businessName: true, userId: true } },
      },
    })

    if (!order) return err('Order not found', 404)

    // Check access - non-admin users can only see their own orders
    if (authUser.role !== 'GIFSY_ADMIN' && order.partner?.userId !== authUser.userId) {
      return err('Forbidden', 403)
    }

    return ok({ order })
  } catch (e: any) {
    console.error('[rewards/orders/[id] GET]', e)
    return err('Failed to fetch order', 500)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Admin only', 403)

    const { id } = await params
    const body = await req.json()
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const order = await prisma.redemptionOrder.update({
      where: { id },
      data: parsed.data,
    })

    return ok({ order })
  } catch (e: any) {
    console.error('[rewards/orders/[id] PATCH]', e)
    return err('Failed to update order', 500)
  }
}
