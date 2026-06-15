/**
 * GET /api/admin/reports/points-ledger
 *
 * Outlet Points Ledger report — per-outlet points movement over a selected period
 * (max 24 months) with dynamic per-month Earn/Burn columns.
 *
 * Query params:
 *   from    YYYY-MM   Period start (required)
 *   to      YYYY-MM   Period end   (required)
 *   format  json|xlsx Default: json
 *
 * In DEMO_MODE: returns fully-populated demo rows (8 outlets, all columns).
 * In production: queries clientId-scoped outlets → partner (1:1) → wallet →
 *   pointsLedger in range and aggregates via aggregateLedgerToRow. P2/P4 columns
 *   (Zone/ZNM/RSM/ASM/SO/XSR, distributor, program) are left blank until their
 *   respective phases land.
 *
 * Admin-only (GIFSY_ADMIN | CLIENT_ADMIN).
 *
 * Spec: docs/plans/REPORTING-REVAMP.md § R1
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser }               from '@/lib/auth'
import { requirePermission }         from '@/lib/rbac/require-permission'
import {
  monthsInRange,
  aggregateLedgerToRow,
  generatePointsLedgerExcel,
  demoPointsLedgerRows,
}                                    from '@/lib/points-ledger-export'
import { prisma }                    from '@/lib/prisma'

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN'])

/** Validate a YYYY-MM string. Returns true if well-formed. */
function isValidYYYYMM(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s)
}

export async function GET(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const authUser = await getAuthUser(req)
  if (!authUser)                       return NextResponse.json({ success: false, error: 'Unauthorized' },  { status: 401 })
  if (!ADMIN_ROLES.has(authUser.role)) return NextResponse.json({ success: false, error: 'Forbidden' },     { status: 403 })

  const denied = await requirePermission(authUser as { role: string; clientId: string }, 'reports:export')
  if (denied) return denied

  // ── Parse & validate params ────────────────────────────────────────────────
  const { searchParams } = req.nextUrl
  const from   = searchParams.get('from')   ?? ''
  const to     = searchParams.get('to')     ?? ''
  const format = searchParams.get('format') ?? 'json'

  if (!from || !to) {
    return NextResponse.json(
      { success: false, error: 'Query params `from` and `to` (YYYY-MM) are required.' },
      { status: 400 },
    )
  }
  if (!isValidYYYYMM(from) || !isValidYYYYMM(to)) {
    return NextResponse.json(
      { success: false, error: '`from` and `to` must be in YYYY-MM format.' },
      { status: 400 },
    )
  }
  if (from > to) {
    return NextResponse.json(
      { success: false, error: '`from` must not be after `to`.' },
      { status: 400 },
    )
  }

  let months: { monthKey: string; label: string }[]
  try {
    months = monthsInRange(from, to)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Invalid period range.'
    return NextResponse.json({ success: false, error: msg }, { status: 400 })
  }

  // ── DEMO_MODE ──────────────────────────────────────────────────────────────
  if (process.env.DEMO_MODE === 'true') {
    const rows = demoPointsLedgerRows(months)
    return buildResponse(rows, months, format)
  }

  // ── Production ─────────────────────────────────────────────────────────────
  // Query clientId-scoped outlets → partner (1:1) → wallet → pointsLedger in range.
  //
  // P2/P4 TODO columns (left blank with comments):
  //   Zone, ZNM id, RSM id, ASM id, SO id, XSR id  → TODO(P2): wire from SalesHierarchy
  //   Distributor code / Name                         → TODO(P2.4): wire from Distributor entity (not yet defined)
  //   Program name / category                         → TODO(P4): wire from Program entity (not yet defined)
  // Hard tenant guard: never let an empty clientId fall through to Prisma, where
  // `{ clientId: undefined }` would silently drop the filter and return ALL tenants.
  const clientId = (authUser as { clientId?: string }).clientId
  if (!clientId) {
    return NextResponse.json({ success: false, error: 'No tenant bound to the session.' }, { status: 400 })
  }

  // Period window as UTC Date boundaries
  const [fromYear, fromMonthNum] = from.split('-').map(Number)
  const [toYear,   toMonthNum  ] = to  .split('-').map(Number)
  const periodStart = new Date(Date.UTC(fromYear, fromMonthNum - 1, 1))
  // End = first moment of the month AFTER `to`
  const periodEnd   = toMonthNum === 12
    ? new Date(Date.UTC(toYear + 1, 0, 1))
    : new Date(Date.UTC(toYear, toMonthNum, 1))

  // Query: clientId-scoped outlets via partner.clientId (Outlet has no clientId column directly).
  // Outlet → partner (ChannelPartner, 1:1 per spec) → wallets[0] → pointsLedger up to periodEnd.
  const outlets = await prisma.outlet.findMany({
    where: {
      partner: { clientId },
      deletedAt: null,
    },
    select: {
      id:   true,
      name: true,
      outletType: { select: { name: true } },
      partner: {
        select: {
          wallets: {
            take: 1,   // 1 partner = 1 outlet = 1 wallet (spec decision)
            select: {
              pointsLedger: {
                where: {
                  // Fetch all entries up to period end; split opening vs in-period below.
                  createdAt: { lt: periodEnd },
                },
                select: {
                  transactionType: true,
                  points:          true,
                  createdAt:       true,
                },
              },
            },
          },
        },
      },
    },
  })

  const rows = outlets
    .filter(o => (o.partner?.wallets?.length ?? 0) > 0)
    .map(o => {
      const wallet = o.partner!.wallets[0]
      const ledger = wallet.pointsLedger

      // Split: before period = opening balance computation; in-period = monthly buckets
      const beforePeriod = ledger.filter(e => e.createdAt < periodStart)
      const inPeriod     = ledger.filter(e => e.createdAt >= periodStart)

      // Opening balance = net EARN − REDEEM − EXPIRE before period start.
      // ADJUST/REVERSE/LOCK/UNLOCK excluded — deferred refinement.
      const openingBalance = beforePeriod.reduce((sum, e) => {
        if (e.transactionType === 'EARN')   return sum + e.points
        if (e.transactionType === 'REDEEM') return sum - e.points
        if (e.transactionType === 'EXPIRE') return sum - e.points
        return sum
      }, 0)

      return aggregateLedgerToRow(
        {
          outletId:   o.id,
          outletName: o.name,
          outletType: o.outletType?.name,
          // TODO(P2): zone, znmId, rsmId, asmId, soId, xsrId from SalesHierarchy/SalesUserAssignment
          // TODO(P2.4): distributorCode, distributorName from Distributor entity (not yet defined)
          // TODO(P4): programName, programCategory from Program entity (not yet defined)
        },
        openingBalance,
        inPeriod.map(e => ({
          type:      e.transactionType,
          points:    e.points,
          createdAt: e.createdAt,
        })),
        months,
      )
    })

  return buildResponse(rows, months, format)
}

// ── Shared response builder ────────────────────────────────────────────────────

import type { PointsLedgerReportRow } from '@/types'

function buildResponse(
  rows:   PointsLedgerReportRow[],
  months: { monthKey: string; label: string }[],
  format: string,
): NextResponse {
  if (format === 'xlsx') {
    const bytes = generatePointsLedgerExcel(rows, months)
    const buf   = Buffer.from(bytes)
    const today = new Date().toISOString().split('T')[0]
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="points-ledger-${today}.xlsx"`,
        'Cache-Control':       'no-store',
      },
    })
  }

  // Default: JSON (for on-screen preview)
  return NextResponse.json({ success: true, data: { months, rows } })
}
