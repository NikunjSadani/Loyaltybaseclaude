import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { revokeAllSessionsForUser } from '@/lib/session'
import { requirePermission } from '@/lib/rbac/require-permission'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION']).optional(),
  role: z.enum(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER', 'SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR', 'SSS', 'WHOLESALER', 'SUB_STOCKIST']).optional(),
  phone: z.string().regex(/^\d{10}$/, 'Phone must be 10 digits').optional(),
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const { id } = await params
    const clientId = getClientIdFromRequest(req)
    const denied = await requirePermission(authUser as { role: string; clientId: string },'users:read')
    if (denied) return denied

    const user = await prisma.user.findFirst({
      where: { id, clientId },
      include: {
        channelPartner: true,
        salesUser: true,
      },
    })

    if (!user) return err('User not found', 404)

    return ok({ user })
  } catch (e: any) {
    console.error('[admin/users/[id] GET]', e)
    return err('Failed to fetch user', 500)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const { id } = await params
    const clientId = getClientIdFromRequest(req)
    const denied = await requirePermission(authUser as { role: string; clientId: string },'users:write')
    if (denied) return denied
    const body = await req.json()
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const target = await prisma.user.findFirst({ where: { id, clientId } })
    if (!target) return err('User not found', 404)

    // Phone-uniqueness guard: check BEFORE update to avoid Prisma P2002
    if (parsed.data.phone && parsed.data.phone !== target.phone) {
      const clash = await prisma.user.findFirst({
        where: { phone: parsed.data.phone, clientId, id: { not: id } },
      })
      if (clash) return err('Phone number already in use', 409)
    }

    const phoneChanged = Boolean(parsed.data.phone && parsed.data.phone !== target.phone)

    const user = await prisma.user.update({
      where: { id },
      data: { ...parsed.data, updatedAt: new Date() },
    })

    // Force re-login on all devices when login identity (phone) changes
    if (phoneChanged) {
      await revokeAllSessionsForUser(id)
    }

    await prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'USER',
        entityId: id,
        actorId: authUser.userId,
        metadata: parsed.data,
      },
    })

    return ok({ user })
  } catch (e: any) {
    console.error('[admin/users/[id] PATCH]', e)
    return err('Failed to update user', 500)
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const { id } = await params
    const clientId = getClientIdFromRequest(req)
    const denied = await requirePermission(authUser as { role: string; clientId: string },'users:delete')
    if (denied) return denied

    if (id === authUser.userId) return err('Cannot delete your own account')

    const target = await prisma.user.findFirst({ where: { id, clientId } })
    if (!target) return err('User not found', 404)

    // Soft delete
    await prisma.user.update({
      where: { id },
      data: { status: 'INACTIVE', deletedAt: new Date() },
    })

    await prisma.auditLog.create({
      data: {
        action: 'DELETE',
        entityType: 'USER',
        entityId: id,
        actorId: authUser.userId,
      },
    })

    return ok({ message: 'User deleted successfully' })
  } catch (e: any) {
    console.error('[admin/users/[id] DELETE]', e)
    return err('Failed to delete user', 500)
  }
}
