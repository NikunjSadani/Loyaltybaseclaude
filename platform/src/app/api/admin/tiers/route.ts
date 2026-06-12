import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const createSchema = z.object({
  partnerClassId: z.string().min(1),
  tierName: z.string().min(1),
  tierLevel: z.number().int().min(1),
  minPoints: z.number().int().min(0),
  maxPoints: z.number().int().optional(),
  pointsMultiplier: z.number().positive().default(1),
  holdingPeriodDays: z.number().int().min(0).default(30),
  benefits: z.record(z.string(), z.any()).optional(),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const clientId = getClientIdFromRequest(req)
    const sp = req.nextUrl.searchParams
    const partnerClassId = sp.get('partnerClassId') ?? undefined

    const tiers = await prisma.tierConfig.findMany({
      where: {
        partnerClass: { clientId },
        ...(partnerClassId && { partnerClassId }),
      },
      orderBy: [{ partnerClassId: 'asc' }, { minPoints: 'asc' }],
    })

    return ok({ tiers })
  } catch (e: any) {
    console.error('[admin/tiers GET]', e)
    return err('Failed to fetch tiers', 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const clientId = getClientIdFromRequest(req)
    const body = await req.json()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    // Verify the partnerClass belongs to this client
    const partnerClass = await prisma.partnerClassConfig.findFirst({
      where: { id: parsed.data.partnerClassId, clientId },
    })
    if (!partnerClass) return err('Partner class not found for this client', 404)

    const tier = await prisma.tierConfig.create({ data: parsed.data })

    return ok({ tier }, 201)
  } catch (e: any) {
    console.error('[admin/tiers POST]', e)
    return err('Failed to create tier', 500)
  }
}
