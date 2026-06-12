/**
 * GET /api/visibility/outlet-statuses
 *
 * Returns a map of outletCode → visibility status for a given month.
 * Used by the sales app to show the visibility badge on outlet target cards.
 *
 * All internal roles (sales, admin) can read.
 * Partner roles (RETAILER, WHOLESALER, SUB_STOCKIST) are blocked.
 *
 * Query params:
 *   outletCodes — comma-separated list of outletCode strings
 *   month       — YYYY-MM (defaults to current month if omitted)
 *
 * Response:
 *   { data: { [outletCode]: { status, dateOfCapture, approvedBy, capturedByEmployeeName } } }
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) =>
  NextResponse.json({ success: true,  data   }, { status });
const err = (message: string, status: number) =>
  NextResponse.json({ success: false, error: message }, { status });

const partnerRoles = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (partnerRoles.includes(authUser.role)) return err('Forbidden', 403);

    const clientId       = getClientIdFromRequest(req);
    const { searchParams } = new URL(req.url);

    const outletCodesParam = searchParams.get('outletCodes') ?? '';
    // Default to current month (YYYY-MM) if not provided
    const month = searchParams.get('month') ??
      new Date().toISOString().slice(0, 7);

    if (!outletCodesParam) return ok({});

    const outletCodes = outletCodesParam
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    if (outletCodes.length === 0) return ok({});

    const records = await prisma.outletVisibilityRecord.findMany({
      where: {
        clientId,
        month,
        outletCode: { in: outletCodes },
      },
      select: {
        outletCode:            true,
        status:                true,
        dateOfCapture:         true,
        approvedBy:            true,
        capturedByEmployeeName: true,
      },
    });

    // Build outletCode → status map
    const statusMap: Record<string, {
      status:                 string;
      dateOfCapture:          string | null;
      approvedBy:             string | null;
      capturedByEmployeeName: string | null;
    }> = {};

    for (const record of records) {
      statusMap[record.outletCode] = {
        status:                 record.status,
        dateOfCapture:          record.dateOfCapture
          ? record.dateOfCapture.toISOString().slice(0, 10)
          : null,
        approvedBy:             record.approvedBy,
        capturedByEmployeeName: record.capturedByEmployeeName,
      };
    }

    return ok(statusMap);
  } catch (e) {
    console.error('[visibility/outlet-statuses] unexpected error:', e);
    return err('Internal server error', 500);
  }
}
