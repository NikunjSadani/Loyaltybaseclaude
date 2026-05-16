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
    if (!parsed.success) return err(parsed.error.errors[0].message)

    const { batchId } = parsed.data

    const batch = await prisma.uploadBatch.findUnique({ where: { id: batchId } })
    if (!batch) return err('Upload batch not found', 404)

    // Get all invoices for this batch
    const invoices = await prisma.invoice.findMany({
      where: { uploadBatchId: batchId, status: 'PENDING' },
      include: { sku: true },
    })

    if (invoices.length === 0) {
      return ok({ message: 'No pending invoices found for this batch', processed: 0 })
    }

    // Get all active schemes
    const schemes = await prisma.scheme.findMany({
      where: { status: 'ACTIVE', isDeleted: false },
      include: { slabs: { orderBy: { minValue: 'asc' } } },
    })

    let processed = 0
    let totalPointsAwarded = 0

    for (const invoice of invoices) {
      for (const scheme of schemes) {
        const points = computeIncentive(scheme, invoice.totalAmountPaise / 100)

        if (points > 0) {
          const wallet = await prisma.wallet.findFirst({
            where: { userId: invoice.uploadedById },
          })

          if (wallet) {
            const updatedWallet = await prisma.wallet.update({
              where: { id: wallet.id },
              data: { earned: { increment: points } },
            })

            await prisma.walletTransaction.create({
              data: {
                walletId: wallet.id,
                userId: invoice.uploadedById,
                type: 'CREDIT',
                bucket: 'EARNED',
                amount: points,
                balanceAfter: updatedWallet.earned,
                description: `Incentive for invoice ${invoice.invoiceNumber} under scheme ${scheme.name}`,
                invoiceId: invoice.id,
                schemeId: scheme.id,
              },
            })

            totalPointsAwarded += points
          }
        }
      }

      // Mark invoice as processed
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'PROCESSED', pointsEarned: computeTotalPoints(schemes, invoice.totalAmountPaise / 100), processedAt: new Date() },
      })

      processed++
    }

    await prisma.auditLog.create({
      data: {
        action: 'INCENTIVE_RECALCULATION',
        entityType: 'UPLOAD_BATCH',
        entityId: batchId,
        performedById: authUser.userId,
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
  if (scheme.calculationMethod === 'FLAT') return scheme.flatPoints ?? 0
  if (scheme.calculationMethod === 'PERCENTAGE') {
    return Math.round((amount * (scheme.ratePercent ?? 0)) / 100)
  }
  if (scheme.calculationMethod === 'PER_UNIT') {
    return Math.round(amount * (scheme.pointsPerUnit ?? 0))
  }
  if (scheme.calculationMethod === 'SLAB' && scheme.slabs?.length > 0) {
    const slab = [...scheme.slabs]
      .reverse()
      .find((s: any) => amount >= s.minValue && (s.maxValue == null || amount <= s.maxValue))
    return slab ? slab.payoutValue : 0
  }
  return 0
}

function computeTotalPoints(schemes: any[], amount: number): number {
  return schemes.reduce((sum, s) => sum + computeIncentive(s, amount), 0)
}
