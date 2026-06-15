import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';
import type { OutletUploadRow } from '@/types';
import { mapRowToOutletData, buildOutletCreate, buildOutletUpdate } from '@/lib/outlet-persist';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN']);

/** One per-row outcome, mirroring the outlet-upload error-report shape. */
interface RowResult {
  rowNum: number;
  outletId: string;
  status: 'OK' | 'ERROR';
  action: 'CREATE' | 'UPDATE';
  errors: string[];
}

/** Minimal shape we require from each posted row (a parsed OutletUploadRow). */
function isUploadRow(r: unknown): r is OutletUploadRow {
  return !!r && typeof r === 'object' && typeof (r as OutletUploadRow).outletId === 'string';
}

/**
 * POST /api/admin/outlets/upsert
 *
 * Persists the Outlet Master upload. The admin page validates client-side via the
 * outlet-upload lib (`validateOutletUpload`) and posts only the OK, fully-parsed
 * `OutletUploadRow[]`. This route enforces the two invariants that can only be
 * checked at write time against the DB — OutletType-by-code and XSR-by-employeeCode,
 * both tenant-scoped — then upserts each Outlet on (clientId, outletCode) and tags
 * it to the resolved XSR via SalesUserAssignment. partnerId is left NULL (owner
 * attached at KYC); addressLine1/pincode are KYC-captured, also left null.
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (!ADMIN_ROLES.has(authUser.role)) return err('Forbidden', 403);

    const clientId = getClientIdFromRequest(req);
    const denied = await requirePermission(authUser as { role: string; clientId: string }, 'partners:manage_outlets');
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
      return err('Maximum 500 outlets per upsert request');
    }

    if (process.env.DEMO_MODE === 'true') {
      return ok({ created: 0, updated: rows.length, errors: [], message: 'Outlet upsert complete (demo mode)' });
    }

    const uploadRows: OutletUploadRow[] = [];
    for (const r of rows) {
      if (!isUploadRow(r)) return err('Each row must be a parsed outlet upload row with an outletId');
      uploadRows.push(r);
    }

    // ── Resolve the tenant's enabled outlet types once (code → id) ──────────────
    // OutletType is a global catalog; per-tenant enablement lives on
    // OutletTypeClientConfig. "Within clientId" = enabled for this client.
    const typeConfigs = await prisma.outletTypeClientConfig.findMany({
      where:   { clientId, isEnabled: true },
      select:  { outletType: { select: { id: true, code: true, isActive: true } } },
    });
    const typeIdByCode = new Map<string, string>();
    for (const c of typeConfigs) {
      if (c.outletType.isActive) typeIdByCode.set(c.outletType.code.toUpperCase(), c.outletType.id);
    }

    const rowResults: RowResult[] = [];
    let created = 0;
    let updated = 0;
    const now = new Date();

    for (const row of uploadRows) {
      const errors: string[] = [];
      const outletCode = row.outletId.trim();

      // 1. Resolve outlet type (tenant-scoped).
      const outletTypeId = typeIdByCode.get((row.outletType ?? '').trim().toUpperCase());
      if (!outletTypeId) {
        errors.push(`Unknown outlet type: ${row.outletType}`);
      }

      // 2. Resolve XSR (sales hierarchy must already be built — task 2.1).
      let salesUserId: string | null = null;
      const xsrId = (row.xsrId ?? '').trim();
      if (xsrId) {
        const su = await prisma.salesUser.findUnique({
          where:  { clientId_employeeCode: { clientId, employeeCode: xsrId } },
          select: { id: true },
        });
        if (!su) {
          errors.push(`XSR ${xsrId} not found — upload the sales hierarchy first`);
        } else {
          salesUserId = su.id;
        }
      }

      if (errors.length > 0 || !outletTypeId) {
        rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'ERROR', action: 'CREATE', errors });
        continue;
      }

      const data = mapRowToOutletData(row, outletTypeId);

      // 3. Upsert the outlet + (re)tag to the XSR in one transaction.
      const action = await prisma.$transaction(async (tx) => {
        const existing = await tx.outlet.findUnique({
          where:  { clientId_outletCode: { clientId, outletCode } },
          select: { id: true },
        });

        const outlet = await tx.outlet.upsert({
          where:  { clientId_outletCode: { clientId, outletCode } },
          create: buildOutletCreate(clientId, outletCode, data),
          update: buildOutletUpdate(data),
        });

        // Re-tag: close any active assignment for this outlet, then attach the XSR.
        if (salesUserId) {
          await tx.salesUserAssignment.updateMany({
            where: { outletId: outlet.id, unassignedAt: null },
            data:  { unassignedAt: now },
          });
          await tx.salesUserAssignment.create({
            data: { salesUserId, outletId: outlet.id, assignedAt: now },
          });
        }

        return existing ? 'UPDATE' as const : 'CREATE' as const;
      });

      if (action === 'CREATE') created++; else updated++;
      rowResults.push({ rowNum: row.rowNum, outletId: outletCode, status: 'OK', action, errors: [] });
    }

    const errorRows = rowResults.filter(r => r.status === 'ERROR');
    return ok({
      created,
      updated,
      errors: errorRows,
      rows: rowResults,
      message: `${created} created, ${updated} updated${errorRows.length ? `, ${errorRows.length} row(s) failed` : ''}`,
    });
  } catch (e: any) {
    console.error('[admin/outlets/upsert POST]', e);
    return err('Failed to upsert outlets', 500);
  }
}
