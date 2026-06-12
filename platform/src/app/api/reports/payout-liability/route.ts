import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { uploadFile, generateKey, getSignedUrl } from '@/lib/s3'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'MIS_USER') return err('Forbidden', 403)
    const clientId = getClientIdFromRequest(req)

    const sp = req.nextUrl.searchParams
    const dateFrom = sp.get('dateFrom') ? new Date(sp.get('dateFrom')!) : undefined
    const dateTo = sp.get('dateTo') ? new Date(sp.get('dateTo')!) : undefined
    const format = sp.get('format') ?? 'json'

    const where: any = { status: 'PENDING', batch: { clientId } }
    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = dateFrom
      if (dateTo) where.createdAt.lte = dateTo
    }

    const transactions = await prisma.payoutTransaction.findMany({
      where,
      include: {
        partner: { select: { businessName: true } },
        batch: { select: { batchCode: true } },
      },
      orderBy: { amountPaise: 'desc' },
    })

    const totalLiabilityPaise = transactions.reduce((sum, t) => sum + t.amountPaise, 0)

    const data = transactions.map((t, i) => ({
      'S.No': i + 1,
      'Partner Name': t.partner?.businessName ?? '',
      'Batch Code': t.batch?.batchCode ?? '',
      'Amount (₹)': (t.amountPaise / 100).toFixed(2),
      Mode: t.payoutMode,
      Status: t.status,
      'Created On': t.createdAt.toISOString().split('T')[0],
    }))

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.json_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, 'Payout Liability')
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
      const key = generateKey('reports/payouts', `payout-liability-${Date.now()}.xlsx`)
      await uploadFile(buffer, key, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const downloadUrl = await getSignedUrl(key, 3600)
      return ok({ downloadUrl, recordCount: data.length, totalLiability: totalLiabilityPaise / 100 })
    }

    return ok({ data, recordCount: data.length, totalLiability: totalLiabilityPaise / 100 })
  } catch (e: any) {
    console.error('[reports/payout-liability]', e)
    return err('Failed to generate payout liability report', 500)
  }
}
