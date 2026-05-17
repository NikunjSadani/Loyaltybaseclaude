import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const createSchema = z.object({
  category: z.string().min(1),
  subject: z.string().min(1).max(255),
  description: z.string().min(1),
  attachments: z.array(z.string().url()).optional(),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const sp = req.nextUrl.searchParams
    const status = sp.get('status') ?? undefined
    const category = sp.get('category') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: any = {}
    if (authUser.role !== 'GIFSY_ADMIN') {
      where.createdById = authUser.userId
    }
    if (status) where.status = status
    if (category) where.category = category

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        include: {
          createdBy: { select: { id: true, name: true, mobile: true } },
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

    const body = await req.json()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.errors[0].message)

    const { category, subject, description, attachments } = parsed.data

    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`

    const ticket = await prisma.ticket.create({
      data: {
        ticketNumber,
        category,
        subject,
        description,
        attachments: attachments ?? [],
        status: 'OPEN',
        priority: 'MEDIUM',
        createdById: authUser.userId,
        messages: {
          create: {
            content: description,
            authorId: authUser.userId,
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
