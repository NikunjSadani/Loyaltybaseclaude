import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

function toPeriod(d: Date): string {
  const yr = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  return `${yr}-${mo}`
}

function mapStatus(s: string): 'PAID' | 'PENDING' | 'PROCESSING' | 'FAILED' {
  if (s === 'PAID' || s === 'COMPLETED') return 'PAID'
  if (s === 'FAILED' || s === 'REVERSED') return 'FAILED'
  if (s === 'INITIATED' || s === 'PROCESSING') return 'PROCESSING'
  return 'PENDING'
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const partner = await prisma.channelPartner.findFirst({
      where:  { userId: authUser.userId },
      select: { id: true },
    })
    if (!partner) return ok({ payouts: [] })

    const transactions = await prisma.payoutTransaction.findMany({
      where:   { partnerId: partner.id },
      include: {
        batch: {
          select: { batchCode: true, notes: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    const payouts = transactions.map((t) => ({
      id:              t.id,
      period:          toPeriod(t.completedAt ?? t.createdAt),
      kpiLabel:        t.batch?.notes ?? 'Incentive Payout',
      achievedPct:     100,
      payoutAmountInr: Math.round(t.netAmountPaise / 100),
      uploadedAt:      (t.batch?.createdAt ?? t.createdAt).toISOString(),
      utr:             t.providerRefId ?? undefined,
      paidAt:          t.completedAt?.toISOString() ?? undefined,
      status:          mapStatus(t.status),
      narration:       t.batch?.notes ?? undefined,
    }))

    return ok({ payouts })
  } catch (e: any) {
    console.error('[partner/payouts GET]', e)
    return err('Failed to fetch payouts', 500)
  }
}
