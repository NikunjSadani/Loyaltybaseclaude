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
    const format = sp.get('format') ?? 'json'

    const where: any = {}
    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = dateFrom
      if (dateTo) where.createdAt.lte = dateTo
    }

    const submissions = await prisma.visibilitySubmission.findMany({
      where,
      include: {
        submittedBy: { select: { name: true, mobile: true } },
        outlet: { select: { name: true, city: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    const data = submissions.map((s, i) => ({
      'S.No': i + 1,
      'Submission ID': s.id,
      'Submitted By': s.submittedBy?.name ?? '',
      Mobile: s.submittedBy?.mobile ?? '',
      'Outlet Name': s.outlet?.name ?? '',
      City: s.outlet?.city ?? '',
      'Program ID': s.programId,
      Status: s.status,
      'Geo Lat': s.geoLat ?? '',
      'Geo Lng': s.geoLng ?? '',
      'Submitted On': s.createdAt.toISOString().split('T')[0],
    }))

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.json_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, 'Visibility Status')
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
      const key = generateKey('reports/visibility', `visibility-status-${Date.now()}.xlsx`)
      await uploadFile(buffer, key, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const downloadUrl = await getSignedUrl(key, 3600)
      return ok({ downloadUrl, recordCount: data.length })
    }

    return ok({ data, recordCount: data.length })
  } catch (e: any) {
    console.error('[reports/visibility-status]', e)
    return err('Failed to generate visibility status report', 500)
  }
}
