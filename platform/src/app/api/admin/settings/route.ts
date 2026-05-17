import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const settingsSchema = z.object({
  holdingPeriodDays: z.number().int().min(0).optional(),
  conversionRate: z.number().positive().optional(),
  slaTargetHours: z.number().int().positive().optional(),
  maxOtpAttempts: z.number().int().positive().optional(),
  otpExpiryMinutes: z.number().int().positive().optional(),
  minRedemptionPoints: z.number().int().min(0).optional(),
  maxDailyVisibilitySubmissions: z.number().int().positive().optional(),
  tdsRate: z.number().min(0).max(1).optional(),
  tdsThresholdPaise: z.number().int().min(0).optional(),
  programName: z.string().optional(),
  supportEmail: z.string().email().optional(),
  supportPhone: z.string().optional(),
})

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') return err('Forbidden', 403)

    const settings = await prisma.programSettings.findFirst()

    if (!settings) {
      // Return defaults
      return ok({
        settings: {
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
        },
      })
    }

    return ok({ settings })
  } catch (e: any) {
    console.error('[admin/settings GET]', e)
    return err('Failed to fetch settings', 500)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const body = await req.json()
    const parsed = settingsSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.errors[0].message)

    const existing = await prisma.programSettings.findFirst()

    let settings
    if (existing) {
      settings = await prisma.programSettings.update({
        where: { id: existing.id },
        data: { ...parsed.data, updatedAt: new Date() },
      })
    } else {
      settings = await prisma.programSettings.create({ data: parsed.data })
    }

    await prisma.auditLog.create({
      data: {
        action: 'SETTINGS_UPDATED',
        entityType: 'PROGRAM_SETTINGS',
        entityId: settings.id,
        performedById: authUser.userId,
        metadata: parsed.data,
      },
    })

    return ok({ settings })
  } catch (e: any) {
    console.error('[admin/settings PUT]', e)
    return err('Failed to update settings', 500)
  }
}
