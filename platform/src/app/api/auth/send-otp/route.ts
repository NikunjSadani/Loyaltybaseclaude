import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { sendOtp } from '@/lib/notifications'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  mobile: z.string().regex(/^\d{10}$/, 'Mobile must be exactly 10 digits'),
  channel: z.enum(['SMS', 'WHATSAPP']),
})

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return err(parsed.error.errors[0].message)
    }
    const { mobile, channel } = parsed.data

    // Check if user exists
    const user = await prisma.user.findFirst({ where: { mobile } })

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000) // 6 hours

    // Store OTP in DB
    await prisma.otpCode.create({
      data: {
        mobile,
        otp,
        channel,
        expiresAt,
        used: false,
        attempts: 0,
        userId: user?.id ?? null,
      },
    })

    // Send OTP via notification service
    await sendOtp({ mobile, otp, channel })

    return ok({ message: 'OTP sent', channel })
  } catch (e: any) {
    console.error('[send-otp]', e)
    return err('Failed to send OTP', 500)
  }
}
