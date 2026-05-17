import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { uploadFile, generateKey } from '@/lib/s3'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp']
const GEO_RADIUS_METERS = 50 // duplicate detection radius

function haversineDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000 // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    // Sales users only
    const salesRoles = ['SALES_EXECUTIVE', 'TERRITORY_SALES_OFFICER', 'AREA_SALES_MANAGER', 'SALES_MANAGER']
    if (!salesRoles.includes(authUser.role)) {
      return err('Forbidden - Sales users only', 403)
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

    const imageBuffer = Buffer.from(await imageFile.arrayBuffer())

    // Compute image hash for duplicate detection
    const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex')

    let fraudReason: string | null = null
    let status = 'PENDING'

    // --- Duplicate Detection Check 1: Exact hash match ---
    const exactHashMatch = await prisma.visibilitySubmission.findFirst({
      where: { imageHash, status: { notIn: ['REJECTED'] } },
    })
    if (exactHashMatch) {
      fraudReason = 'Exact duplicate image detected'
    }

    // --- Duplicate Detection Check 2: Same outlet + same day ---
    if (!fraudReason && outletId && geoLat && geoLng) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const sameDaySubmission = await prisma.visibilitySubmission.findFirst({
        where: {
          outletId,
          programId,
          createdAt: { gte: today },
          submittedById: authUser.userId,
          status: { notIn: ['REJECTED'] },
        },
      })
      if (sameDaySubmission) {
        fraudReason = 'Duplicate submission for same outlet on same day'
      }
    }

    // --- Duplicate Detection Check 3: Geo proximity ---
    if (!fraudReason && geoLat && geoLng) {
      const nearbySubmissions = await prisma.visibilitySubmission.findMany({
        where: {
          geoLat: { gte: geoLat - 0.001, lte: geoLat + 0.001 },
          geoLng: { gte: geoLng - 0.001, lte: geoLng + 0.001 },
          submittedById: authUser.userId,
          createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) }, // within 10 min
          status: { notIn: ['REJECTED'] },
        },
      })

      for (const nearby of nearbySubmissions) {
        if (
          nearby.geoLat != null &&
          nearby.geoLng != null &&
          haversineDistanceMeters(geoLat, geoLng, nearby.geoLat, nearby.geoLng) < GEO_RADIUS_METERS
        ) {
          fraudReason = 'Submission too close to recent submission (geo duplicate)'
          break
        }
      }
    }

    // --- Duplicate Detection Check 4: User submission frequency ---
    if (!fraudReason) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      const recentCount = await prisma.visibilitySubmission.count({
        where: {
          submittedById: authUser.userId,
          createdAt: { gte: oneHourAgo },
        },
      })
      if (recentCount >= 10) {
        fraudReason = 'Submission rate limit exceeded (10 per hour)'
      }
    }

    // Auto-reject if fraud detected
    if (fraudReason) {
      await prisma.visibilityFraudLog.create({
        data: {
          userId: authUser.userId,
          outletId: outletId ?? null,
          programId,
          detectionMethod: fraudReason,
          imageHash,
          geoLat,
          geoLng,
        },
      })
      return err(`Submission rejected: ${fraudReason}`)
    }

    // Upload image to S3
    const s3Key = generateKey('visibility', imageFile.name)
    const imageUrl = await uploadFile(imageBuffer, s3Key, imageFile.type)

    // Save submission
    const submission = await prisma.visibilitySubmission.create({
      data: {
        submittedById: authUser.userId,
        outletId,
        programId,
        imageUrl,
        imageHash,
        geoLat,
        geoLng,
        notes: notes ?? null,
        status,
      },
    })

    return ok({ submissionId: submission.id, status }, 201)
  } catch (e: any) {
    console.error('[visibility/submit]', e)
    return err('Failed to submit visibility photo', 500)
  }
}
