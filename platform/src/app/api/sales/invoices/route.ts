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
    const partnerId = sp.get('partnerId') ?? undefined
    const dateFrom = sp.get('dateFrom') ? new Date(sp.get('dateFrom')!) : undefined
    const dateTo = sp.get('dateTo') ? new Date(sp.get('dateTo')!) : undefined
    const skuCode = sp.get('skuCode') ?? undefined
    const page = parseInt(sp.get('page') ?? '1', 10)
    const limit = parseInt(sp.get('limit') ?? '20', 10)
    const skip = (page - 1) * limit

    const where: any = {}

    // Partners see only their own invoices
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      where.uploadedById = authUser.userId
    } else if (partnerId) {
      where.uploadedById = partnerId
    }

    if (dateFrom || dateTo) {
      where.invoiceDate = {}
      if (dateFrom) where.invoiceDate.gte = dateFrom
      if (dateTo) where.invoiceDate.lte = dateTo
    }
    if (skuCode) where.skuCode = skuCode

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          outlet: { select: { name: true, city: true } },
          sku: { select: { name: true, category: true } },
        },
        skip,
        take: limit,
        orderBy: { invoiceDate: 'desc' },
      }),
      prisma.invoice.count({ where }),
    ])

    return ok({
      invoices,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e: any) {
    console.error('[sales/invoices]', e)
    return err('Failed to fetch invoices', 500)
  }
}
