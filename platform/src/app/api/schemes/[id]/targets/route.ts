import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    const { id: schemeId } = await params

    const scheme = await prisma.scheme.findFirst({
      where: { id: schemeId, clientId },
    })
    if (!scheme) return err('Scheme not found', 404)

    const target = await prisma.schemeTarget.findFirst({
      where: {
        schemeId,
        userId: authUser.userId,
      },
    })

    if (!target) {
      return ok({ target: null, message: 'No target assigned for this scheme' })
    }

    const percentage = target.targetValue > 0
      ? Math.min(100, Math.round((target.achievedValue / target.targetValue) * 100))
      : 0

    return ok({
      target: {
        ...target,
        percentage,
        schemeName: scheme.name,
        deadline: scheme.endDate,
        incentiveEarnable: calculateIncentive(scheme, target.achievedValue),
      },
    })
  } catch (e: any) {
    console.error('[schemes/[id]/targets]', e)
    return err('Failed to fetch targets', 500)
  }
}

function calculateIncentive(scheme: any, achieved: number): number {
  if (scheme.calculationMethod === 'FLAT') return scheme.targetValue ? scheme.targetValue : 0
  if (scheme.calculationMethod === 'PERCENTAGE') return Math.round((achieved * (scheme.ratePercent ?? 0)) / 100)
  return 0
}
