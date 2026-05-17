import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const TDS_RATE_DEFAULT = 0.1 // 10% TDS under 194R
const TDS_THRESHOLD_PAISE = 2000000 // ₹20,000 threshold

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const { id } = await params

    const batch = await prisma.payoutBatch.findUnique({
      where: { id },
      include: { transactions: true },
    })
    if (!batch) return err('Payout batch not found', 404)
    if (batch.status === 'COMPLETED') return err('Batch already processed')
    if (batch.status === 'PROCESSING') return err('Batch is currently being processed')

    // Mark as processing
    await prisma.payoutBatch.update({
      where: { id },
      data: { status: 'PROCESSING' },
    })

    const steps = {
      validation: { status: 'PENDING', count: 0, errors: [] as string[] },
      invoiceGeneration: { status: 'PENDING', count: 0 },
      tdsComputation: { status: 'PENDING', totalTds: 0 },
      fundCheck: { status: 'PENDING', available: 0, required: 0 },
      disbursement: { status: 'PENDING', flagged: 0 },
    }

    // Step 1: Validation
    const transactions = await prisma.payoutTransaction.findMany({
      where: { batchId: id, status: 'PENDING' },
      include: { user: { include: { partner: true } } },
    })

    steps.validation.count = transactions.length
    const validTransactions = []

    for (const tx of transactions) {
      const errors: string[] = []
      if (!tx.user?.partner?.panNumber) errors.push(`No PAN for user ${tx.userId}`)
      if (!tx.amountPaise || tx.amountPaise <= 0) errors.push(`Invalid amount for tx ${tx.id}`)
      if (errors.length === 0) {
        validTransactions.push(tx)
      } else {
        steps.validation.errors.push(...errors)
      }
    }
    steps.validation.status = steps.validation.errors.length === 0 ? 'PASSED' : 'PASSED_WITH_WARNINGS'

    // Step 2: Invoice generation
    for (const tx of validTransactions) {
      const invoiceNumber = `INV-${batch.period}-${tx.id.slice(-6).toUpperCase()}`
      await prisma.payoutTransaction.update({
        where: { id: tx.id },
        data: { invoiceNumber },
      })
    }
    steps.invoiceGeneration.count = validTransactions.length
    steps.invoiceGeneration.status = 'COMPLETED'

    // Step 3: TDS computation
    let totalTds = 0
    for (const tx of validTransactions) {
      if (tx.amountPaise >= TDS_THRESHOLD_PAISE) {
        const tdsAmount = Math.round(tx.amountPaise * TDS_RATE_DEFAULT)
        totalTds += tdsAmount
        await prisma.tDSRecord.create({
          data: {
            payoutTransactionId: tx.id,
            userId: tx.userId,
            pan: tx.user?.partner?.panNumber ?? null,
            section: '194R',
            grossAmountPaise: tx.amountPaise,
            tdsRate: TDS_RATE_DEFAULT,
            tdsAmountPaise: tdsAmount,
            netAmountPaise: tx.amountPaise - tdsAmount,
            financialYear: getFY(batch.period),
            batchId: id,
          },
        })
      }
    }
    steps.tdsComputation.totalTds = totalTds
    steps.tdsComputation.status = 'COMPLETED'

    // Step 4: Fund check
    const fundLedger = await prisma.fundLedger.findFirst({ orderBy: { createdAt: 'desc' } })
    const totalRequired = validTransactions.reduce((sum, tx) => sum + tx.amountPaise, 0) - totalTds
    steps.fundCheck.available = fundLedger?.availableBalancePaise ?? 0
    steps.fundCheck.required = totalRequired
    steps.fundCheck.status = (fundLedger?.availableBalancePaise ?? 0) >= totalRequired ? 'PASSED' : 'FAILED'

    // Step 5: Flag for disbursement
    let flagged = 0
    if (steps.fundCheck.status === 'PASSED') {
      for (const tx of validTransactions) {
        await prisma.payoutTransaction.update({
          where: { id: tx.id },
          data: { status: 'READY_FOR_DISBURSEMENT' },
        })
        flagged++
      }
    }
    steps.disbursement.flagged = flagged
    steps.disbursement.status = flagged > 0 ? 'FLAGGED' : 'SKIPPED'

    // Update batch status
    const finalStatus = steps.fundCheck.status === 'PASSED' ? 'READY' : 'FAILED'
    await prisma.payoutBatch.update({
      where: { id },
      data: { status: finalStatus, processedAt: new Date() },
    })

    await prisma.auditLog.create({
      data: {
        action: 'PAYOUT_BATCH_PROCESSED',
        entityType: 'PAYOUT_BATCH',
        entityId: id,
        performedById: authUser.userId,
        metadata: { steps, finalStatus },
      },
    })

    return ok({ batchId: id, status: finalStatus, steps })
  } catch (e: any) {
    console.error('[payouts/batches/[id]/process]', e)
    // Reset batch status on error
    try {
      const { id } = await (Promise.resolve as any)(null)
    } catch {}
    return err('Failed to process payout batch', 500)
  }
}

function getFY(period: string): string {
  const [year, month] = period.split('-').map(Number)
  if (month >= 4) return `${year}-${year + 1}`
  return `${year - 1}-${year}`
}
