import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const createSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, 'Phone must be 10 digits'),
  name: z.string().min(1),
  role: z.enum(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER', 'SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR', 'SSS', 'WHOLESALER', 'SUB_STOCKIST']),
  email: z.string().email().optional(),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const clientId = getClientIdFromRequest(req)
    const sp = req.nextUrl.searchParams
    const role = sp.get('role') ?? undefined
    const status = sp.get('status') ?? undefined
    const search = sp.get('search') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: any = { clientId }
    if (role) where.role = role
    if (status) where.status = status
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          phone: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          salesUser: { select: { id: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ])

    return ok({ users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } })
  } catch (e: any) {
    console.error('[admin/users GET]', e)
    return err('Failed to fetch users', 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const clientId = getClientIdFromRequest(req)
    const body = await req.json()
    const parsed = createSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { phone, name, role, email } = parsed.data

    const existing = await prisma.user.findFirst({ where: { phone, clientId } })
    if (existing) return err('User with this phone already exists')

    const user = await prisma.user.create({
      data: {
        phone,
        name,
        role,
        email: email ?? null,
        status: 'ACTIVE',
        clientId,
      },
    })

    await prisma.auditLog.create({
      data: {
        action: 'CREATE',
        entityType: 'USER',
        entityId: user.id,
        actorId: authUser.userId,
        metadata: { role, phone },
      },
    })

    return ok({ user }, 201)
  } catch (e: any) {
    console.error('[admin/users POST]', e)
    return err('Failed to create user', 500)
  }
}
