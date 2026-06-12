import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const createSchema = z.object({
  category: z.enum(['KYC', 'POINTS', 'REDEMPTION', 'PAYOUT', 'SCHEME', 'TECHNICAL', 'ACCOUNT', 'OTHER']),
  subject: z.string().min(1).max(255),
  description: z.string().min(1),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const clientId = getClientIdFromRequest(req)
    const sp = req.nextUrl.searchParams
    const status = sp.get('status') ?? undefined
    const category = sp.get('category') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: any = { clientId }
    if (authUser.role !== 'GIFSY_ADMIN') {
      where.createdById = authUser.userId
    }
    if (status) where.status = status
    if (category) where.category = category

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        include: {
          createdBy: { select: { id: true, name: true, phone: true } },
          assignedTo: { select: { id: true, name: true } },
          _count: { select: { messages: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.ticket.count({ where }),
    ])

    return ok({
      tickets,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[tickets GET]', e)
    return err('Failed to fetch tickets', 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const clientId = getClientIdFromRequest(req)
    const body = await req.json()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { category, subject, description } = parsed.data

    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`

    const ticket = await prisma.ticket.create({
      data: {
        ticketNumber,
        category,
        subject,
        description,
        status: 'OPEN',
        priority: 'MEDIUM',
        createdById: authUser.userId,
        clientId,
        messages: {
          create: {
            message: description,
            senderId: authUser.userId,
            isInternal: false,
          },
        },
      },
      include: {
        messages: true,
      },
    })

    return ok({ ticket }, 201)
  } catch (e: any) {
    console.error('[tickets POST]', e)
    return err('Failed to create ticket', 500)
  }
}
