import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'
import { initialKycStatus } from '@/lib/kyc-approval'
import { ROLE_PHONES } from '@/lib/sales-role'
import { getClientIdFromRequest } from '@/lib/tenant'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

// ─── Geo capture sub-schema ───────────────────────────────────────────────────

const geoSchema = z.object({
  lat:      z.number(),
  lng:      z.number(),
  accuracy: z.number(),
  ts:       z.string(),
})

// ─── Document sub-schema ─────────────────────────────────────────────────────
// In DEMO_MODE the dataUrl is stored as-is in KycDocument.fileUrl.
// In production the caller should upload files to GCS first and pass the
// resulting GCS URL as fileUrl instead of a base64 dataUrl.

const docSchema = z.object({
  type:     z.string(),             // KycDocumentType enum value
  dataUrl:  z.string().optional(),  // base64 data URL (demo) or GCS URL (prod)
  fileName: z.string().optional(),
})

// ─── Full KYC submission schema ───────────────────────────────────────────────

const kycSchema = z.object({
  // Partner / outlet owner identity
  partnerName:       z.string().min(2),
  mobile:            z.string().regex(/^[6-9]\d{9}$/, 'Invalid mobile number'),
  partnerClass:      z.string().default('SSS'),
  gstNumber:         z.string().optional(),
  panNumber:         z.string().optional(),
  // Address
  address:           z.string().min(5),
  city:              z.string().min(2),
  state:             z.string().min(2),
  pincode:           z.string().regex(/^\d{6}$/, 'Invalid pincode'),
  // Bank / UPI
  paymentMode:       z.enum(['bank', 'upi']).optional(),
  bankName:          z.string().optional(),
  accountNumber:     z.string().optional(),
  accountHolderName: z.string().optional(),
  ifscCode:          z.string().optional(),
  upiId:             z.string().optional(),
  // Geo captures
  boardPhotoGeo:     geoSchema.optional(),
  paymentGeo:        geoSchema.optional(),
  // Documents (including signature)
  documents:         z.array(docSchema).optional(),
  signatureDataUrl:  z.string().optional(),
  // Consent
  agreedToTerms:     z.boolean().optional(),
  agreedToComms:     z.boolean().optional(),
  // Legacy / admin fields
  reviewerNotes:     z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const body   = await req.json()
    const parsed = kycSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.issues[0].message)
    const data = parsed.data

    // ── DEMO_MODE ────────────────────────────────────────────────────────────
    if (process.env.DEMO_MODE === 'true') {
      const demoId = `kyc-demo-${Date.now()}`
      return ok({
        submissionId:  demoId,
        status:        'PENDING_SO_APPROVAL',
        escalatedFrom: null,
        message:       'KYC submission created (demo mode)',
      }, 201)
    }

    // ── Production flow ──────────────────────────────────────────────────────

    // 1. Find channel partner for this user
    let partner = await prisma.channelPartner.findFirst({
      where: { userId: authUser.userId },
    })

    // 2. Update ChannelPartner with submitted details (bank + identity)
    if (partner) {
      partner = await prisma.channelPartner.update({
        where: { id: partner.id },
        // Cast to any: new bank fields added to schema but Prisma client
        // not yet regenerated. Run `prisma generate` after deploying schema.
        data: {
          businessName:       data.partnerName,
          phone:              data.mobile,
          gstNumber:          data.gstNumber          ?? undefined,
          panNumber:          data.panNumber           ?? undefined,
          bankName:           data.bankName            ?? undefined,
          bankAccountNumber:  data.accountNumber       ?? undefined,
          bankAccountHolder:  data.accountHolderName   ?? undefined,
          ifscCode:           data.ifscCode            ?? undefined,
          upiId:              data.upiId               ?? undefined,
          paymentMode:        data.paymentMode         ?? undefined,
        } as any,
      })
    }

    // 3. Block duplicate in-flight submissions
    const existing = await prisma.kycSubmission.findFirst({
      where: {
        userId: authUser.userId,
        status: { in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW',
                        'PENDING_SO_APPROVAL', 'PENDING_ASM_APPROVAL',
                        'PENDING_RSM_APPROVAL', 'PENDING_GIFSY'] },
      },
    })
    if (existing) return err('You already have a pending KYC submission')

    // 4. Escalation routing (preserved from original)
    const status        = initialKycStatus(authUser.role, ROLE_PHONES)
    const escalatedFrom = detectEscalation(authUser.role, status)

    // 5. Create KycSubmission with all geo + notes
    const submission = await prisma.kycSubmission.create({
      data: {
        userId:        authUser.userId,
        partnerId:     partner?.id ?? null,
        status:        status as any,
        escalatedFrom: escalatedFrom ?? null,
        reviewerNotes: data.reviewerNotes ?? null,
        submittedAt:   new Date(),

        // Geo capture #1 (board photo)
        boardPhotoLat:         data.boardPhotoGeo?.lat      ?? null,
        boardPhotoLng:         data.boardPhotoGeo?.lng      ?? null,
        boardPhotoGeoAccuracy: data.boardPhotoGeo?.accuracy ?? null,
        boardPhotoGeoAt:       data.boardPhotoGeo?.ts ? new Date(data.boardPhotoGeo.ts) : null,

        // Geo capture #2 (payment)
        paymentLat:            data.paymentGeo?.lat      ?? null,
        paymentLng:            data.paymentGeo?.lng      ?? null,
        paymentGeoAccuracy:    data.paymentGeo?.accuracy ?? null,
        paymentGeoAt:          data.paymentGeo?.ts ? new Date(data.paymentGeo.ts) : null,
      },
    })

    // 6. Log initial status history
    await prisma.kycStatusHistory.create({
      data: {
        kycSubmissionId: submission.id,
        toStatus:        status as any,
        changedByUserId: authUser.userId,
        notes:           escalatedFrom
          ? `Escalated — ${escalatedFrom} has resigned`
          : 'Submitted for review',
      },
    })

    // 7. Create KycDocument records for each submitted document
    const docPromises: Promise<unknown>[] = []

    if (data.documents?.length) {
      for (const doc of data.documents) {
        if (!doc.type) continue
        // In production: doc.dataUrl would be a GCS URL after file upload.
        // In demo: store the dataUrl directly as a placeholder reference.
        const fileUrl = doc.dataUrl ?? `pending://kyc/${submission.id}/${doc.type}`
        // fileKey: GCS storage key (use placeholder until GCS is wired)
        const fileKey = `kyc/${submission.id}/${doc.type}/${Date.now()}`
        docPromises.push(
          prisma.kycDocument.create({
            data: {
              kycSubmissionId: submission.id,
              documentType:    doc.type as any,
              fileUrl,
              fileKey,
              fileName:        doc.fileName ?? null,
              status:          'SUBMITTED' as any,
            },
          }),
        )
      }
    }

    // 8. Signature document — store the base64 PNG so it can be shown in the
    //    outlet master as a document link or embedded image.
    if (data.signatureDataUrl) {
      docPromises.push(
        prisma.kycDocument.create({
          data: {
            kycSubmissionId: submission.id,
            documentType:    'SIGNATURE' as any,
            fileUrl:         data.signatureDataUrl,
            fileKey:         `kyc/${submission.id}/SIGNATURE/${Date.now()}`,
            fileName:        'signature.png',
            mimeType:        'image/png',
            status:          'SUBMITTED' as any,
          },
        }),
      )
    }

    await Promise.all(docPromises)

    return ok({ submissionId: submission.id, status, escalatedFrom }, 201)
  } catch (e: any) {
    console.error('[kyc POST]', e)
    return err('Failed to create KYC submission', 500)
  }
}

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)

    const sp     = req.nextUrl.searchParams
    const status = sp.get('status') ?? undefined
    const page   = parseInt(sp.get('page')  ?? '1',  10)
    const limit  = parseInt(sp.get('limit') ?? '20', 10)
    const skip   = (page - 1) * limit

    const clientId = getClientIdFromRequest(req)

    const where: any = { user: { clientId } }

    if (authUser.role === 'SALES_SO') {
      where.status = 'PENDING_SO_APPROVAL'
    } else if (authUser.role === 'SALES_ASM') {
      where.status = 'PENDING_ASM_APPROVAL'
    } else if (authUser.role === 'SALES_STATE_HEAD') {
      where.status = 'PENDING_RSM_APPROVAL'
    } else if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      where.userId = authUser.userId
    }

    if (status && (authUser.role === 'GIFSY_ADMIN' || authUser.role === 'CLIENT_ADMIN')) {
      where.status = status
    }

    const [submissions, total] = await Promise.all([
      prisma.kycSubmission.findMany({
        where,
        include: {
          user:      { select: { id: true, name: true, phone: true } },
          partner:   { select: { id: true, businessName: true } },
          documents: { select: { id: true, documentType: true, status: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.kycSubmission.count({ where }),
    ])

    const statusCounts = await prisma.kycSubmission.groupBy({
      by: ['status'],
      where: (authUser.role === 'GIFSY_ADMIN' || authUser.role === 'CLIENT_ADMIN')
        ? { user: { clientId } }
        : { userId: authUser.userId, user: { clientId } },
      _count: { status: true },
    })

    return ok({
      submissions,
      pagination:   { page, limit, total, pages: Math.ceil(total / limit) },
      statusCounts: statusCounts.reduce((acc: any, s) => {
        acc[s.status] = s._count.status
        return acc
      }, {}),
    })
  } catch (e: any) {
    console.error('[kyc GET]', e)
    return err('Failed to fetch KYC submissions', 500)
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function detectEscalation(backendRole: string, resolvedStatus: string): string | null {
  const SKIPPED_ROLE: Record<string, string> = {
    'SALES_ISR:PENDING_ASM_APPROVAL': 'SO',
    'SALES_ISR:PENDING_RSM_APPROVAL': 'SO',
    'SALES_SO:PENDING_RSM_APPROVAL':  'ASM',
  }
  const key = `${backendRole}:${resolvedStatus}`
  return SKIPPED_ROLE[key] ?? null
}
