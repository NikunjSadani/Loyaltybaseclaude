import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'MIS_USER') {
      return err('Forbidden', 403)
    }

    const latestEntry = await prisma.fundLedger.findFirst({ orderBy: { createdAt: 'desc' } })

    // Total received
    const received = await prisma.fundReceipt.aggregate({
      _sum: { amountPaise: true },
    })

    // Total utilised by mode
    const utilisedByMode = await prisma.payoutTransaction.groupBy({
      by: ['payoutMode'],
      where: { status: { in: ['SUCCESS', 'INITIATED'] } },
      _sum: { amountPaise: true },
    })

    // Pending liability
    const pendingLiability = await prisma.payoutTransaction.aggregate({
      where: { status: 'PENDING' },
      _sum: { amountPaise: true },
    })

    const utilised = utilisedByMode.reduce((sum, m) => sum + (m._sum.amountPaise ?? 0), 0)
    const totalReceived = received._sum.amountPaise ?? 0
    const closingBalance = latestEntry?.balancePaise ?? totalReceived - utilised

    return ok({
      totalReceivedPaise: totalReceived,
      totalReceived: totalReceived / 100,
      utilisedByMode: utilisedByMode.map((m) => ({
        mode: m.payoutMode,
        amountPaise: m._sum.amountPaise ?? 0,
        amount: (m._sum.amountPaise ?? 0) / 100,
      })),
      totalUtilisedPaise: utilised,
      totalUtilised: utilised / 100,
      closingBalancePaise: closingBalance,
      closingBalance: closingBalance / 100,
      pendingLiabilityPaise: pendingLiability._sum.amountPaise ?? 0,
      pendingLiability: (pendingLiability._sum.amountPaise ?? 0) / 100,
      availablePaise: Math.max(0, closingBalance - (pendingLiability._sum.amountPaise ?? 0)),
      available: Math.max(0, closingBalance - (pendingLiability._sum.amountPaise ?? 0)) / 100,
    })
  } catch (e: any) {
    console.error('[payouts/fund]', e)
    return err('Failed to fetch fund ledger', 500)
  }
}
