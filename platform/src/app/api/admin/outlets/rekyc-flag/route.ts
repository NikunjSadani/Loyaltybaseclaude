import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';
import { Prisma } from '@prisma/client';
import type { ReKYCFlagRow } from '@/types';
import { buildReKycFlags, isReKycFlagsEmpty } from '@/lib/outlet-upload';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN']);

/** One per-row outcome, mirroring the outlet-upsert error-report shape. */
interface RowResult {
  rowNum: number;
  outletId: string;
  status: 'OK' | 'ERROR';
  action: 'FLAGGED' | 'CLEARED';
  errors: string[];
}

/** Minimal shape we require from each posted row (a parsed ReKYCFlagRow). */
function isReKycRow(r: unknown): r is ReKYCFlagRow {
  return !!r && typeof r === 'object' && typeof (r as ReKYCFlagRow).outletId === 'string';
}

/**
 * POST /api/admin/outlets/rekyc-flag
 *
 * Persists the Re-KYC flag upload. The admin page validates client-side via the
 * outlet-upload lib (`validateReKYCFlagUpload`) and posts the OK, fully-parsed
 * `ReKYCFlagRow[]` (the raw "Yes"/blank cells per field). This route turns each row
 * into the `ReKYCFlags` JSON via the lib's `buildReKycFlags` (map-driven over
 * REKYC_KEY_TO_FLAG) and writes it onto Outlet.reKycFlags, tenant-scoped on
 * (clientId, outletCode). Nothing else on the outlet is touched.
 *
 * All-false semantics: a row with no field flagged "Yes" clears reKycFlags back to
 * null (re-KYC no longer pending). Setting any flag marks the outlet as needing
 * re-KYC. (The client-side validator already rejects all-blank rows — at least one
 * "Yes" is required — so in normal use every persisted row FLAGs; the CLEARED path
 * is a defensive/idempotent fallback, e.g. a direct API caller un-flagging an outlet.)
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (!ADMIN_ROLES.has(authUser.role)) return err('Forbidden', 403);

    const clientId = getClientIdFromRequest(req);
    const denied = await requirePermission(authUser as { role: string; clientId: string }, 'kyc:initiate');
    if (denied) return denied;

    let body: { rows?: unknown[] };
    try {
      body = await req.json();
    } catch {
      return err('Invalid JSON body');
    }

    const { rows } = body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return err('rows must be a non-empty array');
    }
    if (rows.length > 500) {
      return err('Maximum 500 outlets per re-KYC flag request');
    }

    // Note: no DEMO_MODE short-circuit — the re-KYC flag upload persists for real
    // even in the local demo (consistent with the outlet master + hierarchy uploads),
    // so the full re-KYC pipeline can be exercised end-to-end.

    const flagRows: ReKYCFlagRow[] = [];
    for (const r of rows) {
      if (!isReKycRow(r)) return err('Each row must be a parsed re-KYC flag row with an outletId');
      flagRows.push(r);
    }

    const rowResults: RowResult[] = [];
    let flagged = 0;
    let cleared = 0;

    for (const row of flagRows) {
      const outletCode = row.outletId.trim();

      if (!outletCode) {
        rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'ERROR', action: 'FLAGGED', errors: ['Outlet ID is required'] });
        continue;
      }

      const flags = buildReKycFlags(row);
      const clearing = isReKycFlagsEmpty(flags);

      const existing = await prisma.outlet.findUnique({
        where:  { clientId_outletCode: { clientId, outletCode } },
        select: { id: true },
      });
      if (!existing) {
        rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'ERROR', action: clearing ? 'CLEARED' : 'FLAGGED', errors: [`Outlet ${outletCode} not found`] });
        continue;
      }

      // Only Outlet.reKycFlags is written — no other outlet field is touched.
      await prisma.outlet.update({
        where: { clientId_outletCode: { clientId, outletCode } },
        // DbNull writes a real SQL NULL to the nullable Json column (clearing the
        // re-KYC pending state); JS `null` is not accepted by Prisma's Json input type.
        data:  { reKycFlags: clearing ? Prisma.DbNull : (flags as unknown as Prisma.InputJsonValue) },
      });

      if (clearing) cleared++; else flagged++;
      rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'OK', action: clearing ? 'CLEARED' : 'FLAGGED', errors: [] });
    }

    const errorRows = rowResults.filter(r => r.status === 'ERROR');
    return ok({
      flagged,
      cleared,
      errors: errorRows,
      rows: rowResults,
      message: `${flagged} flagged${cleared ? `, ${cleared} cleared` : ''}${errorRows.length ? `, ${errorRows.length} row(s) failed` : ''}`,
    });
  } catch (e: any) {
    console.error('[admin/outlets/rekyc-flag POST]', e);
    return err('Failed to set re-KYC flags', 500);
  }
}
