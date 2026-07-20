// Shared PAYOUT-STATEMENT builder — used by BOTH the partner's own wallet
// (partner.service.getPayouts) and the sales outlet ledger (kyc.service.ledger),
// so the two payout views can never drift (mirrors the credit-field-name helper).
//
// Two payout rails are unioned into one history:
//   • redemption cash-outs  → PayoutTransaction (scoped by partnerId)
//   • credit-based payouts   → CreditPayoutEntry (scoped by outlet CODE — its
//     `outletId` column holds the outlet CODE string, NOT the Outlet PK)
// Credit entries surface from generation (PENDING/PROCESSING) through PAID so the
// outlet sees a payout is coming, then the SAME row flips to PAID with its UTR —
// mirroring the redemption side. FAILED/REVERSED are excluded (a transient bank
// reject that GLM-2 re-banks / a clawed-back award — not a payout to show). The
// merged list sorts newest-first on the effective date (paid/completed else added)
// and caps at 100.

/** One payout row as surfaced to the wallet / ledger (INR, integer paise). */
export interface PayoutRow {
  id: string;
  period: string; // 'YYYY-MM'
  kpiLabel: string;
  achievedPct: number;
  payoutAmountPaise: number;
  uploadedAt: string; // ISO — when the payout was added/generated
  utr?: string;
  paidAt?: string; // ISO — when money hit
  status: 'PAID' | 'PENDING' | 'PROCESSING' | 'FAILED';
  narration?: string;
}

/** PayoutTransaction row shape consumed here (redemption rail). */
interface PayoutTxRow {
  id: string;
  status: string;
  completedAt: Date | null;
  createdAt: Date;
  netAmountPaise: bigint;
  providerRefId: string | null;
  batch: { batchCode: string; notes: string | null; createdAt: Date } | null;
}

/** CreditPayoutEntry row shape consumed here (credit rail). */
interface CreditEntryRow {
  id: string;
  period: string;
  fieldName: string;
  amountPaise: bigint;
  narration: string;
  status: string;
  utr: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

/** The minimal Prisma shape this helper needs (PrismaService or a tx client both satisfy it).
 *  payoutTransaction returns `unknown[]` because it uses `include: { batch }` (a relation not
 *  on the base model), which Prisma's findMany return type can't be structurally constrained to
 *  here — the runtime shape is PayoutTxRow (cast below). The scalar-only readers stay typed. */
export interface PayoutStatementReader {
  outlet: { findMany: (args: unknown) => Promise<Array<{ outletCode: string }>> };
  payoutTransaction: { findMany: (args: unknown) => Promise<unknown[]> };
  creditPayoutEntry: { findMany: (args: unknown) => Promise<CreditEntryRow[]> };
}

/**
 * PayoutStatus → the wallet's 4-state payout status. 'SUCCESS' is the ACTUAL
 * completed value in the enum (payouts.service writes it on UTR upload); missing
 * it here mapped every paid redemption to PENDING → perpetually "pending".
 */
export function mapPayoutStatus(s: string): PayoutRow['status'] {
  if (s === 'SUCCESS' || s === 'PAID' || s === 'COMPLETED') return 'PAID';
  if (s === 'FAILED' || s === 'REVERSED') return 'FAILED';
  if (s === 'INITIATED' || s === 'PROCESSING') return 'PROCESSING';
  return 'PENDING';
}

/**
 * CreditEntryStatus → the wallet's 4-state payout status. FAILED/REVERSED map to
 * FAILED (though the surfaced set excludes them); PROCESSING = in-flight (entry
 * pulled into a payout download, awaiting UTR).
 */
export function mapCreditEntryStatus(s: string): PayoutRow['status'] {
  if (s === 'PAID') return 'PAID';
  if (s === 'FAILED' || s === 'REVERSED') return 'FAILED';
  if (s === 'PROCESSING') return 'PROCESSING';
  return 'PENDING';
}

function toPeriod(d: Date): string {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${yr}-${mo}`;
}

/**
 * Build the unified payout history for one partner (all their outlets).
 *
 * @param prisma    PrismaService or a $transaction client.
 * @param clientId  Tenant scope (never cross-tenant).
 * @param partnerId The ChannelPartner id whose payouts to gather.
 */
export async function buildPayoutStatement(
  prisma: PayoutStatementReader,
  clientId: string,
  partnerId: string,
): Promise<PayoutRow[]> {
  // The partner's outlets — credit payouts are scoped by outlet CODE (a partner may
  // own several); redemption payouts are scoped by partnerId. CreditPayoutEntry
  // .outletId holds the outlet CODE (a bare string, not the Outlet PK), so this MUST
  // key on outletCode or it matches nothing.
  const outlets = await prisma.outlet.findMany({
    where: { clientId, partnerId, deletedAt: null },
    select: { outletCode: true },
  });
  const outletCodes = outlets.map((o) => o.outletCode);

  const [transactions, creditEntries] = await Promise.all([
    prisma.payoutTransaction.findMany({
      // Hide FAILED/REVERSED at the query so they don't consume the 100-cap.
      where: { partnerId, status: { notIn: ['FAILED', 'REVERSED'] } },
      include: { batch: { select: { batchCode: true, notes: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    outletCodes.length
      ? prisma.creditPayoutEntry.findMany({
          where: {
            clientId,
            outletId: { in: outletCodes },
            status: { in: ['PENDING', 'PROCESSING', 'PAID'] },
          },
          select: {
            id: true,
            period: true,
            fieldName: true,
            amountPaise: true,
            narration: true,
            status: true,
            utr: true,
            paidAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      : Promise.resolve([] as CreditEntryRow[]),
  ]);

  const redemptionPayouts = (transactions as PayoutTxRow[]).map((t) => ({
    id: t.id,
    period: toPeriod(t.completedAt ?? t.createdAt),
    kpiLabel: t.batch?.notes ?? 'Incentive Payout',
    achievedPct: 100,
    payoutAmountPaise: Number(t.netAmountPaise),
    uploadedAt: (t.batch?.createdAt ?? t.createdAt).toISOString(),
    utr: t.providerRefId ?? undefined,
    paidAt: t.completedAt?.toISOString() ?? undefined,
    status: mapPayoutStatus(t.status),
    narration: t.batch?.notes ?? undefined,
    _sortAt: (t.completedAt ?? t.createdAt).getTime(),
  }));

  const creditPayouts = creditEntries.map((e) => ({
    id: e.id,
    period: e.period, // already 'YYYY-MM' (the credit month) — no server-TZ derivation
    kpiLabel: e.fieldName || 'Credit Payout',
    achievedPct: 100,
    payoutAmountPaise: Number(e.amountPaise),
    uploadedAt: e.createdAt.toISOString(),
    utr: e.utr ?? undefined,
    paidAt: e.paidAt?.toISOString() ?? undefined,
    status: mapCreditEntryStatus(e.status),
    narration: e.narration || undefined,
    _sortAt: (e.paidAt ?? e.createdAt).getTime(),
  }));

  return [...redemptionPayouts, ...creditPayouts]
    .sort((a, b) => b._sortAt - a._sortAt)
    .slice(0, 100)
    .map(({ _sortAt: _drop, ...p }) => p);
}
