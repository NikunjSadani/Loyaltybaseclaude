// Shared PAYOUT-STATEMENT builder — used by BOTH the partner's own wallet
// (partner.service.getPayouts) and the sales outlet ledger (kyc.service.ledger),
// so the two payout views can never drift (mirrors the credit-field-name helper).
//
// Three payout rails are unioned into one history (the third — the off-portal payments register — since 2026-11-25):
//   • redemption cash-outs  → PayoutTransaction (scoped by partnerId)
//   • credit-based payouts   → CreditPayoutEntry (scoped by outlet CODE — its
//     `outletId` column holds the outlet CODE string, NOT the Outlet PK)
// Credit entries surface from generation (PENDING/PROCESSING) through PAID so the
// outlet sees a payout is coming, then the SAME row flips to PAID with its UTR —
// mirroring the redemption side. FAILED/REVERSED are excluded (a transient bank
// reject that GLM-2 re-banks / a clawed-back award — not a payout to show). The
// merged list sorts newest-first on the effective date (paid/completed else added).
//
// NO row cap (fix/list-caps): this is the outlet's FULL payout history. It used to be capped
// at 100 rows, which silently dropped older payouts from the wallet statement, understated the
// FE-summed Lifetime/Last-Month Payout and the statement download, and truncated the sales
// ledger. Volume is small and bounded (staging measured 2026-11-07: max 18 credit entries per
// outlet over 48,422 rows / 4,005 outlets; 2 redemption payouts total), mirroring the already
// unpaginated points statement (/wallet/statement). Do NOT re-add a cap or paging here — every
// consumer (wallet list, totals, download, sales ledger) assumes the complete set.

/** One payout row as surfaced to the wallet / ledger (INR, integer paise). */
import { istMonthKey } from './ist-date';
import { clientHasOffPortalPayments, type PresenceDb } from '../off-portal-payments/off-portal-presence';

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
  // ── TDS withheld from a credit payout (owner audit A-M3/B-M1, 2026-11-18) ──
  // payoutAmountPaise is the NET that reached the retailer (gross − TDS withheld), so the wallet's
  // lifetime / last-month totals count only money actually received.
  /** The payout before TDS (present only when TDS was withheld). */
  grossAmountPaise?: number;
  /** TDS withheld from this payout (present only when > 0). */
  tdsWithheldPaise?: number;
  /** The WHOLE payout was withheld as TDS — ₹0 reached the retailer (no bank transfer, no UTR). */
  settledByTds?: true;
  /** Off-portal payments register (2026-11-25): paid outside the portal, recorded by Gifsy. */
  offPortal?: true;
  /** Off-portal only: paid as a gift (not money) — present only on gift rows. */
  gift?: true;
}

/** OffPortalPayment row shape consumed here (off-portal payments register). */
interface OffPortalRow {
  id: string;
  period: string;
  payoutStream: string;
  paymentMode: string;
  amountPaise: bigint;
  paymentDate: Date;
  utr: string | null;
  narration: string | null;
  createdAt: Date;
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
  tdsDeductedPaise?: bigint | null;
}

/** The minimal Prisma shape this helper needs (PrismaService or a tx client both satisfy it).
 *  payoutTransaction returns `unknown[]` because it uses `include: { batch }` (a relation not
 *  on the base model), which Prisma's findMany return type can't be structurally constrained to
 *  here — the runtime shape is PayoutTxRow (cast below). The scalar-only readers stay typed. */
export interface PayoutStatementReader {
  outlet: { findMany: (args: unknown) => Promise<Array<{ outletCode: string }>> };
  payoutTransaction: { findMany: (args: unknown) => Promise<unknown[]> };
  creditPayoutEntry: { findMany: (args: unknown) => Promise<CreditEntryRow[]> };
  /** Optional only so narrow unit-test fakes keep working; PrismaService / a tx client always has it. */
  offPortalPayment?: {
    findMany: (args: unknown) => Promise<OffPortalRow[]>;
    findFirst?: (args: { where: { clientId: string }; select: { id: true } }) => Promise<{ id: string } | null>;
  };
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

// The IST calendar month (YYYY-MM) of a payout instant. Reading getFullYear()/getMonth() off the
// raw Date is server-local (UTC in prod) → a payout completed 00:00–05:30 IST on the 1st was
// labelled the PREVIOUS month, disagreeing by a month with the credit rows (which use the stored
// IST credit `period`) in the same partner statement. istMonthKey resolves the true IST month.
function toPeriod(d: Date): string {
  return istMonthKey(d);
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
      // FAILED/REVERSED are hidden from the statement (and from the presence card).
      where: { partnerId, status: { notIn: ['FAILED', 'REVERSED'] } },
      include: { batch: { select: { batchCode: true, notes: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
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
            tdsDeductedPaise: true,
          },
          orderBy: { createdAt: 'desc' },
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

  const creditPayouts = creditEntries.map((e) => {
    const tds = e.tdsDeductedPaise && e.tdsDeductedPaise > 0n ? e.tdsDeductedPaise : 0n;
    const net = e.amountPaise - tds > 0n ? e.amountPaise - tds : 0n;
    // A payout settled entirely by TDS withholding never went to the bank: its stored reference
    // (`TDS-WITHHELD-…`) is NOT a UTR and must never be shown as one.
    const settledByTds = tds > 0n && net === 0n;
    return {
    id: e.id,
    period: e.period, // already 'YYYY-MM' (the credit month) — no server-TZ derivation
    kpiLabel: e.fieldName || 'Credit Payout',
    achievedPct: 100,
    payoutAmountPaise: Number(net),
    ...(tds > 0n ? { grossAmountPaise: Number(e.amountPaise), tdsWithheldPaise: Number(tds) } : {}),
    ...(settledByTds ? { settledByTds: true as const } : {}),
    uploadedAt: e.createdAt.toISOString(),
    utr: settledByTds || e.utr?.startsWith('TDS-WITHHELD-') ? undefined : (e.utr ?? undefined),
    paidAt: e.paidAt?.toISOString() ?? undefined,
    status: mapCreditEntryStatus(e.status),
    narration: e.narration || undefined,
    _sortAt: (e.paidAt ?? e.createdAt).getTime(),
    };
  });

  // Off-portal payments register (owner 2026-11-25): payments made OUTSIDE the portal to one of these outlets (matched
  // by Outlet ID, case-insensitive — an Outlet ID paid before it registered links automatically). Paid in full; voided
  // entries are hidden (like FAILED / REVERSED payouts).
  const offPortalRows =
    // B7: the (cached) presence check skips this read for clients with no off-portal payment at all.
    outletCodes.length && prisma.offPortalPayment && (await clientHasOffPortalPayments(prisma as PresenceDb, clientId))
      ? await prisma.offPortalPayment.findMany({
          where: { clientId, voidedAt: null, outletCodeKey: { in: [...new Set(outletCodes.map((c) => c.trim().toUpperCase()))] } },
          select: { id: true, period: true, payoutStream: true, paymentMode: true, amountPaise: true, paymentDate: true, utr: true, narration: true, createdAt: true },
          orderBy: { paymentDate: 'desc' },
        })
      : [];
  const offPortalPayouts = offPortalRows.map((p) => ({
    id: p.id,
    period: p.period,
    // Owner 2026-11-26: gifts stay in the outlet's totals / statement, clearly labelled "Gift (off-portal)".
    kpiLabel:
      p.paymentMode === 'GIFT'
        ? `Gift (off-portal) — ${p.payoutStream === 'VISIBILITY' ? 'visibility' : 'incentive'}`
        : `Off-portal ${p.payoutStream === 'VISIBILITY' ? 'visibility' : 'incentive'} payment`,
    achievedPct: 100,
    payoutAmountPaise: Number(p.amountPaise),
    uploadedAt: p.createdAt.toISOString(),
    utr: p.utr ?? undefined,
    paidAt: p.paymentDate.toISOString(),
    status: 'PAID' as const,
    narration: p.narration ?? 'Paid outside the portal',
    offPortal: true as const,
    ...(p.paymentMode === 'GIFT' ? { gift: true as const } : {}),
    _sortAt: p.paymentDate.getTime(),
  }));

  return [...redemptionPayouts, ...creditPayouts, ...offPortalPayouts]
    .sort((a, b) => b._sortAt - a._sortAt)
    .map(({ _sortAt: _drop, ...p }) => p);
}
