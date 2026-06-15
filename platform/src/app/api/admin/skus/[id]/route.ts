import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { requirePermission } from '@/lib/rbac/require-permission'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const updateSchema = z.object({
  skuCode: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  brand: z.string().nullable().optional(),
  uom: z.string().optional(),
  mrpPaise: z.number().int().min(0).optional(),
  dealerPricePaise: z.number().int().min(0).nullable().optional(),
  isActive: z.boolean().optional(),
  isTaxable: z.boolean().optional(),
  hsn: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  // When present, the SKU's category mappings are fully synced to this set.
  categoryIds: z.array(z.string().min(1)).optional(),
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

    // Verify the SKU belongs to this client before mutating (tenant-scoped).
    const sku = await prisma.sku.findFirst({ where: { id, clientId, deletedAt: null } })
    if (!sku) return err('SKU not found', 404)

    if (parsed.data.skuCode && parsed.data.skuCode !== sku.skuCode) {
      const dup = await prisma.sku.findFirst({
        where: { skuCode: parsed.data.skuCode, clientId, id: { not: id } },
      })
      if (dup) return err(`SKU code ${parsed.data.skuCode} already exists`)
    }

    const { categoryIds, ...skuData } = parsed.data

    if (categoryIds) {
      // Verify all target categories belong to this client (tenant-scoped).
      if (categoryIds.length > 0) {
        const valid = await prisma.category.count({
          where: { id: { in: categoryIds }, clientId, deletedAt: null },
        })
        if (valid !== categoryIds.length) return err('One or more categories not found for this client', 404)
      }
      // Full sync: drop existing mappings, recreate from the provided set.
      await prisma.skuCategoryMapping.deleteMany({ where: { skuId: id } })
      if (categoryIds.length > 0) {
        await prisma.skuCategoryMapping.createMany({
          data: categoryIds.map((categoryId, i) => ({ skuId: id, categoryId, isPrimary: i === 0 })),
        })
      }
    }

    const updated = await prisma.sku.update({
      where: { id },
      data: skuData,
      include: { categoryMappings: { select: { categoryId: true, isPrimary: true } } },
    })
    return ok({ sku: updated })
  } catch (e: any) {
    console.error('[admin/skus PATCH]', e)
    return err('Failed to update SKU', 500)
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

    const sku = await prisma.sku.findFirst({ where: { id, clientId, deletedAt: null } })
    if (!sku) return err('SKU not found', 404)

    // Soft-delete (deactivate). Category mappings are left intact; they are
    // harmless once the SKU is excluded from listings via deletedAt.
    const deleted = await prisma.sku.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    })
    return ok({ sku: deleted })
  } catch (e: any) {
    console.error('[admin/skus DELETE]', e)
    return err('Failed to delete SKU', 500)
  }
}
