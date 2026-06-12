import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED']).optional(),
  endDate: z.string().transform((s) => new Date(s)).optional(),
  rules: z.record(z.string(), z.any()).optional(),
  eligibility: z.record(z.string(), z.any()).optional(),
})

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    const { id } = await params

    const scheme = await prisma.scheme.findFirst({
      where: { id, clientId },
      include: { rules: true, eligibility: true },
    })

    if (scheme && scheme.deletedAt !== null) return err('Scheme not found', 404)

    if (!scheme) return err('Scheme not found', 404)

    return ok({ scheme })
  } catch (e: any) {
    console.error('[schemes/[id] GET]', e)
    return err('Failed to fetch scheme', 500)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden - Admin only', 403)
    }
    const clientId = getClientIdFromRequest(req)

    const { id } = await params
    const body = await req.json()
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)

    // Verify ownership before update
    const existingScheme = await prisma.scheme.findFirst({ where: { id, clientId } })
    if (!existingScheme) return err('Scheme not found', 404)

    const scheme = await prisma.scheme.update({
      where: { id },
      data: { ...parsed.data, updatedAt: new Date() },
    })

    return ok({ scheme })
  } catch (e: any) {
    console.error('[schemes/[id] PATCH]', e)
    return err('Failed to update scheme', 500)
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)
    const clientId = getClientIdFromRequest(req)

    const { id } = await params

    // Verify ownership before delete
    const existingScheme = await prisma.scheme.findFirst({ where: { id, clientId } })
    if (!existingScheme) return err('Scheme not found', 404)

    await prisma.scheme.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'CANCELLED', updatedAt: new Date() },
    })

    return ok({ message: 'Scheme deleted successfully' })
  } catch (e: any) {
    console.error('[schemes/[id] DELETE]', e)
    return err('Failed to delete scheme', 500)
  }
}
