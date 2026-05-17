import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const createSchema = z.object({
  name: z.string().min(1),
  partnerClass: z.enum(['RETAILER', 'WHOLESALER', 'SUB_STOCKIST']),
  minPoints: z.number().int().min(0),
  maxPoints: z.number().int().optional(),
  benefits: z.record(z.any()).optional(),
  multiplier: z.number().positive().default(1),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const sp = req.nextUrl.searchParams
    const partnerClass = sp.get('class') ?? undefined

    const tiers = await prisma.tier.findMany({
      where: { ...(partnerClass && { partnerClass }) },
      orderBy: [{ partnerClass: 'asc' }, { minPoints: 'asc' }],
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

    const body = await req.json()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.errors[0].message)

    const tier = await prisma.tier.create({ data: parsed.data })

    return ok({ tier }, 201)
  } catch (e: any) {
    console.error('[admin/tiers POST]', e)
    return err('Failed to create tier', 500)
  }
}
