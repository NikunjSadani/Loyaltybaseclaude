import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { getClientIdFromRequest } from '@/lib/tenant'
import { uploadFile, generateKey } from '@/lib/s3'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp']

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    const clientId = getClientIdFromRequest(req)

    // Sales/partner users only
    const allowedRoles = ['CHANNEL_PARTNER', 'SALES_EXECUTIVE', 'TERRITORY_SALES_OFFICER', 'AREA_SALES_MANAGER', 'SALES_MANAGER']
    if (!allowedRoles.includes(authUser.role)) {
      return err('Forbidden - Sales or partner users only', 403)
    }

    const formData = await req.formData()
    const imageFile = formData.get('image') as File | null
    const outletId = formData.get('outletId') as string | null
    const programId = formData.get('programId') as string | null
    const geoLat = formData.get('geoLat') ? parseFloat(formData.get('geoLat') as string) : null
    const geoLng = formData.get('geoLng') ? parseFloat(formData.get('geoLng') as string) : null
    const notes = formData.get('notes') as string | null

    if (!imageFile) return err('Image file is required')
    if (!outletId) return err('outletId is required')
    if (!programId) return err('programId is required')
    if (!ALLOWED_MIME.includes(imageFile.type)) {
      return err('Invalid image format. Allowed: JPEG, PNG, WEBP')
    }

    // Verify the visibility program belongs to this client
    const program = await prisma.visibilityProgram.findFirst({ where: { id: programId, clientId } })
    if (!program) return err('Visibility program not found', 404)

    const imageBuffer = Buffer.from(await imageFile.arrayBuffer())

    // Upload image to S3
    const s3Key = generateKey('visibility', imageFile.name)
    const imageUrl = await uploadFile(imageBuffer, s3Key, imageFile.type)

    // Save submission using actual schema fields
    const submission = await prisma.visibilitySubmission.create({
      data: {
        programId,
        partnerId: authUser.userId,
        outletId,
        imageUrls: [imageUrl],
        latitude: geoLat,
        longitude: geoLng,
        status: 'DRAFT',
      },
    })

    return ok({ submissionId: submission.id, status: submission.status }, 201)
  } catch (e: any) {
    console.error('[visibility/submit]', e)
    return err('Failed to submit visibility photo', 500)
  }
}
