/**
 * GET /api/admin/reports/ticket-aging
 *
 * Ticket Aging report — open/unresolved tickets aged into buckets with SLA flags.
 *
 * Query params:
 *   status    CSV of TicketStatus values (default: OPEN,IN_PROGRESS,PENDING_USER,ESCALATED)
 *   category  One TicketCategory value (optional)
 *   priority  One TicketPriority value (optional)
 *   format    json|xlsx (default: json)
 *
 * In DEMO_MODE: returns fully-populated demo rows (10 tickets, all buckets).
 * In production: clientId-scoped query against the Ticket model.
 *
 * Admin-only (GIFSY_ADMIN | CLIENT_ADMIN).
 *
 * Spec: docs/plans/REPORTING-REVAMP.md § R2
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser }               from '@/lib/auth'
import { requirePermission }         from '@/lib/rbac/require-permission'
import {
  buildTicketAgingRow,
  demoTicketAgingRows,
  generateTicketAgingExcel,
  summarizeAging,
}                                    from '@/lib/ticket-aging-export'
import { prisma }                    from '@/lib/prisma'
import { TicketStatus, TicketCategory, TicketPriority } from '@prisma/client'
import type { TicketAgingRow }       from '@/types'

// ─── Allowed enum value sets (mirrors Prisma schema enums) ────────────────────

const ALLOWED_STATUSES = new Set([
  'OPEN', 'IN_PROGRESS', 'PENDING_USER', 'RESOLVED', 'CLOSED', 'ESCALATED',
])

const DEFAULT_STATUSES = ['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'ESCALATED']

const ALLOWED_CATEGORIES = new Set([
  'KYC', 'POINTS', 'REDEMPTION', 'PAYOUT', 'SCHEME', 'TECHNICAL', 'ACCOUNT', 'OTHER',
])

const ALLOWED_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN'])

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const authUser = await getAuthUser(req)
  if (!authUser)                       return NextResponse.json({ success: false, error: 'Unauthorized' },  { status: 401 })
  if (!ADMIN_ROLES.has(authUser.role)) return NextResponse.json({ success: false, error: 'Forbidden' },     { status: 403 })

  const denied = await requirePermission(authUser as { role: string; clientId: string }, 'reports:export')
  if (denied) return denied

  // ── Hard tenant guard ──────────────────────────────────────────────────────
  // Never let an empty clientId fall through to Prisma where
  // `{ clientId: undefined }` would silently drop the filter.
  const clientId = (authUser as { clientId?: string }).clientId
  if (!clientId) {
    return NextResponse.json(
      { success: false, error: 'No tenant bound to the session.' },
      { status: 400 },
    )
  }

  // ── Parse & validate params ────────────────────────────────────────────────
  const { searchParams } = req.nextUrl
  const statusParam   = searchParams.get('status')   // CSV or single value
  const categoryParam = searchParams.get('category')
  const priorityParam = searchParams.get('priority')
  const format        = searchParams.get('format') ?? 'json'

  // Parse statuses: param absent → default open set; param present-but-empty → explicit 400
  // (never silently substitute the default for an empty selection; keeps demo/prod consistent).
  let statuses: string[]
  if (statusParam === null) {
    statuses = DEFAULT_STATUSES
  } else {
    statuses = statusParam.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Provide at least one status, or omit the status filter.' },
        { status: 400 },
      )
    }
  }

  for (const s of statuses) {
    if (!ALLOWED_STATUSES.has(s)) {
      return NextResponse.json(
        { success: false, error: `Invalid status value: "${s}". Allowed: ${[...ALLOWED_STATUSES].join(', ')}.` },
        { status: 400 },
      )
    }
  }

  if (categoryParam && !ALLOWED_CATEGORIES.has(categoryParam)) {
    return NextResponse.json(
      { success: false, error: `Invalid category: "${categoryParam}". Allowed: ${[...ALLOWED_CATEGORIES].join(', ')}.` },
      { status: 400 },
    )
  }

  if (priorityParam && !ALLOWED_PRIORITIES.has(priorityParam)) {
    return NextResponse.json(
      { success: false, error: `Invalid priority: "${priorityParam}". Allowed: ${[...ALLOWED_PRIORITIES].join(', ')}.` },
      { status: 400 },
    )
  }

  const asOf = new Date()

  // ── DEMO_MODE ──────────────────────────────────────────────────────────────
  if (process.env.DEMO_MODE === 'true') {
    let rows = demoTicketAgingRows(asOf)

    // Apply the same filters in memory for a consistent demo experience
    if (statuses.length > 0) {
      rows = rows.filter(r => statuses.includes(r.status))
    }
    if (categoryParam) {
      rows = rows.filter(r => r.category === categoryParam)
    }
    if (priorityParam) {
      rows = rows.filter(r => r.priority === priorityParam)
    }

    return buildResponse(rows, asOf, format)
  }

  // ── Production ─────────────────────────────────────────────────────────────
  const tickets = await prisma.ticket.findMany({
    where: {
      clientId,
      deletedAt: null,
      status: { in: statuses as TicketStatus[] },
      ...(categoryParam ? { category: categoryParam as TicketCategory } : {}),
      ...(priorityParam ? { priority: priorityParam as TicketPriority } : {}),
    },
    select: {
      ticketNumber:    true,
      subject:         true,
      category:        true,
      priority:        true,
      status:          true,
      createdAt:       true,
      updatedAt:       true,
      firstResponseAt: true,
      slaBreached:     true,
      createdBy:  { select: { name: true } },
      assignedTo: { select: { name: true } },
    },
  })

  const rows: TicketAgingRow[] = tickets.map(t =>
    buildTicketAgingRow(
      {
        ticketNumber:    t.ticketNumber,
        subject:         t.subject,
        category:        String(t.category),
        priority:        String(t.priority),
        status:          String(t.status),
        createdByName:   t.createdBy?.name ?? 'Unknown',
        assignedToName:  t.assignedTo?.name ?? undefined,
        createdAt:       t.createdAt,
        updatedAt:       t.updatedAt,
        firstResponseAt: t.firstResponseAt ?? null,
        slaBreached:     t.slaBreached,
      },
      asOf,
    ),
  )

  return buildResponse(rows, asOf, format)
}

// ── Shared response builder ────────────────────────────────────────────────────

function buildResponse(
  rows:   TicketAgingRow[],
  asOf:   Date,
  format: string,
): NextResponse {
  if (format === 'xlsx') {
    const bytes = generateTicketAgingExcel(rows)
    const buf   = Buffer.from(bytes)
    const today = asOf.toISOString().split('T')[0]
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="ticket-aging-${today}.xlsx"`,
        'Cache-Control':       'no-store',
      },
    })
  }

  // Default: JSON (for on-screen preview)
  const summary = summarizeAging(rows)
  return NextResponse.json({
    success: true,
    data: {
      rows,
      summary,
      asOf: asOf.toISOString(),
    },
  })
}
