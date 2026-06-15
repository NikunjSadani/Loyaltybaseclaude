import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { requirePermission } from '@/lib/rbac/require-permission'
import { wouldCreateCycle } from '@/lib/category-tree'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const updateSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  // parentId: string to reparent, null to make it a root. undefined = leave unchanged.
  parentId: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const clientId = getClientIdFromRequest(req)
    const denied = await requirePermission(authUser as { role: string; clientId: string }, 'catalog:write')
    if (denied) return denied
    const { id } = await params

    const body = await req.json()
    const parsed = updateSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    // Verify the category belongs to this client before mutating (tenant-scoped).
    const category = await prisma.category.findFirst({ where: { id, clientId, deletedAt: null } })
    if (!category) return err('Category not found', 404)

    // Duplicate-code guard within the client.
    if (parsed.data.code && parsed.data.code !== category.code) {
      const dup = await prisma.category.findFirst({
        where: { code: parsed.data.code, clientId, deletedAt: null, id: { not: id } },
      })
      if (dup) return err(`Category code ${parsed.data.code} already exists`)
    }

    // Reparent validation: parent must be same-client and must not create a cycle.
    if (parsed.data.parentId !== undefined && parsed.data.parentId !== null) {
      if (parsed.data.parentId === id) return err('A category cannot be its own parent')
      const parent = await prisma.category.findFirst({
        where: { id: parsed.data.parentId, clientId, deletedAt: null },
      })
      if (!parent) return err('Parent category not found for this client', 404)

      const all = await prisma.category.findMany({
        where: { clientId, deletedAt: null },
        select: { id: true, parentId: true },
      })
      const edges = new Map(all.map((c) => [c.id, c.parentId]))
      if (wouldCreateCycle(id, parsed.data.parentId, edges)) {
        return err('Cannot reparent: that would make the category its own ancestor')
      }
    }

    const updated = await prisma.category.update({ where: { id }, data: parsed.data })
    return ok({ category: updated })
  } catch (e: any) {
    console.error('[admin/categories PATCH]', e)
    return err('Failed to update category', 500)
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const clientId = getClientIdFromRequest(req)
    const denied = await requirePermission(authUser as { role: string; clientId: string }, 'catalog:write')
    if (denied) return denied
    const { id } = await params

    const category = await prisma.category.findFirst({
      where: { id, clientId, deletedAt: null },
      include: { _count: { select: { children: true, skuMappings: true } } },
    })
    if (!category) return err('Category not found', 404)

    // DECISION: guard (do NOT cascade). Deleting a category that still has live
    // children or SKU mappings is blocked with a clear error, so the admin
    // consciously re-parents/unassigns first. Soft-delete only counts live
    // children (deletedAt: null) since soft-deleted ones are already gone.
    const liveChildren = await prisma.category.count({
      where: { parentId: id, clientId, deletedAt: null },
    })
    if (liveChildren > 0) {
      return err(`Cannot delete: category has ${liveChildren} sub-categor${liveChildren === 1 ? 'y' : 'ies'}. Move or delete them first.`)
    }
    if (category._count.skuMappings > 0) {
      return err(`Cannot delete: category has ${category._count.skuMappings} SKU${category._count.skuMappings === 1 ? '' : 's'} assigned. Unassign them first.`)
    }

    const deleted = await prisma.category.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    })
    return ok({ category: deleted })
  } catch (e: any) {
    console.error('[admin/categories DELETE]', e)
    return err('Failed to delete category', 500)
  }
}
