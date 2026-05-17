import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const createSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  brand: z.string().optional(),
  unitOfMeasure: z.string().default('UNIT'),
  pricePerUnitPaise: z.number().int().min(0),
  isActive: z.boolean().default(true),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const sp = req.nextUrl.searchParams
    const category = sp.get('category') ?? undefined
    const search = sp.get('search') ?? undefined
    const isActive = sp.get('isActive')
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: any = {}
    if (category) where.category = category
    if (isActive !== null && isActive !== undefined) where.isActive = isActive === 'true'
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [skus, total] = await Promise.all([
      prisma.sku.findMany({
        where,
        skip,
        take: limit,
        orderBy: { code: 'asc' },
      }),
      prisma.sku.count({ where }),
    ])

    return ok({ skus, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  } catch (e: any) {
    console.error('[admin/skus GET]', e)
    return err('Failed to fetch SKUs', 500)
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

    const existing = await prisma.sku.findFirst({ where: { code: parsed.data.code } })
    if (existing) return err(`SKU code ${parsed.data.code} already exists`)

    const sku = await prisma.sku.create({ data: parsed.data })

    return ok({ sku }, 201)
  } catch (e: any) {
    console.error('[admin/skus POST]', e)
    return err('Failed to create SKU', 500)
  }
}
