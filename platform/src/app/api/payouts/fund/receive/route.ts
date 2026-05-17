import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  amount: z.number().positive('Amount must be positive'),
  referenceNumber: z.string().min(1, 'Reference number is required'),
  paymentDate: z.string().transform((s) => new Date(s)),
  remarks: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.errors[0].message)

    const { amount, referenceNumber, paymentDate, remarks } = parsed.data
    const amountPaise = Math.round(amount * 100)

    // Check for duplicate reference number
    const existing = await prisma.fundReceipt.findFirst({ where: { referenceNumber } })
    if (existing) return err(`Reference number ${referenceNumber} already recorded`)

    // Get current balance
    const latestEntry = await prisma.fundLedger.findFirst({ orderBy: { createdAt: 'desc' } })
    const currentBalance = latestEntry?.availableBalancePaise ?? 0
    const newBalance = currentBalance + amountPaise

    const result = await prisma.$transaction(async (tx) => {
      const receipt = await tx.fundReceipt.create({
        data: {
          amountPaise,
          referenceNumber,
          paymentDate,
          remarks: remarks ?? null,
          recordedById: authUser.userId,
          source: 'DEOLEO',
        },
      })

      const ledgerEntry = await tx.fundLedger.create({
        data: {
          type: 'CREDIT',
          amountPaise,
          referenceId: receipt.id,
          description: `Fund receipt from Deoleo. Ref: ${referenceNumber}`,
          openingBalancePaise: currentBalance,
          availableBalancePaise: newBalance,
          recordedById: authUser.userId,
        },
      })

      await tx.auditLog.create({
        data: {
          action: 'FUND_RECEIVED',
          entityType: 'FUND_RECEIPT',
          entityId: receipt.id,
          performedById: authUser.userId,
          metadata: { amountPaise, referenceNumber, newBalance },
        },
      })

      return { receipt, ledgerEntry }
    })

    return ok({
      receiptId: result.receipt.id,
      amount: amountPaise / 100,
      newBalance: newBalance / 100,
      referenceNumber,
    }, 201)
  } catch (e: any) {
    console.error('[payouts/fund/receive]', e)
    return err('Failed to record fund receipt', 500)
  }
}
