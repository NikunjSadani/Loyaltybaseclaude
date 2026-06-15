import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { generatePayoutFileBuffer } from '@/lib/credits-payouts-payout-download';
import type { PayoutBatch, PayoutBatchRow } from '@/types';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

// ─── Download code generator: PD-YYYY-MM-NNN ─────────────────────────────────

async function generateDownloadCode(clientId: string, period: string): Promise<string> {
  const prefix = `PD-${period}`;
  const count = await prisma.creditPayoutDownload.count({
    where: { clientId, downloadCode: { startsWith: prefix } },
  });
  return `${prefix}-${String(count + 1).padStart(3, '0')}`;
}

// GET /api/admin/credits/payout-downloads — list downloads for GIFSY_ADMIN
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'GIFSY_ADMIN') return err('Forbidden — GIFSY_ADMIN only', 403);

  const clientId = getClientIdFromRequest(req);
  const denied = await requirePermission(user as { role: string; clientId: string },'credits:download_bank_file');
  if (denied) return denied;
  const url = new URL(req.url);
  const period = url.searchParams.get('period');

  const downloads = await prisma.creditPayoutDownload.findMany({
    where: {
      clientId,
      ...(period ? { period } : {}),
    },
    orderBy: { downloadedAt: 'desc' },
    include: {
      _count: { select: { entries: true } },
    },
  });

  return ok(downloads);
}

// POST /api/admin/credits/payout-downloads — generate payout file
const createSchema = z.object({
  period:    z.string().regex(/^\d{4}-\d{2}$/),
  groupType: z.enum(['STANDARD', 'SEPARATE']),
  fieldId:   z.string().optional(),
  fieldName: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'GIFSY_ADMIN') return err('Forbidden — GIFSY_ADMIN only', 403);

  const clientId = getClientIdFromRequest(req);
  const denied = await requirePermission(user as { role: string; clientId: string },'credits:download_bank_file');
  if (denied) return denied;

  let body: unknown;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? 'Validation error');

  const { period, groupType, fieldId, fieldName } = parsed.data;

  // Get active separate fields (for STANDARD filter)
  const separateFields = await prisma.creditField.findMany({
    where: { clientId, isSeparatePayout: true, isActive: true },
    select: { id: true },
  });
  const separateFieldIds = new Set(separateFields.map((f) => f.id));

  // Get PENDING payout entries for this period
  const baseWhere = {
    clientId,
    period,
    status:   'PENDING' as const,
  };

  let entryWhere: Prisma.CreditPayoutEntryWhereInput = baseWhere;
  if (groupType === 'SEPARATE' && fieldId) {
    entryWhere = { ...baseWhere, fieldId };
  } else if (groupType === 'STANDARD') {
    entryWhere = {
      ...baseWhere,
      NOT: separateFieldIds.size > 0
        ? { fieldId: { in: [...separateFieldIds] } }
        : undefined,
    };
  }

  const entries = await prisma.creditPayoutEntry.findMany({
    where: entryWhere,
    include: { batch: { select: { batchCode: true } } },
  });

  if (entries.length === 0) {
    return err(`No PENDING payout entries found for period ${period}${fieldId ? ` / field ${fieldId}` : ''}.`);
  }

  // Group by outlet, sum amounts
  const outletMap = new Map<string, {
    outletName: string; amount: number; entryIds: string[];
  }>();
  for (const e of entries) {
    const cur = outletMap.get(e.outletId);
    if (cur) {
      cur.amount += Number(e.amountInr);
      cur.entryIds.push(e.id);
    } else {
      outletMap.set(e.outletId, {
        outletName: e.outletName,
        amount:     Number(e.amountInr),
        entryIds:   [e.id],
      });
    }
  }

  // Fetch bank details from ChannelPartner via Outlet.outletCode
  const outletCodes = [...outletMap.keys()];
  const outlets = await prisma.outlet.findMany({
    where: { outletCode: { in: outletCodes } },
    include: {
      partner: {
        select: {
          bankName: true, bankAccountNumber: true,
          bankAccountHolder: true, ifscCode: true, upiId: true,
        },
      },
    },
  });
  const outletDbMap = new Map(outlets.map((o) => [o.outletCode, o]));

  // Build bank snapshots
  const bankSnapshots = outletCodes.map((code) => {
    const o = outletDbMap.get(code);
    return {
      outletId:      code,
      bankName:      o?.partner?.bankName      ?? '',
      accountNumber: o?.partner?.bankAccountNumber ?? '',
      ifscCode:      o?.partner?.ifscCode      ?? '',
      upiId:         o?.partner?.upiId         ?? '',
      snapshotAt:    new Date().toISOString(),
    };
  });
  const snapshotMap = new Map(bankSnapshots.map((s) => [s.outletId, s]));

  const rows: PayoutBatchRow[] = outletCodes.map((code) => {
    const info     = outletMap.get(code)!;
    const o        = outletDbMap.get(code);
    const snapshot = snapshotMap.get(code)!;
    return {
      outletId:      code,
      outletName:    info.outletName,
      phone:         o?.phone ?? '',
      bankName:      snapshot.bankName,
      accountNumber: snapshot.accountNumber,
      ifscCode:      snapshot.ifscCode,
      upiId:         snapshot.upiId,
      kycStatus:     'APPROVED',
      amount:        info.amount,
      isDeactivated: !(o?.isActive ?? true),
      utrStatus:     'PENDING',
      entryIds:      info.entryIds,
    };
  });

  const downloadCode = await generateDownloadCode(clientId, period);
  const totalAmountInr = rows.reduce((s, r) => s + r.amount, 0);

  // Build PayoutBatch shape for generatePayoutFileBuffer
  const payoutBatch: PayoutBatch = {
    id:            downloadCode,
    creditBatchId: 'MULTI',
    period,
    groupType,
    ...(fieldId   ? { fieldId }   : {}),
    ...(fieldName ? { fieldName } : {}),
    status:        'OPEN',
    downloadedAt:  new Date().toISOString(),
    downloadedBy:  user.userId,
    totalAmount:   totalAmountInr,
    bankSnapshots,
    rows,
  };

  // Create download record + mark entries with downloadId
  const download = await prisma.$transaction(async (tx) => {
    const rec = await tx.creditPayoutDownload.create({
      data: {
        clientId,
        downloadCode,
        period,
        groupType,
        fieldId:       fieldId ?? null,
        fieldName:     fieldName ?? null,
        downloadedBy:  user.userId,
        totalAmountInr,
        bankSnapshots: bankSnapshots as object[],
      },
    });

    await tx.creditPayoutEntry.updateMany({
      where: { id: { in: entries.map((e) => e.id) } },
      data:  { downloadId: rec.id, status: 'PROCESSING' },
    });

    return rec;
  });

  // Generate Excel
  const buffer = generatePayoutFileBuffer(payoutBatch);
  const bytes  = new Uint8Array(buffer);

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="payout-${downloadCode}.xlsx"`,
      'X-Download-Code':     downloadCode,
      'X-Download-Id':       download.id,
    },
  });
}
