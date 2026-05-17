import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const DEFAULTS: Record<string, any> = {
  holdingPeriodDays: 30,
  conversionRate: 1,
  slaTargetHours: 48,
  maxOtpAttempts: 3,
  otpExpiryMinutes: 10,
  minRedemptionPoints: 100,
  maxDailyVisibilitySubmissions: 10,
  tdsRate: 0.1,
  tdsThresholdPaise: 2000000,
  programName: 'Loyalty Program',
  supportEmail: 'support@platform.com',
  supportPhone: '1800-XXX-XXXX',
}

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const rows = await prisma.programSetting.findMany()

    // Build settings object from key-value rows
    const settings: Record<string, any> = { ...DEFAULTS }
    for (const row of rows) {
      settings[row.settingKey] = row.settingValue
    }

    return ok({ settings })
  } catch (e: any) {
    console.error('[admin/settings GET]', e)
    return err('Failed to fetch settings', 500)
  }
}

const settingsSchema = z.object({
  key: z.string().min(1),
  value: z.any(),
  category: z.string().optional(),
  description: z.string().optional(),
})

export async function PUT(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const body = await req.json()
    const parsed = settingsSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { key, value, category, description } = parsed.data

    const setting = await prisma.programSetting.upsert({
      where: { settingKey: key },
      update: { settingValue: value, updatedById: authUser.userId },
      create: { settingKey: key, settingValue: value, category, description, updatedById: authUser.userId },
    })

    await prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'PROGRAM_SETTINGS',
        entityId: setting.id,
        actorId: authUser.userId,
        metadata: { key, value },
      },
    })

    return ok({ setting })
  } catch (e: any) {
    console.error('[admin/settings PUT]', e)
    return err('Failed to update settings', 500)
  }
}
