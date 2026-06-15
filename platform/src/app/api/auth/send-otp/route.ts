import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { generateOTP } from '@/lib/auth'
import { sendOtp } from '@/lib/msg91'
import { getClientIdFromRequest } from '@/lib/tenant'
import { CLIENT_REGISTRY } from '@/lib/platform/client-registry'

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
      return err(parsed.error.issues[0].message)
    }
    const { mobile, channel } = parsed.data
    const clientId = getClientIdFromRequest(req)

    // DEMO MODE: bypass DB and SMS — use OTP 000000 to log in
    if (process.env.DEMO_MODE === 'true') {
      return ok({ message: 'OTP sent (demo mode — use 000000)', channel })
    }

    // Fail-fast: resolve templateId BEFORE creating any DB rows.
    // If this tenant has no configured OTP templateId, return 503 immediately.
    // An empty templateId would cause MSG91 to silently fail while we'd return
    // a false 200 success — the silent-failure bug described in finding F7.
    const templateId = CLIENT_REGISTRY[clientId]?.notifications?.templateIds?.otpVerification ?? ''
    if (!templateId) {
      return err('OTP delivery is not configured for this tenant', 503)
    }

    // Check if user exists
    const user = await prisma.user.findFirst({ where: { phone: mobile, clientId } })

    // Generate 6-digit OTP
    const otp = generateOTP()
    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000) // 6 hours

    if (user) {
      await prisma.otpCode.create({
        data: {
          phone: mobile,
          code: otp,
          purpose: 'LOGIN',
          expiresAt,
          userId: user.id,
        },
      })
    } else {
      // Create a provisional user entry
      const provisionalUser = await prisma.user.create({
        data: {
          phone:    mobile,
          name:     mobile,
          role:     'SSS',
          status:   'PENDING_VERIFICATION',
          clientId,
        },
      })
      await prisma.otpCode.create({
        data: {
          phone: mobile,
          code: otp,
          purpose: 'REGISTRATION',
          expiresAt,
          userId: provisionalUser.id,
        },
      })
    }

    // Send OTP via MSG91 (canonical provider — F2).
    // templateId was resolved above (fail-fast guard already ensured it is non-empty).
    // Capture the result: if delivery fails, surface the error rather than silently
    // returning success (F7 fix).
    // Known limitation: the OTP/user rows were already created before this call.
    // A full transactional reorder is deferred; the key correctness goal is that
    // callers never receive a 200 when delivery did not happen.
    const result = await sendOtp({ phone: mobile, templateId })
    if (!result.success) {
      return err('Failed to send OTP', 502)
    }

    return ok({ message: 'OTP sent', channel })
  } catch (e: any) {
    console.error('[send-otp]', e)
    return err('Failed to send OTP', 500)
  }
}
