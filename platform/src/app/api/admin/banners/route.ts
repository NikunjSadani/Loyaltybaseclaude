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
  position: z.enum(['HOME_TOP', 'HOME_MIDDLE', 'HOME_BOTTOM', 'CATALOG_TOP', 'SCHEME_PAGE', 'DASHBOARD']),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SCHEDULED']).default('INACTIVE'),
  targetClasses: z.array(z.enum(['CP_01', 'CP_02', 'CP_03'])).default([]),
  startDate: z.string().transform((s) => new Date(s)).optional(),
  endDate: z.string().transform((s) => new Date(s)).optional(),
  sortOrder: z.number().int().min(0).default(0),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const where: any = {}
    // Only show active banners for non-admins
    if (authUser.role !== 'GIFSY_ADMIN') {
      where.status = 'ACTIVE'
      where.OR = [{ endDate: null }, { endDate: { gte: new Date() } }]
    }

    const banners = await prisma.bannerManagement.findMany({
      where,
      orderBy: [{ sortOrder: 'desc' }, { createdAt: 'desc' }],
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
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { ...data } = parsed.data

    const banner = await prisma.bannerManagement.create({
      data: { ...data, createdByUserId: authUser.userId },
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

    await prisma.bannerManagement.delete({ where: { id } })

    return ok({ message: 'Banner deleted successfully' })
  } catch (e: any) {
    console.error('[admin/banners DELETE]', e)
    return err('Failed to delete banner', 500)
  }
}
