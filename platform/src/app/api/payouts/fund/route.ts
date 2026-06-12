import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'MIS_USER') {
      return err('Forbidden', 403)
    }

    const clientId = getClientIdFromRequest(req)

    const latestEntry = await prisma.fundLedger.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    })

    // Total received
    const received = await prisma.fundReceipt.aggregate({
      where: { clientId },
      _sum: { amountPaise: true },
    })

    // Total utilised by mode
    const utilisedByMode = await prisma.payoutTransaction.groupBy({
      by: ['payoutMode'],
      where: { batch: { clientId }, status: { in: ['SUCCESS', 'INITIATED'] } },
      _sum: { amountPaise: true },
    })

    // Pending liability
    const pendingLiability = await prisma.payoutTransaction.aggregate({
      where: { batch: { clientId }, status: 'PENDING' },
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
