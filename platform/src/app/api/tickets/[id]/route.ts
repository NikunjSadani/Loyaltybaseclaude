import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const { id } = await params

    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, mobile: true } },
        assignedTo: { select: { id: true, name: true } },
        messages: {
          include: {
            author: { select: { id: true, name: true, role: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!ticket) return err('Ticket not found', 404)

    if (authUser.role !== 'GIFSY_ADMIN' && ticket.createdById !== authUser.userId) {
      return err('Forbidden', 403)
    }

    return ok({ ticket })
  } catch (e: any) {
    console.error('[tickets/[id] GET]', e)
    return err('Failed to fetch ticket', 500)
  }
}
