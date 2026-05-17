import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const createSchema = z.object({
  title: z.string().min(1),
  imageUrl: z.string().url(),
  linkUrl: z.string().url().optional(),
  targetAudience: z.enum(['ALL', 'RETAILER', 'WHOLESALER', 'SUB_STOCKIST']).default('ALL'),
  startDate: z.string().transform((s) => new Date(s)),
  endDate: z.string().transform((s) => new Date(s)).optional(),
  priority: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const sp = req.nextUrl.searchParams
    const isActive = sp.get('isActive')
    const audience = sp.get('audience') ?? undefined

    const where: any = {}
    if (isActive !== null && isActive !== undefined) where.isActive = isActive === 'true'
    if (audience) {
      where.OR = [{ targetAudience: 'ALL' }, { targetAudience: audience.toUpperCase() }]
    }
    // Only show non-expired banners for non-admin
    if (authUser.role !== 'GIFSY_ADMIN') {
      where.isActive = true
      where.startDate = { lte: new Date() }
      where.OR = [{ endDate: null }, { endDate: { gte: new Date() } }]
    }

    const banners = await prisma.banner.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    })

    return ok({ banners })
  } catch (e: any) {
    console.error('[admin/banners GET]', e)
    return err('Failed to fetch banners', 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const body = await req.json()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.errors[0].message)

    const banner = await prisma.banner.create({
      data: { ...parsed.data, createdById: authUser.userId },
    })

    return ok({ banner }, 201)
  } catch (e: any) {
    console.error('[admin/banners POST]', e)
    return err('Failed to create banner', 500)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const sp = req.nextUrl.searchParams
    const id = sp.get('id')
    if (!id) return err('Banner ID is required')

    await prisma.banner.delete({ where: { id } })

    return ok({ message: 'Banner deleted successfully' })
  } catch (e: any) {
    console.error('[admin/banners DELETE]', e)
    return err('Failed to delete banner', 500)
  }
}
