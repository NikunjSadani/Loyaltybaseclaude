import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  amount: z.number().positive('Amount must be positive'),
  referenceNumber: z.string().optional(),
  paymentDate: z.string().transform((s) => new Date(s)),
  paymentMode: z.string().default('BANK_TRANSFER'),
  bankName: z.string().optional(),
  notes: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { amount, referenceNumber, paymentDate, paymentMode, bankName, notes } = parsed.data
    const amountPaise = Math.round(amount * 100)

    // Get current balance
    const latestEntry = await prisma.fundLedger.findFirst({ orderBy: { createdAt: 'desc' } })
    const currentBalance = latestEntry?.balancePaise ?? 0
    const newBalance = currentBalance + amountPaise

    const result = await prisma.$transaction(async (tx) => {
      const receiptNumber = `FR-${Date.now()}`
      const receipt = await tx.fundReceipt.create({
        data: {
          receiptNumber,
          amountPaise,
          receivedAt: paymentDate,
          paymentMode,
          referenceNumber: referenceNumber ?? null,
          bankName: bankName ?? null,
          notes: notes ?? null,
          createdByUserId: authUser.userId,
        },
      })

      const ledgerEntry = await tx.fundLedger.create({
        data: {
          ledgerType: 'RECEIPT',
          amountPaise,
          balancePaise: newBalance,
          referenceType: 'FUND_RECEIPT',
          referenceId: receipt.id,
          description: notes ?? `Fund receipt. Ref: ${referenceNumber ?? 'N/A'}`,
        },
      })

      await tx.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: 'FUND_RECEIPT',
          entityId: receipt.id,
          actorId: authUser.userId,
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
