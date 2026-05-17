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
    const dateFrom = sp.get('dateFrom') ? new Date(sp.get('dateFrom')!) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const dateTo = sp.get('dateTo') ? new Date(sp.get('dateTo')!) : new Date()
    const format = sp.get('format') ?? 'json'

    // Login activity
    const loginLogs = await prisma.loginLog.findMany({
      where: { createdAt: { gte: dateFrom, lte: dateTo } },
      include: {
        user: { select: { id: true, name: true, mobile: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Active users (logged in at least once)
    const activeUsers = new Set(loginLogs.map((l) => l.userId))

    // Total registered users
    const totalUsers = await prisma.user.count({ where: { status: 'ACTIVE' } })

    // Daily active users
    const dailyActivity: Record<string, Set<string>> = {}
    for (const log of loginLogs) {
      const day = log.createdAt.toISOString().split('T')[0]
      if (!dailyActivity[day]) dailyActivity[day] = new Set()
      dailyActivity[day].add(log.userId)
    }

    const dailyStats = Object.entries(dailyActivity).map(([date, users]) => ({
      date,
      activeUsers: users.size,
    })).sort((a, b) => a.date.localeCompare(b.date))

    const data = loginLogs.map((l, i) => ({
      'S.No': i + 1,
      'User Name': l.user?.name ?? '',
      Mobile: l.user?.mobile ?? '',
      Role: l.user?.role ?? '',
      'Login Time': l.createdAt.toISOString(),
      'IP Address': l.ipAddress ?? '',
      'Device': l.deviceInfo ?? '',
    }))

    const summary = {
      totalActiveUsers: activeUsers.size,
      totalRegisteredUsers: totalUsers,
      engagementRate: totalUsers > 0 ? Math.round((activeUsers.size / totalUsers) * 100) : 0,
      totalLogins: loginLogs.length,
      dailyStats,
      dateFrom: dateFrom.toISOString().split('T')[0],
      dateTo: dateTo.toISOString().split('T')[0],
    }

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Login Activity')
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dailyStats), 'Daily Stats')
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
      const key = generateKey('reports/engagement', `engagement-${Date.now()}.xlsx`)
      await uploadFile(buffer, key, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const downloadUrl = await getSignedUrl(key, 3600)
      return ok({ downloadUrl, recordCount: data.length, summary })
    }

    return ok({ data, summary, recordCount: data.length })
  } catch (e: any) {
    console.error('[reports/engagement]', e)
    return err('Failed to generate engagement report', 500)
  }
}
