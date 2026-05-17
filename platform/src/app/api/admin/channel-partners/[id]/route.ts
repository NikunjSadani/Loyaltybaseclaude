import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const patchSchema = z.object({
  isActive: z.boolean().optional(),
  currentTierConfigId: z.string().optional(),
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN' && authUser.role !== 'MIS_USER') {
      return err('Forbidden', 403)
    }

    const { id } = await params

    const partner = await prisma.channelPartner.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, status: true } },
        wallets: true,
        outlets: true,
        kycSubmissions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })

    if (!partner) return err('Channel partner not found', 404)

    return ok({ partner })
  } catch (e: any) {
    console.error('[admin/channel-partners/[id] GET]', e)
    return err('Failed to fetch channel partner', 500)
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

    const partner = await prisma.channelPartner.update({
      where: { id },
      data: { ...parsed.data, updatedAt: new Date() },
    })

    await prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'CHANNEL_PARTNER',
        entityId: id,
        actorId: authUser.userId,
        metadata: parsed.data,
      },
    })

    return ok({ partner })
  } catch (e: any) {
    console.error('[admin/channel-partners/[id] PATCH]', e)
    return err('Failed to update channel partner', 500)
  }
}
