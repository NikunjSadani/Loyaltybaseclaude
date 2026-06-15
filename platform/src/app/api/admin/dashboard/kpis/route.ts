import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

const PENDING_KYC_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'PENDING_SO_APPROVAL',
  'PENDING_ASM_APPROVAL',
  'PENDING_RSM_APPROVAL',
  'PENDING_GIFSY',
]

const ALLOWED_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'])

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (!ALLOWED_ROLES.has(authUser.role)) return err('Forbidden', 403)

    const clientId = getClientIdFromRequest(req)

    const [
      activePartners,
      pendingKyc,
      pendingVisibility,
      walletAggregate,
      payoutGroups,
    ] = await Promise.all([
      prisma.channelPartner.count({
        where: { clientId, isActive: true, deletedAt: null },
      }),

      prisma.kycSubmission.count({
        where: {
          user: { clientId },
          status: { in: PENDING_KYC_STATUSES as any },
        },
      }),

      prisma.visibilitySubmission.count({
        where: {
          partner: { clientId },
          status: 'SUBMITTED' as any,
        },
      }),

      prisma.wallet.aggregate({
        _sum: { redeemablePoints: true },
        where: { partner: { clientId } },
      }),

      prisma.payoutTransaction.groupBy({
        by: ['status'],
        where: { partner: { clientId } },
        _count: { id: true },
        _sum:   { netAmountPaise: true },
      }),
    ])

    const totalRedeemablePoints = walletAggregate._sum.redeemablePoints ?? 0

    const payoutSummary: Record<string, { count: number; amountPaise: number }> = {}
    for (const g of payoutGroups) {
      payoutSummary[g.status] = {
        count:       g._count.id,
        amountPaise: g._sum.netAmountPaise ?? 0,
      }
    }

    return ok({
      activePartners,
      pendingKyc,
      pendingVisibility,
      totalRedeemablePoints,
      payoutSummary,
    })
  } catch (e: any) {
    console.error('[admin/dashboard/kpis GET]', e)
    return err('Failed to fetch KPIs', 500)
  }
}
