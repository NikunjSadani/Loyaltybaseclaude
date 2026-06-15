import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { parseUtrUpload } from '@/lib/credits-payouts-utr';
import { notifyPayoutConfirmed } from '@/lib/credits-payouts-notify';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

// POST /api/admin/credits/payout-downloads/[id]/utr
// [id] is the CreditPayoutDownload record id
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'GIFSY_ADMIN') return err('Forbidden — GIFSY_ADMIN only', 403);

  const clientId = getClientIdFromRequest(req);
  const denied = await requirePermission(user as { role: string; clientId: string },'credits:mark_paid');
  if (denied) return denied;
  const { id } = await params;

  const download = await prisma.creditPayoutDownload.findFirst({
    where: { id, clientId },
    include: {
      entries: {
        select: { id: true, outletId: true, status: true, utr: true, amountInr: true },
      },
    },
  });
  if (!download) return err('Payout download not found', 404);

  // Parse multipart form data
  let formData: FormData;
  try { formData = await req.formData(); } catch { return err('Invalid form data'); }

  const file = formData.get('file');
  if (!file || typeof file === 'string') return err('No file uploaded');

  const buffer = await (file as File).arrayBuffer();

  // Build injectable batch rows
  const batchRows = download.entries.map((e) => ({
    outletId:  e.outletId,
    utrStatus: (e.status === 'PAID' ? 'PAID' : e.status === 'FAILED' ? 'FAILED' : 'PENDING') as 'PENDING' | 'PAID' | 'FAILED',
    utr:       e.utr ?? undefined,
  }));

  // Collect all known UTRs across all downloads for this client (dup detection)
  const usedUtrs = await prisma.creditPayoutEntry.findMany({
    where: { clientId, utr: { not: null } },
    select: { utr: true },
  });
  const knownUtrs = new Set<string>(
    usedUtrs.filter((e) => e.utr != null).map((e) => e.utr!.toUpperCase()),
  );

  const parseResult = parseUtrUpload(buffer, {
    downloadCode: download.downloadCode,
    batchRows,
    knownUtrs,
  });

  // Return parse result for preview (client confirms before applying)
  const applyParam = formData.get('apply');
  if (applyParam !== 'true') {
    return ok({ parseResult, downloadCode: download.downloadCode });
  }

  if (!parseResult.canProceed) {
    return err('Cannot apply — parse result has errors or no valid rows');
  }

  // Apply UTR results to DB
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const row of parseResult.rows) {
      if (row.status !== 'OK') continue;

      const entry = download.entries.find((e) => e.outletId === row.outletId);
      if (!entry) continue;

      await tx.creditPayoutEntry.update({
        where: { id: entry.id },
        data: {
          status: row.success ? 'PAID' : 'FAILED',
          utr:    row.success ? row.utr || null : null,
          paidAt: row.success ? now : null,
        },
      });
    }

    // Update download status
    const stillPending = download.entries.some((e) => {
      const row = parseResult.rows.find((r) => r.outletId === e.outletId);
      return !row || row.status === 'SKIP';
    });
    await tx.creditPayoutDownload.update({
      where: { id: download.id },
      data:  { status: stillPending ? 'PARTIALLY_PAID' : 'PAID' },
    });
  });

  // Notify outlets (fire-and-forget — needs phone number from outlet)
  const paidOutletIds = parseResult.rows
    .filter((r) => r.status === 'OK' && r.success)
    .map((r) => r.outletId);

  if (paidOutletIds.length > 0) {
    prisma.outlet.findMany({
      where: { outletCode: { in: paidOutletIds } },
      select: { outletCode: true, name: true, phone: true },
    }).then((outlets) => {
      const phoneMap = new Map(outlets.map((o) => [o.outletCode, o]));
      for (const row of parseResult.rows) {
        if (row.status !== 'OK' || !row.success) continue;
        const entry  = download.entries.find((e) => e.outletId === row.outletId);
        const outlet = phoneMap.get(row.outletId);
        if (!entry || !outlet?.phone) continue;
        notifyPayoutConfirmed({
          phone:      outlet.phone,
          outletName: outlet.name,
          amountInr:  Number(entry.amountInr),
          utr:        row.utr ?? '',
          period:     download.period,
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  return ok({
    applied:     true,
    paidCount:   parseResult.summary.paidCount,
    failedCount: parseResult.summary.failedCount,
    skippedCount: parseResult.summary.skipped,
  });
}
