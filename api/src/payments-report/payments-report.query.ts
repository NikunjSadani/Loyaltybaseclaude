/**
 * The ONE definition of "which payout entries are in the Payments Report, in what order, and what they total".
 * Shared by the on-screen report (PaymentsReportService — one page at a time) and the Excel export kind
 * (exports/kinds/batch2/payments-report.kind.ts — every row, streamed in pages), so the screen and the file can
 * never disagree on the row set, the order at a page boundary, or the totals.
 *
 * Pure (no DI): the export kind also runs in the background export worker, which does not load PaymentsReportModule.
 */
import { CreditEntryStatus, Prisma } from '@prisma/client';
import { istDayRangeFilter } from '../common/ist-date';

export interface PaymentsFilter {
  /** undefined/null = platform-wide (un-assumed GIFSY); a value = single-tenant scope. */
  clientId?: string | null;
  from?: string | null;
  to?: string | null;
  status?: CreditEntryStatus | null;
}

/** true → the non-PAID audit path (FAILED / REVERSED / …): no paidAt floor, range + order on attemptedAt. */
export function isNonPaidStatus(f: PaymentsFilter): boolean {
  return !!f.status && f.status !== CreditEntryStatus.PAID;
}

/**
 * WHERE for the report. By default a "payment" is an actually-PAID entry (paidAt not null, the [from,to] range on
 * paidAt — a date-only bound is a FULL inclusive IST day via istDayRangeFilter). A non-PAID status filter relaxes the
 * not-null floor (bank-rejected rows have paidAt null) and the range bounds attemptedAt instead.
 * Intentionally NO tdsSection filter — that is the TDS report's job and would drop every incentive/standard payment.
 */
export function paymentsWhere(f: PaymentsFilter): Prisma.CreditPayoutEntryWhereInput {
  const range = istDayRangeFilter(f.from ?? undefined, f.to ?? undefined);
  const where: Prisma.CreditPayoutEntryWhereInput = {};
  if (f.clientId) where.clientId = f.clientId;
  if (f.status) where.status = f.status;
  if (isNonPaidStatus(f)) {
    if (range?.gte || range?.lte) {
      const attemptedAt: Prisma.DateTimeNullableFilter = {};
      if (range.gte) attemptedAt.gte = range.gte;
      if (range.lte) attemptedAt.lte = range.lte;
      where.attemptedAt = attemptedAt;
    }
  } else {
    const paidAt: Prisma.DateTimeNullableFilter = { not: null };
    if (range?.gte) paidAt.gte = range.gte;
    if (range?.lte) paidAt.lte = range.lte;
    where.paidAt = paidAt;
  }
  return where;
}

/**
 * A TOTAL order (ends in the unique `id`), so OFFSET pages never overlap or skip a row when many entries share a
 * paidAt (bulk UTR uploads stamp hundreds of rows with the same instant) — identical for the screen and the export.
 * Default/PAID: newest payment first. Non-PAID: newest attempt first, rows without an attempt date last.
 */
export function paymentsOrderBy(f: PaymentsFilter): Prisma.CreditPayoutEntryOrderByWithRelationInput[] {
  return isNonPaidStatus(f)
    ? [{ attemptedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }]
    : [{ paidAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
}

/**
 * B-L6: a payout whose WHOLE amount was withheld as TDS is settled PAID by the bank-file run itself with the
 * internal reference `TDS-WITHHELD-<downloadCode>` — that is NOT a bank UTR. The screen and the export show
 * this label instead (and never the internal reference).
 */
export const TDS_WITHHELD_UTR_PREFIX = 'TDS-WITHHELD-';
export const SETTLED_BY_TDS_LABEL = 'Settled by TDS withholding (no bank payment)';
export function isSettledByTds(utr: string | null | undefined): boolean {
  return !!utr && utr.startsWith(TDS_WITHHELD_UTR_PREFIX);
}

/** The per-row columns both the screen and the export read (relations are batched into the same query). */
export const PAYMENT_ENTRY_SELECT = {
  id: true,
  clientId: true,
  outletId: true, // the outlet CODE (join key), not the PK
  outletName: true,
  fieldName: true,
  period: true,
  amountPaise: true,
  narration: true,
  status: true,
  utr: true,
  paidAt: true,
  attemptedAt: true,
  failureReason: true,
  tdsSection: true,
  tdsMethodology: true,
  tdsDeductedPaise: true,
  download: { select: { downloadCode: true, groupType: true } },
  autoInvoice: { select: { invoiceNumber: true } },
} satisfies Prisma.CreditPayoutEntrySelect;

/**
 * Off-portal payments register (owner 2026-11-25) — payments made OUTSIDE the portal in the same range / tenant. They
 * are not CreditPayoutEntry rows, so they never enter the paged rows / totals above (which stay byte-identical); the
 * screen shows them as a separate card and the export as a separate "Off-portal payments" sheet. A non-PAID status
 * filter (FAILED / REVERSED audit view) has no off-portal rows → null. Voided entries are excluded.
 */
export function offPortalWhere(f: PaymentsFilter): Prisma.OffPortalPaymentWhereInput | null {
  if (isNonPaidStatus(f)) return null;
  const range = istDayRangeFilter(f.from ?? undefined, f.to ?? undefined);
  const where: Prisma.OffPortalPaymentWhereInput = { voidedAt: null };
  if (f.clientId) where.clientId = f.clientId;
  if (range) where.paymentDate = range;
  return where;
}

export async function offPortalTotals(
  // Optional only so narrow unit-test fakes keep working; PrismaService / a tx client always has it.
  prisma: { offPortalPayment?: { aggregate: Prisma.OffPortalPaymentDelegate['aggregate'] } },
  where: Prisma.OffPortalPaymentWhereInput | null,
): Promise<{ count: number; amountPaise: bigint }> {
  if (!where || !prisma.offPortalPayment) return { count: 0, amountPaise: 0n };
  const agg = await prisma.offPortalPayment.aggregate({ where, _count: { _all: true }, _sum: { amountPaise: true } });
  return { count: agg._count?._all ?? 0, amountPaise: agg._sum?.amountPaise ?? 0n };
}

export interface PaymentsTotals {
  count: number;
  amountPaise: bigint;
  tdsDeductedPaise: bigint;
}

/** Minimal delegate shape so the same call works on PrismaService and an interactive-transaction client. */
interface AggregateDelegate {
  creditPayoutEntry: { aggregate: Prisma.CreditPayoutEntryDelegate['aggregate'] };
}

/**
 * Totals over EVERY matching entry, computed IN THE DATABASE (one `SELECT count(*), sum(amountPaise),
 * sum(tdsDeductedPaise) … WHERE <same filter>`), never by summing loaded rows — so they are right for the whole
 * range whatever page is on screen, and the export's Summary sheet (same call, same WHERE) equals the screen.
 */
export async function paymentsTotals(prisma: AggregateDelegate, where: Prisma.CreditPayoutEntryWhereInput): Promise<PaymentsTotals> {
  const agg = await prisma.creditPayoutEntry.aggregate({
    where,
    _count: { _all: true },
    _sum: { amountPaise: true, tdsDeductedPaise: true },
  });
  return {
    count: agg._count?._all ?? 0,
    amountPaise: agg._sum?.amountPaise ?? 0n,
    tdsDeductedPaise: agg._sum?.tdsDeductedPaise ?? 0n,
  };
}
