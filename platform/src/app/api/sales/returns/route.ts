import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  invoiceId: z.string().min(1),
  lineItems: z.array(
    z.object({
      skuCode: z.string().min(1),
      quantity: z.number().int().positive(),
    })
  ).min(1),
  reason: z.string().min(1),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { invoiceId, lineItems, reason } = parsed.data

    // Find invoice
    const invoice = await prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
    })
    if (!invoice) return err('Invoice not found', 404)

    // Check ownership
    if (authUser.role !== 'GIFSY_ADMIN' && invoice.uploadedById !== authUser.userId) {
      return err('Forbidden', 403)
    }

    // Compute clawback amount (points earned proportional to returned items)
    const returnedQtyMap: Record<string, number> = {}
    for (const item of lineItems) {
      returnedQtyMap[item.skuCode] = item.quantity
    }

    const result = await prisma.$transaction(async (tx) => {
      // Create return record
      const returnRecord = await tx.salesReturn.create({
        data: {
          invoiceId,
          reason,
          returnedById: authUser.userId,
          status: 'PENDING',
          lineItems: {
            create: lineItems.map((item) => ({
              skuCode: item.skuCode,
              quantity: item.quantity,
            })),
          },
        },
        include: { lineItems: true },
      })

      // Trigger points clawback via wallet engine
      const wallet = await tx.wallet.findFirst({
        where: { userId: invoice.uploadedById },
      })

      let updatedWallet = null
      if (wallet && invoice.pointsEarned && invoice.pointsEarned > 0) {
        // Proportional clawback: (returned_qty / total_qty) * points_earned
        const clawbackPoints = Math.min(
          Math.round((lineItems.reduce((a, b) => a + b.quantity, 0) / (invoice.quantity ?? 1)) * invoice.pointsEarned),
          wallet.earned
        )

        if (clawbackPoints > 0) {
          updatedWallet = await tx.wallet.update({
            where: { id: wallet.id },
            data: {
              earned: { decrement: clawbackPoints },
              redeemed: { increment: 0 },
            },
          })

          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              userId: invoice.uploadedById,
              type: 'REVERSE',
              bucket: 'EARNED',
              amount: -clawbackPoints,
              balanceAfter: (updatedWallet as any)?.earned ?? 0,
              description: `Points clawback for return of invoice ${invoice.invoiceNumber}`,
              invoiceId,
            },
          })
        }
      }

      return { returnRecord, updatedWallet }
    })

    const currentWallet = await prisma.wallet.findFirst({
      where: { userId: invoice.uploadedById },
    })

    return ok({
      returnId: result.returnRecord.id,
      walletBalance: currentWallet
        ? {
            earned: currentWallet.earned,
            redeemable: Math.max(0, currentWallet.earned - currentWallet.locked),
            locked: currentWallet.locked,
            redeemed: currentWallet.redeemed,
          }
        : null,
    })
  } catch (e: any) {
    console.error('[sales/returns]', e)
    return err('Failed to process return', 500)
  }
}
