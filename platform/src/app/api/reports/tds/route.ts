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
    const dateFrom = sp.get('dateFrom') ? new Date(sp.get('dateFrom')!) : undefined
    const dateTo = sp.get('dateTo') ? new Date(sp.get('dateTo')!) : undefined
    const financialYear = sp.get('fy') ?? undefined
    const format = sp.get('format') ?? 'json'

    const where: any = {}
    if (financialYear) where.financialYear = financialYear
    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = dateFrom
      if (dateTo) where.createdAt.lte = dateTo
    }

    const records = await prisma.tdsRecord.findMany({
      where,
      include: {
        user: { select: { name: true, mobile: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    // PAN-level aggregation
    const panSummary: Record<string, { pan: string; name: string; grossPaise: number; tdsPaise: number; netPaise: number; count: number }> = {}
    for (const r of records) {
      const pan = r.pan ?? 'NO_PAN'
      if (!panSummary[pan]) {
        panSummary[pan] = {
          pan,
          name: r.user?.name ?? '',
          grossPaise: 0,
          tdsPaise: 0,
          netPaise: 0,
          count: 0,
        }
      }
      panSummary[pan].grossPaise += r.grossAmountPaise
      panSummary[pan].tdsPaise += r.tdsAmountPaise
      panSummary[pan].netPaise += r.netAmountPaise
      panSummary[pan].count++
    }

    const data = records.map((r, i) => ({
      'S.No': i + 1,
      'Name': r.user?.name ?? '',
      'Mobile': r.user?.mobile ?? '',
      PAN: r.pan ?? 'N/A',
      Section: r.section,
      'Financial Year': r.financialYear,
      'Gross Amount (₹)': (r.grossAmountPaise / 100).toFixed(2),
      'TDS Rate %': (r.tdsRate * 100).toFixed(1),
      'TDS Amount (₹)': (r.tdsAmountPaise / 100).toFixed(2),
      'Net Amount (₹)': (r.netAmountPaise / 100).toFixed(2),
      'Date': r.createdAt.toISOString().split('T')[0],
    }))

    const panData = Object.values(panSummary).map((p) => ({
      PAN: p.pan,
      Name: p.name,
      'Transaction Count': p.count,
      'Total Gross (₹)': (p.grossPaise / 100).toFixed(2),
      'Total TDS (₹)': (p.tdsPaise / 100).toFixed(2),
      'Total Net (₹)': (p.netPaise / 100).toFixed(2),
    }))

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'TDS Transactions')
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(panData), 'PAN Summary')
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
      const key = generateKey('reports/tds', `tds-report-${Date.now()}.xlsx`)
      await uploadFile(buffer, key, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const downloadUrl = await getSignedUrl(key, 3600)
      return ok({ downloadUrl, recordCount: data.length })
    }

    return ok({ data, panSummary: panData, recordCount: data.length })
  } catch (e: any) {
    console.error('[reports/tds]', e)
    return err('Failed to generate TDS report', 500)
  }
}
