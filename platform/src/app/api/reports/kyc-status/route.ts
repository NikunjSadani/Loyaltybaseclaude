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

    const where: any = { user: { clientId } }
    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = dateFrom
      if (dateTo) where.createdAt.lte = dateTo
    }

    const submissions = await prisma.kycSubmission.findMany({
      where,
      include: {
        user: { select: { name: true, phone: true } },
        partner: { select: { businessName: true, panNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    const data = submissions.map((s, i) => ({
      'S.No': i + 1,
      'Submission ID': s.id,
      'User Name': s.user?.name ?? '',
      Mobile: s.user?.phone ?? '',
      'Business Name': s.partner?.businessName ?? '',
      Status: s.status,
      'Submitted On': s.createdAt.toISOString().split('T')[0],
      PAN: s.partner?.panNumber ?? '',
    }))

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.json_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, 'KYC Status')
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
      const key = generateKey('reports/kyc', `kyc-status-${Date.now()}.xlsx`)
      await uploadFile(buffer, key, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const downloadUrl = await getSignedUrl(key, 3600)
      return ok({ downloadUrl, recordCount: data.length })
    }

    return ok({ data, recordCount: data.length })
  } catch (e: any) {
    console.error('[reports/kyc-status]', e)
    return err('Failed to generate KYC status report', 500)
  }
}
