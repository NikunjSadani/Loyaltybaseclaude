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

    const schemes = await prisma.scheme.findMany({
      where: {
        deletedAt: null,
        ...(dateFrom && { startDate: { gte: dateFrom } }),
        ...(dateTo && { endDate: { lte: dateTo } }),
      },
      include: {
        _count: { select: { eligibility: true, pointsLedger: true } },
        targets: {
          select: { targetValuePaise: true, targetPoints: true },
        },
      },
    })

    const data = schemes.map((s, i) => {
      const totalTarget = s.targets.reduce((sum, t) => sum + (t.targetValuePaise ?? 0), 0)
      const achievementPct = 0 // Would need TargetAchievement join for accurate data

      return {
        'S.No': i + 1,
        'Scheme ID': s.id,
        'Scheme Name': s.name,
        'Scheme Type': s.schemeType,
        'Reward Type': s.rewardType,
        'Start Date': s.startDate.toISOString().split('T')[0],
        'End Date': s.endDate.toISOString().split('T')[0],
        'Eligible Partners': s._count.eligibility,
        'Total Target (paise)': totalTarget,
        'Achievement %': achievementPct,
        Status: s.status,
      }
    })

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.json_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, 'Scheme Performance')
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
      const key = generateKey('reports/schemes', `scheme-performance-${Date.now()}.xlsx`)
      await uploadFile(buffer, key, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const downloadUrl = await getSignedUrl(key, 3600)
      return ok({ downloadUrl, recordCount: data.length })
    }

    return ok({ data, recordCount: data.length })
  } catch (e: any) {
    console.error('[reports/scheme-performance]', e)
    return err('Failed to generate scheme performance report', 500)
  }
}
