import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const { memberId } = await params

    const now        = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

    const member = await prisma.salesUser.findFirst({
      where:  { id: memberId, deletedAt: null },
      select: { id: true },
    })
    if (!member) return err('Member not found', 404)

    const assignments = await prisma.salesUserAssignment.findMany({
      where: {
        salesUserId:  memberId,
        outletId:     { not: null },
        unassignedAt: null,
      },
      include: {
        outlet: {
          include: {
            outletType: { select: { code: true } },
            partner: {
              select: {
                phone: true,
                kycSubmissions: {
                  orderBy: { createdAt: 'desc' },
                  take:     1,
                  select:   { id: true, status: true, createdAt: true },
                },
                targets: {
                  where: {
                    period:          'MONTHLY',
                    periodStartDate: { lte: monthEnd },
                    periodEndDate:   { gte: monthStart },
                  },
                  include: {
                    achievements: { orderBy: { calculatedAt: 'desc' }, take: 1 },
                  },
                  take: 1,
                },
              },
            },
          },
        },
      },
    })

    const outlets = assignments
      .filter((a) => a.outlet !== null)
      .map((a) => {
        const outlet      = a.outlet!
        const partner     = outlet.partner
        const latestKyc   = partner.kycSubmissions[0] ?? null
        const target      = partner.targets[0] ?? null
        const achievement = target?.achievements[0] ?? null

        return {
          id:             outlet.id,
          kycId:          latestKyc?.id ?? '',
          outletCode:     outlet.outletCode,
          name:           outlet.name,
          mobile:         outlet.phone ?? partner.phone ?? '',
          location:       outlet.city,
          beat:           outlet.district ?? '',
          district:       outlet.district ?? '',
          state:          outlet.state,
          type:           outlet.outletType.code,
          kycStatus:      latestKyc?.status ?? 'NOT_STARTED',
          kycSubmittedAt: latestKyc?.createdAt?.toISOString().split('T')[0],
          targetPct:      achievement ? Number(achievement.achievementPercent) : 0,
        }
      })

    return ok({ outlets })
  } catch (e: any) {
    console.error('[sales/team/[memberId]/outlets GET]', e)
    return err('Failed to fetch outlets', 500)
  }
}
