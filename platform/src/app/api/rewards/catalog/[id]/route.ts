import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const { id } = await params

    const item = await prisma.rewardCatalog.findUnique({
      where: { id, isDeleted: false },
    })

    if (!item) return err('Reward item not found', 404)

    return ok({ item })
  } catch (e: any) {
    console.error('[rewards/catalog/[id]]', e)
    return err('Failed to fetch reward item', 500)
  }
}
