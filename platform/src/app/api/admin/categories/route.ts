import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { requirePermission } from '@/lib/rbac/require-permission'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const createSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().min(1).optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const clientId = getClientIdFromRequest(req)
    const denied = await requirePermission(authUser as { role: string; clientId: string }, 'catalog:read')
    if (denied) return denied
    const sp = req.nextUrl.searchParams
    const search = sp.get('search') ?? undefined

    const where: any = { clientId, deletedAt: null }
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ]
    }

    // Flat list ordered so the UI can nest into a tree (sortOrder, then name).
    // Each row carries `parentId` plus a count of SKU mappings for display.
    const categories = await prisma.category.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { children: true, skuMappings: true } } },
    })

    return ok({ categories })
  } catch (e: any) {
    console.error('[admin/categories GET]', e)
    return err('Failed to fetch categories', 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const clientId = getClientIdFromRequest(req)
    const denied = await requirePermission(authUser as { role: string; clientId: string }, 'catalog:write')
    if (denied) return denied
    const body = await req.json()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const existing = await prisma.category.findFirst({
      where: { code: parsed.data.code, clientId, deletedAt: null },
    })
    if (existing) return err(`Category code ${parsed.data.code} already exists`)

    // If a parent is given, verify it belongs to the same client (tenant-scoped).
    if (parsed.data.parentId) {
      const parent = await prisma.category.findFirst({
        where: { id: parsed.data.parentId, clientId, deletedAt: null },
      })
      if (!parent) return err('Parent category not found for this client', 404)
    }

    const category = await prisma.category.create({ data: { ...parsed.data, clientId } })

    return ok({ category }, 201)
  } catch (e: any) {
    console.error('[admin/categories POST]', e)
    return err('Failed to create category', 500)
  }
}
