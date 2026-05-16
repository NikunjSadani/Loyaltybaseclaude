import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      include: {
        partner: {
          include: {
            outlets: true,
            wallet: true,
          },
        },
        salesProfile: true,
      },
    })

    if (!user) return err('User not found', 404)

    return ok({ user })
  } catch (e: any) {
    console.error('[auth/me]', e)
    return err('Failed to fetch user profile', 500)
  }
}
