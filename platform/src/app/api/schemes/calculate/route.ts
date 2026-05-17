import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  batchId: z.string().min(1),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden - Admin only', 403)
    }

    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { batchId } = parsed.data

    const batch = await prisma.salesUpload.findUnique({ where: { id: batchId } })
    if (!batch) return err('Upload batch not found', 404)

    // Get all invoices for this batch that are valid and not yet processed
    const invoices = await prisma.salesInvoice.findMany({
      where: { salesUploadId: batchId, isValid: true },
    })

    if (invoices.length === 0) {
      return ok({ message: 'No valid invoices found for this batch', processed: 0 })
    }

    // Get all active schemes
    const schemes = await prisma.scheme.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      include: { rules: true },
    })

    let processed = 0
    let totalPointsAwarded = 0

    for (const invoice of invoices) {
      for (const scheme of schemes) {
        const points = computeIncentive(scheme, invoice.totalAmountPaise / 100)

        if (points > 0) {
          const wallet = await prisma.wallet.findFirst({
            where: { partnerId: invoice.partnerId },
          })

          if (wallet) {
            const updatedWallet = await prisma.wallet.update({
              where: { id: wallet.id },
              data: {
                earnedPoints: { increment: points },
                redeemablePoints: { increment: points },
                lifetimeEarned: { increment: points },
                lastTransactionAt: new Date(),
              },
            })

            await prisma.walletTransaction.create({
              data: {
                walletId: wallet.id,
                transactionType: 'CREDIT_POINTS_EARNED',
                points,
                balanceBefore: updatedWallet.earnedPoints - points,
                balanceAfter: updatedWallet.earnedPoints,
                balanceType: 'EARNED',
                referenceType: 'SALES_INVOICE',
                referenceId: invoice.id,
                description: `Incentive for invoice ${invoice.invoiceNumber} under scheme ${scheme.name}`,
              },
            })

            totalPointsAwarded += points
          }
        }
      }

      processed++
    }

    await prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'UPLOAD_BATCH',
        entityId: batchId,
        actorId: authUser.userId,
        metadata: { processed, totalPointsAwarded },
      },
    })

    return ok({ processed, totalPointsAwarded, batchId })
  } catch (e: any) {
    console.error('[schemes/calculate]', e)
    return err('Failed to trigger incentive calculation', 500)
  }
}

function computeIncentive(scheme: any, amount: number): number {
  if (scheme.fixedPoints != null) return scheme.fixedPoints
  if (scheme.pointsPerRupee != null) {
    return Math.round(amount * parseFloat(scheme.pointsPerRupee.toString()))
  }
  return 0
}
