import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  message: z.string().min(1),
  attachments: z.array(z.string()).optional(),
  isInternal: z.boolean().default(false),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    const { id } = await params
    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { message: messageText, attachments, isInternal } = parsed.data

    const ticket = await prisma.ticket.findFirst({ where: { id, clientId } })
    if (!ticket) return err('Ticket not found', 404)

    if (authUser.role !== 'GIFSY_ADMIN' && ticket.createdById !== authUser.userId) {
      return err('Forbidden', 403)
    }

    if (ticket.status === 'CLOSED') return err('Cannot add message to a closed ticket')

    // Internal notes only for admin
    if (isInternal && authUser.role !== 'GIFSY_ADMIN') {
      return err('Forbidden - Internal notes are admin only', 403)
    }

    const message = await prisma.$transaction(async (tx) => {
      const msg = await tx.ticketMessage.create({
        data: {
          ticketId: id,
          message: messageText,
          attachments: attachments ?? [],
          senderId: authUser.userId,
          isInternal,
        },
      })

      // Update ticket status if user is replying to open ticket
      if (authUser.role === 'GIFSY_ADMIN' && ticket.status === 'OPEN') {
        await tx.ticket.update({
          where: { id },
          data: { status: 'IN_PROGRESS', updatedAt: new Date() },
        })
      }

      return msg
    })

    return ok({ message }, 201)
  } catch (e: any) {
    console.error('[tickets/[id]/messages]', e)
    return err('Failed to add message', 500)
  }
}
