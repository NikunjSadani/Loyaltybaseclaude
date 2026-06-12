import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  escalateTo: z.string().min(1, 'Escalation target user ID is required'),
  reason: z.string().min(1),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Admin only', 403)
    const clientId = getClientIdFromRequest(req)

    const { id } = await params
    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { escalateTo, reason, priority } = parsed.data

    const ticket = await prisma.ticket.findFirst({ where: { id, clientId } })
    if (!ticket) return err('Ticket not found', 404)

    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id },
        data: {
          status: 'ESCALATED',
          priority,
          assignedToId: escalateTo,
          updatedAt: new Date(),
        },
      })

      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          message: `Ticket escalated. Reason: ${reason}`,
          senderId: authUser.userId,
          isInternal: true,
        },
      })

      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'TICKET',
          entityId: id,
          actorId: authUser.userId,
          metadata: { escalateTo, reason, priority },
        },
      })
    })

    return ok({ message: 'Ticket escalated successfully' })
  } catch (e: any) {
    console.error('[tickets/[id]/escalate]', e)
    return err('Failed to escalate ticket', 500)
  }
}
