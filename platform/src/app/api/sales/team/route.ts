import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const salesUser = await prisma.salesUser.findFirst({
      where: { userId: authUser.userId, deletedAt: null },
      include: {
        hierarchyLevel: { select: { code: true, name: true, level: true } },
        subordinates: {
          where: { isActive: true, deletedAt: null },
          include: {
            user:           { select: { name: true } },
            hierarchyLevel: { select: { code: true, name: true, level: true } },
            _count:         { select: { subordinates: true } },
          },
        },
      },
    })

    if (!salesUser) return ok({ salesUser: null, members: [] })

    const members = salesUser.subordinates.map((sub) => ({
      id:           sub.id,
      employeeCode: sub.employeeCode,
      name:         sub.user.name,
      role:         sub.hierarchyLevel.code,
      roleLabel:    sub.hierarchyLevel.name,
      territory:    sub.region ?? sub.zone ?? '',
      teamSize:     sub._count.subordinates,
      joinedAt:     sub.joinedAt.toISOString(),
    }))

    return ok({
      salesUser: {
        id:           salesUser.id,
        employeeCode: salesUser.employeeCode,
        role:         salesUser.hierarchyLevel.code,
        roleLabel:    salesUser.hierarchyLevel.name,
        level:        salesUser.hierarchyLevel.level,
        region:       salesUser.region,
        zone:         salesUser.zone,
      },
      members,
    })
  } catch (e: any) {
    console.error('[sales/team GET]', e)
    return err('Failed to fetch team', 500)
  }
}
