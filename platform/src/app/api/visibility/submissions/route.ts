import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const sp = req.nextUrl.searchParams
    const outletId = sp.get('outletId') ?? undefined
    const programId = sp.get('programId') ?? undefined
    const status = sp.get('status') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: any = {}
    if (authUser.role !== 'GIFSY_ADMIN') {
      where.submittedById = authUser.userId
    }
    if (outletId) where.outletId = outletId
    if (programId) where.programId = programId
    if (status) where.status = status

    const [submissions, total] = await Promise.all([
      prisma.visibilitySubmission.findMany({
        where,
        include: {
          submittedBy: { select: { id: true, name: true, mobile: true } },
          outlet: { select: { id: true, name: true, city: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.visibilitySubmission.count({ where }),
    ])

    return ok({
      submissions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[visibility/submissions]', e)
    return err('Failed to fetch submissions', 500)
  }
}
