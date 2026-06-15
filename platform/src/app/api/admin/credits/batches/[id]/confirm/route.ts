import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { notifyGifsyNewBatch } from '@/lib/credits-payouts-notify';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data  }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ALLOWED_ROLES = ['CLIENT_ADMIN', 'GIFSY_ADMIN'] as const;

// POST /api/admin/credits/batches/[id]/confirm
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.includes(user.role as typeof ALLOWED_ROLES[number])) return err('Forbidden', 403);

  const clientId = getClientIdFromRequest(req);
  const denied = await requirePermission(user as { role: string; clientId: string },'credits:confirm_payout');
  if (denied) return denied;
  const { id } = await params;

  const batch = await prisma.creditBatch.findFirst({
    where: { id, clientId },
  });
  if (!batch) return err('Batch not found', 404);
  if (batch.status !== 'PENDING_CONFIRM') {
    return err(`Batch is already ${batch.status}`);
  }

  // Parse rows from JSON and create CreditPayoutEntry for each PAYOUT-type OK row
  const rows = (batch.rows as {
    outletId: string; outletName: string;
    fieldId: string; fieldName: string;
    amount: number; narration: string;
    awardType: string; status: string;
  }[]);

  const payoutRows = rows.filter((r) => r.awardType === 'PAYOUT' && r.status === 'OK');

  // Confirm batch and create payout entries in a transaction
  const updated = await prisma.$transaction(async (tx) => {
    const confirmed = await tx.creditBatch.update({
      where: { id },
      data: {
        status:      'CONFIRMED',
        confirmedBy: user.userId,
        confirmedAt: new Date(),
      },
    });

    if (payoutRows.length > 0) {
      await tx.creditPayoutEntry.createMany({
        data: payoutRows.map((r) => ({
          clientId,
          batchId:   id,
          outletId:  r.outletId,
          outletName: r.outletName,
          fieldId:   r.fieldId,
          fieldName: r.fieldName,
          period:    batch.period,
          amountInr: r.amount,
          narration: r.narration ?? '',
        })),
      });
    }

    return confirmed;
  });

  // Notify Gifsy team (fire-and-forget; don't block confirm on notification failure)
  notifyGifsyNewBatch({
    tenantName:      clientId,
    batchId:         id,
    period:          batch.period,
    totalOutlets:    Number(batch.totalOutlets),
    totalPoints:     Number(batch.totalPoints),
    totalPayoutInr:  Number(batch.totalPayoutInr),
    uploadedBy:      batch.uploadedBy,
    recipientEmails: ['ops@gifsy.in'],
  }).catch(() => {});

  return ok({ batch: updated, payoutEntriesCreated: payoutRows.length });
}
