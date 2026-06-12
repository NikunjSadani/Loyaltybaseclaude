/**
 * POST /api/kyc/consent
 *
 * Verifies the outlet owner's consent OTP for a KYC submission.
 * The OTP is sent to the outlet owner's phone during the KYC form
 * submission and typed in by the sales agent on the owner's behalf.
 *
 * Body: { submissionId: string; mobile: string; otp: string }
 *
 * DEMO_MODE: accepts any 6-digit OTP (including 123456).
 * Production: verifies against the OTP store for the given mobile.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok  = (data: unknown) => NextResponse.json({ success: true, data })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

const schema = z.object({
  submissionId: z.string().min(1),
  mobile:       z.string().regex(/^\d{10}$/, 'Mobile must be 10 digits'),
  otp:          z.string().length(6, 'OTP must be 6 digits'),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const body   = await req.json()
    const parsed = schema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    const { submissionId, otp } = parsed.data

    // ── DEMO_MODE ────────────────────────────────────────────────────────────
    if (process.env.DEMO_MODE === 'true') {
      // In demo mode accept any well-formed 6-digit OTP
      if (!/^\d{6}$/.test(otp)) return err('Invalid OTP — must be 6 digits', 401)
      return ok({ verified: true, submissionId })
    }

    // ── Production: verify OTP from the OTP store ────────────────────────────
    const otpRecord = await prisma.otpCode.findFirst({
      where: {
        phone:       parsed.data.mobile,
        verifiedAt:  null,
        expiresAt:   { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!otpRecord) return err('OTP not found or expired', 401)
    if (otpRecord.attempts >= otpRecord.maxAttempts) {
      return err('OTP locked due to too many attempts. Request a new OTP.', 429)
    }
    if (otpRecord.code !== otp) {
      await prisma.otpCode.update({
        where: { id: otpRecord.id },
        data:  { attempts: { increment: 1 } },
      })
      const remaining = otpRecord.maxAttempts - otpRecord.attempts - 1
      return err(`Invalid OTP. ${remaining} attempt(s) remaining.`, 401)
    }

    // Mark OTP as verified
    await prisma.otpCode.update({
      where: { id: otpRecord.id },
      data:  { verifiedAt: new Date() },
    })

    // Verify the submission belongs to this user
    const submission = await prisma.kycSubmission.findFirst({
      where: { id: submissionId, userId: authUser.userId },
    })
    if (!submission) return err('KYC submission not found', 404)

    return ok({ verified: true, submissionId })
  } catch (e: any) {
    console.error('[kyc/consent POST]', e)
    return err('Failed to verify consent OTP', 500)
  }
}
