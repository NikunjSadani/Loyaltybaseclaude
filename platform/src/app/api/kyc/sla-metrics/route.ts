import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getAuthUser } from '@/lib/auth'

const ok = (data: any, status = 200) => NextResponse.json({ success: true, data }, { status })
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status })

const SLA_TARGET_HOURS = parseInt(process.env.SLA_TARGET_HOURS ?? '48', 10)

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden - Gifsy Admin only', 403)

    const now = new Date()

    // Fetch all submissions with approval history
    const approved = await prisma.kycSubmission.findMany({
      where: { status: 'APPROVED' },
      include: {
        statusHistory: {
          where: { toStatus: 'APPROVED' },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    })

    const approvalTimes = approved
      .filter((s) => s.statusHistory.length > 0)
      .map((s) => {
        const approvedAt = s.statusHistory[0].createdAt
        return (approvedAt.getTime() - s.createdAt.getTime()) / (1000 * 60 * 60)
      })

    const avgApprovalTimeHours =
      approvalTimes.length > 0
        ? approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length
        : 0

    const slaBreachCount = approvalTimes.filter((t) => t > SLA_TARGET_HOURS).length
    const slaComplianceRate =
      approvalTimes.length > 0
        ? ((approvalTimes.length - slaBreachCount) / approvalTimes.length) * 100
        : 100

    // Pending aging buckets
    const pending = await prisma.kycSubmission.findMany({
      where: {
        status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'DRAFT'] },
      },
      select: { createdAt: true },
    })

    const pendingAging = {
      '0-24h': 0,
      '24-48h': 0,
      '48-72h': 0,
      '72h+': 0,
    }

    for (const p of pending) {
      const hours = (now.getTime() - p.createdAt.getTime()) / (1000 * 60 * 60)
      if (hours <= 24) pendingAging['0-24h']++
      else if (hours <= 48) pendingAging['24-48h']++
      else if (hours <= 72) pendingAging['48-72h']++
      else pendingAging['72h+']++
    }

    // Rejection by reason
    const rejectionHistory = await prisma.kycStatusHistory.findMany({
      where: { toStatus: 'REJECTED', notes: { not: null } },
      select: { notes: true },
    })

    const rejectionByReason: Record<string, number> = {}
    for (const r of rejectionHistory) {
      const reason = r.notes ?? 'Unknown'
      rejectionByReason[reason] = (rejectionByReason[reason] ?? 0) + 1
    }

    // Re-upload rate
    const reUploadCount = await prisma.kycSubmission.count({
      where: { status: 'RE_UPLOAD_REQUIRED' },
    })
    const totalCount = await prisma.kycSubmission.count()
    const reUploadRate = totalCount > 0 ? (reUploadCount / totalCount) * 100 : 0

    return ok({
      avgApprovalTimeHours: Math.round(avgApprovalTimeHours * 10) / 10,
      slaComplianceRate: Math.round(slaComplianceRate * 10) / 10,
      slaBreachCount,
      pendingAging,
      rejectionByReason,
      reUploadRate: Math.round(reUploadRate * 10) / 10,
    })
  } catch (e: any) {
    console.error('[kyc/sla-metrics]', e)
    return err('Failed to fetch SLA metrics', 500)
  }
}
