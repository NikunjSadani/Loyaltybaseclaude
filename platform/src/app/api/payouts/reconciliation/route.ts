import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { uploadFile, generateKey } from '@/lib/s3'
import { getSignedUrl } from '@/lib/s3'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'MIS_USER') {
      return err('Forbidden', 403)
    }

    const sp = req.nextUrl.searchParams
    const period = sp.get('period') ?? undefined
    const batchId = sp.get('batchId') ?? undefined

    const where: any = {}
    if (batchId) where.batchId = batchId
    if (period) where.batch = { period }

    const transactions = await prisma.payoutTransaction.findMany({
      where,
      include: {
        user: { select: { name: true, mobile: true } },
        batch: { select: { period: true } },
        tdsRecord: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    // Build Excel workbook
    const rows = transactions.map((t, i) => ({
      'S.No': i + 1,
      Period: t.batch?.period ?? '',
      'User Name': t.user?.name ?? '',
      Mobile: t.user?.mobile ?? '',
      'Gross Amount (₹)': (t.amountPaise / 100).toFixed(2),
      'TDS Amount (₹)': t.tdsRecord ? (t.tdsRecord.tdsAmountPaise / 100).toFixed(2) : '0.00',
      'Net Amount (₹)': t.tdsRecord
        ? (t.tdsRecord.netAmountPaise / 100).toFixed(2)
        : (t.amountPaise / 100).toFixed(2),
      'TDS Section': t.tdsRecord?.section ?? 'N/A',
      PAN: t.tdsRecord?.pan ?? 'N/A',
      Mode: t.mode,
      Status: t.status,
      'Invoice Number': t.invoiceNumber ?? '',
      Date: t.createdAt.toISOString().split('T')[0],
    }))

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, 'Reconciliation')

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const key = generateKey('reports/reconciliation', `reconciliation-${period ?? Date.now()}.xlsx`)
    await uploadFile(buffer, key, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const downloadUrl = await getSignedUrl(key, 3600)

    return ok({ downloadUrl, recordCount: rows.length })
  } catch (e: any) {
    console.error('[payouts/reconciliation]', e)
    return err('Failed to generate reconciliation report', 500)
  }
}
