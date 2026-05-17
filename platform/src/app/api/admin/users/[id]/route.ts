import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  role: z.string().optional(),
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const { id } = await params

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        partner: true,
        salesProfile: true,
        wallet: { select: { earned: true, redeemed: true, locked: true } },
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
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const { id } = await params
    const body = await req.json()
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const user = await prisma.user.update({
      where: { id },
      data: { ...parsed.data, updatedAt: new Date() },
    })

    await prisma.auditLog.create({
      data: {
        action: 'USER_UPDATED',
        entityType: 'USER',
        entityId: id,
        performedById: authUser.userId,
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
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const { id } = await params

    if (id === authUser.userId) return err('Cannot delete your own account')

    // Soft delete
    await prisma.user.update({
      where: { id },
      data: { status: 'DELETED', deletedAt: new Date() },
    })

    await prisma.auditLog.create({
      data: {
        action: 'USER_DELETED',
        entityType: 'USER',
        entityId: id,
        performedById: authUser.userId,
      },
    })

    return ok({ message: 'User deleted successfully' })
  } catch (e: any) {
    console.error('[admin/users/[id] DELETE]', e)
    return err('Failed to delete user', 500)
  }
}
