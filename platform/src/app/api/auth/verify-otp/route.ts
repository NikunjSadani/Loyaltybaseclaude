import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { generateToken } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

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
    const clientId = getClientIdFromRequest(req)

    // DEMO MODE: accept 000000 as a valid OTP for any number
    if (process.env.DEMO_MODE === 'true') {
      if (otp !== '000000') {
        return err('Invalid OTP. Use 000000 in demo mode.', 401)
      }
      const token = generateToken('demo-admin-id', 'GIFSY_ADMIN')
      return ok({
        token,
        user: { id: 'demo-admin-id', role: 'GIFSY_ADMIN', name: 'Demo Admin' },
      })
    }

    // Find latest valid OTP for phone, scoped to this tenant so an OTP from
    // another tenant cannot match (F4).
    const otpRecord = await prisma.otpCode.findFirst({
      where: {
        phone: mobile,
        verifiedAt: null,
        expiresAt: { gt: new Date() },
        user: { clientId },
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
    const user = await prisma.user.findFirst({ where: { phone: mobile, clientId } })
    if (!user) {
      return err('User not found', 404)
    }

    // Block inactive / pending accounts from logging in.
    // Channel partners are created with PENDING_VERIFICATION and only become
    // ACTIVE after the full KYC → Gifsy-approval cycle completes.
    // Admin roles (GIFSY_ADMIN, CLIENT_ADMIN) are always created as ACTIVE,
    // so this gate only affects partners in practice.
    if (user.status !== 'ACTIVE') {
      const statusMessages: Record<string, string> = {
        PENDING_VERIFICATION: 'Your account is pending KYC verification. Please complete your KYC to activate your account.',
        INACTIVE:   'Your account has been deactivated. Please contact your supervisor.',
        SUSPENDED:  'Your account has been suspended. Please contact support.',
      }
      const message = statusMessages[user.status] ?? 'Your account is not active. Please contact support.'
      return err(message, 403)
    }

    // Derive request metadata for LoginLog / AuditLog
    const rawForwardedFor = req.headers.get('x-forwarded-for')
    const ipAddress: string | null = rawForwardedFor
      ? rawForwardedFor.split(',')[0].trim()
      : (req.headers.get('x-real-ip') ?? null)
    const deviceInfo: string | null = req.headers.get('user-agent') ?? null

    // Write LoginLog, bump lastLoginAt/loginCount, and create AuditLog in one
    // atomic transaction.  This runs ONLY after status === 'ACTIVE' is confirmed
    // above; failed/locked OTPs and non-ACTIVE users never reach this point.
    await prisma.$transaction(async (tx) => {
      await tx.loginLog.create({
        data: { userId: user.id, ipAddress, deviceInfo },
      })
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), loginCount: { increment: 1 } },
      })
      await tx.auditLog.create({
        data: {
          action: 'LOGIN',
          entityType: 'USER',
          entityId: user.id,
          actorId: user.id,
          ipAddress,
          userAgent: deviceInfo,
        },
      })
    })

    // Generate JWT (F3 — use canonical generateToken; partnerId not set here
    // because the auth flow does not have it at login time).
    const token = generateToken(user.id, user.role)

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
