import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { isSelfOrDescendant } from '@/lib/sales-hierarchy-access'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const { memberId } = await params
    const clientId = getClientIdFromRequest(req)

    // ── Tenant scope + ownership check (cross-tenant IDOR guard) ──────────────
    // Resolve the caller's own SalesUser and load this tenant's reporting edges,
    // then verify the target is the caller or a descendant in their subtree.
    const callerSalesUser = await prisma.salesUser.findFirst({
      where: { userId: authUser.userId, user: { clientId }, deletedAt: null },
      select: { id: true },
    })
    if (!callerSalesUser) return err('Forbidden', 403)

    const edges = await prisma.salesUser.findMany({
      where: { user: { clientId }, deletedAt: null },
      select: { id: true, reportingToId: true },
    })
    if (!isSelfOrDescendant(memberId, callerSalesUser.id, edges)) {
      return err('Forbidden', 403)
    }

    const now        = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

    const salesUser = await prisma.salesUser.findFirst({
      where: { id: memberId, deletedAt: null, user: { clientId } },
      include: {
        user:           { select: { name: true, phone: true } },
        hierarchyLevel: { select: { code: true, name: true, level: true } },
        _count:         { select: { subordinates: true } },
        assignments: {
          where: { outletId: { not: null }, unassignedAt: null },
          include: {
            outlet: {
              include: {
                partner: {
                  select: {
                    kycSubmissions: {
                      orderBy: { createdAt: 'desc' },
                      take:     1,
                      select:   { id: true, status: true },
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
        },
      },
    })

    if (!salesUser) return err('Member not found', 404)

    const outletAssignments = salesUser.assignments.filter((a) => a.outlet)

    const kycDone = outletAssignments.filter(
      (a) => a.outlet!.partner.kycSubmissions[0]?.status === 'APPROVED',
    ).length

    const kycPending = outletAssignments.filter((a) => {
      const s = a.outlet!.partner.kycSubmissions[0]?.status
      return !s || !['APPROVED', 'REJECTED', 'NOT_INTERESTED'].includes(s)
    }).length

    const pcts = outletAssignments
      .map((a) => a.outlet!.partner.targets[0]?.achievements[0]?.achievementPercent)
      .filter((p): p is NonNullable<typeof p> => p !== undefined && p !== null)
      .map(Number)

    const targetPct = pcts.length
      ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length)
      : 0

    const outlets = outletAssignments.map((a) => {
      const outlet    = a.outlet!
      const latestKyc = outlet.partner.kycSubmissions[0] ?? null
      return {
        id:        outlet.id,
        name:      outlet.name,
        location:  outlet.city,
        outletCode: outlet.outletCode,
        kycId:     latestKyc?.id ?? '',
        kycStatus: latestKyc?.status ?? 'NOT_STARTED',
        targetPct: 0,
      }
    })

    return ok({
      member: {
        id:                salesUser.id,
        name:              salesUser.user.name,
        role:              salesUser.hierarchyLevel.code as string,
        roleLabel:         salesUser.hierarchyLevel.name,
        territory:         salesUser.region ?? salesUser.zone ?? '',
        employeeId:        salesUser.employeeCode,
        mobile:            salesUser.user.phone ?? '',
        targetPct,
        kycDone,
        kycPending,
        visibilityPending: 0,
        teamSize:          salesUser._count.subordinates,
        activity:          [],
        outlets,
      },
    })
  } catch (e: any) {
    console.error('[sales/team/[memberId] GET]', e)
    return err('Failed to fetch member', 500)
  }
}
