import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { uploadFile, generateKey, getSignedUrl } from '@/lib/s3'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'MIS_USER') return err('Forbidden', 403)

    const sp = req.nextUrl.searchParams
    const dateFrom = sp.get('dateFrom') ? new Date(sp.get('dateFrom')!) : new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
    const dateTo = sp.get('dateTo') ? new Date(sp.get('dateTo')!) : new Date()
    const format = sp.get('format') ?? 'json'
    const groupBy = sp.get('groupBy') ?? 'month' // month/week/day

    const invoices = await prisma.salesInvoice.findMany({
      where: {
        invoiceDate: { gte: dateFrom, lte: dateTo },
        isValid: true,
      },
      select: { invoiceDate: true, totalAmountPaise: true, outletId: true },
      orderBy: { invoiceDate: 'asc' },
    })

    // Group by period
    const grouped: Record<string, { period: string; totalSalesPaise: number; invoiceCount: number; totalSales: number }> = {}

    for (const inv of invoices) {
      const date = inv.invoiceDate
      let key: string
      if (groupBy === 'day') {
        key = date.toISOString().split('T')[0]
      } else if (groupBy === 'week') {
        const weekStart = new Date(date)
        weekStart.setDate(date.getDate() - date.getDay())
        key = weekStart.toISOString().split('T')[0]
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      }

      if (!grouped[key]) {
        grouped[key] = { period: key, totalSalesPaise: 0, invoiceCount: 0, totalSales: 0 }
      }
      grouped[key].totalSalesPaise += inv.totalAmountPaise
      grouped[key].invoiceCount++
    }

    const chartData = Object.values(grouped).map((g) => ({
      ...g,
      totalSales: g.totalSalesPaise / 100,
    }))

    if (format === 'xlsx') {
      const rows = chartData.map((d, i) => ({
        'S.No': i + 1,
        Period: d.period,
        'Total Sales (₹)': d.totalSales.toFixed(2),
        'Invoice Count': d.invoiceCount,
      }))
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.json_to_sheet(rows)
      XLSX.utils.book_append_sheet(wb, ws, 'Billing Trends')
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
      const key = generateKey('reports/billing', `billing-trends-${Date.now()}.xlsx`)
      await uploadFile(buffer, key, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const downloadUrl = await getSignedUrl(key, 3600)
      return ok({ downloadUrl, recordCount: chartData.length })
    }

    return ok({ chartData, recordCount: chartData.length, groupBy })
  } catch (e: any) {
    console.error('[reports/billing-trends]', e)
    return err('Failed to generate billing trends report', 500)
  }
}
