import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { signToken } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const schema = z.object({
  mobile: z.string().regex(/^\d{10}$/, 'Mobile must be exactly 10 digits'),
  otp: z.string().length(6, 'OTP must be 6 digits'),
})

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return err(parsed.error.issues[0].message)
    }
    const { mobile, otp } = parsed.data

    // Find latest valid OTP for phone
    const otpRecord = await prisma.otpCode.findFirst({
      where: {
        phone: mobile,
        verifiedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!otpRecord) {
      return err('OTP not found or expired', 401)
    }

    // Check if locked (too many attempts)
    if (otpRecord.attempts >= otpRecord.maxAttempts) {
      return err('OTP locked due to too many attempts. Please request a new OTP.', 429)
    }

    // Verify OTP
    if (otpRecord.code !== otp) {
      // Increment attempts
      await prisma.otpCode.update({
        where: { id: otpRecord.id },
        data: { attempts: { increment: 1 } },
      })
      const remaining = otpRecord.maxAttempts - otpRecord.attempts - 1
      if (remaining <= 0) {
        return err('OTP locked due to too many attempts. Please request a new OTP.', 429)
      }
      return err(`Invalid OTP. ${remaining} attempt(s) remaining.`, 401)
    }

    // Mark OTP as verified
    await prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { verifiedAt: new Date() },
    })

    // Find user
    const user = await prisma.user.findFirst({ where: { phone: mobile } })
    if (!user) {
      return err('User not found', 404)
    }

    // Generate JWT
    const token = signToken({
      userId: user.id,
      role: user.role,
      mobile: user.phone,
    })

    return ok({
      token,
      user: {
        id: user.id,
        role: user.role,
        name: user.name ?? null,
      },
    })
  } catch (e: any) {
    console.error('[verify-otp]', e)
    return err('Failed to verify OTP', 500)
  }
}
