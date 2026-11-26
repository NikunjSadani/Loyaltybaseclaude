/**
 * Export kind 'fund-reconciliation' — the Excel "Fund reconciliation" (FUND-RECONCILIATION-DESIGN.md §4), served by
 * GET /v1/fund/export through the Downloads mechanism (ExportsService.respond). Sheets: Summary · Statement ·
 * Receipts · Rates · About. Same engine as the screen (fund-sources.loader + fund-statement.engine), so the file
 * and the screen can never disagree. Prisma-only (no DI) → runs unchanged in the exports worker.
 *
 * Scope: ctx.clientId (the requester's assumed tenant) — never a param. Roles exactly as the endpoint.
 */
import { BadRequestException } from '@nestjs/common';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { REPORTS_CLIENT_ID } from '../common/report-recipients';
import { formatDateIST, istDateKey } from '../common/ist-date';
import type { AnyExportKind, ExportKindDef, ExportRunContext } from '../exports/export-kinds';
import type { XlsxStreamWriter } from '../common/xlsx-stream';
import { JsonSheet, parseQueryDto } from '../exports/kinds/batch2/kind-support';
import { FundExportQueryDto } from './dto/fund.dto';
import { loadFundInputs } from './fund-sources.loader';
import { bpsLabel, FUND_SPEND_TYPE_LABEL, periodSummary } from './fund-statement.engine';
import { statementOf } from './fund-statement-of';
import { istDayStart } from './fund-day';

export const FUND_RECONCILIATION_KIND_ID = 'fund-reconciliation';

export interface FundReconciliationParams {
  from: string | null;
  to: string | null;
}

const inr = (p: bigint | number) => Number(p) / 100;
const d = (x: Date | null | undefined) => (x ? formatDateIST(x) : '');

const EVENT_WORDS = { OPENING: 'Opening balance', RECEIPT: 'Advance received', ADJUSTMENT: 'Adjustment', CHARGE: 'Charge', RETURN: 'Return', RATE_CHANGE: 'Rate change (information)' } as const;
const STATUS_WORDS = { COMMITTED: 'Committed', PAID: 'Paid', RETURNED: 'Returned' } as const;
const FLAG_WORDS: Record<string, string> = {
  NO_ITEM_RATE: 'No discount set for this voucher item — charged at face value',
  NO_FEE_RATE: 'No agency fee set — no fee charged',
  HUBBLE_NEEDS_RECONCILE: 'Voucher provider has not confirmed the outcome yet — counted as committed',
  DATE_ESTIMATED: 'The source record has no date for this step — a return is shown on its commit day; a paid date is left blank',
  TDS_INCLUDES_EARLIER: 'Includes TDS for earlier payouts this year — yearly limit crossed',
  TDS_RUN_UNMATCHED: 'An older TDS entry whose bank run could not be identified — charged in full on the day recorded, shown as paid',
  TDS_OTHER_CLIENT_RUN: "Recovered with a payout run outside this client's statement (PAN shared with another client)",
  TDS_PAYOUTS_REVERSED: 'Payouts reversed — the TDS stays deposited (not given back)',
  FAILED_AWAITING_REBANK: 'Failed at the bank — awaiting re-bank (still committed)',
  PAYOUT_CANCELLED: 'Cancelled by Gifsy before payment — not charged (returned on the cancel day)',
  FACE_RECOMPUTED: 'Face value re-derived from the order (its value was cleared by the refund)',
  FACE_UNKNOWN: 'Face value unknown — ₹0 charged; check the order',
};

async function run(ctx: ExportRunContext, p: FundReconciliationParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const clientId = ctx.clientId;
  const inputs = await loadFundInputs(ctx.prisma, clientId);
  const stmt = statementOf(inputs);
  const from = p.from ? istDayStart(p.from) : null;
  const to = p.to ? new Date(istDayStart(p.to).getTime() + 24 * 3600_000) : null;
  const ps = periodSummary(stmt, from, to);
  const settings = await ctx.prisma.fundSettings.findUnique({ where: { clientId } });
  const t = stmt.totals;
  let rows = 0;

  // ── Summary ──
  const sum = new JsonSheet(out, 'Summary');
  const S = (Section: string, Item: string, amount: number | string | null, Count: number | string = '', Note = '') =>
    sum.add({ Section, Item, Count, 'Amount (₹)': amount, Note });
  const periodLabel = `${p.from ? formatDateIST(from!) : 'Start'} → ${p.to ? formatDateIST(istDayStart(p.to)) : 'Today'}`;
  await S('Report', 'Client', clientId);
  await S('Report', 'Period', periodLabel);
  await S('Report', 'Generated', formatDateIST(ctx.now), '', 'Dates are India time (IST).');
  await S('Report', 'Opening balance date', stmt.openingDate ? formatDateIST(stmt.openingDate) : 'Not recorded', '', stmt.openingDate ? 'Spend committed before this date is ignored.' : 'No opening balance — all history is counted.');
  await S('Period', 'Balance at the start of the period', inr(ps.openingBalancePaise));
  if (ps.openingEntryPaise !== 0n) await S('Period', 'Opening balance recorded in the period', inr(ps.openingEntryPaise));
  await S('Period', 'Advances received', inr(ps.receiptsPaise));
  await S('Period', 'Adjustments', inr(ps.adjustmentsPaise));
  await S('Period', 'Charges (spend committed in the period)', -inr(ps.chargesPaise));
  await S('Period', 'Returns (credited back in the period)', inr(ps.returnsPaise));
  await S('Period', 'Balance at the end of the period', inr(ps.closingBalancePaise));
  for (const b of ps.byType) {
    await S('Period by spend type', `${FUND_SPEND_TYPE_LABEL[b.type]} — charges`, -inr(b.chargesPaise), b.count, `face ₹${inr(b.facePaise)} · discount ₹${inr(b.discountPaise)} · fee ₹${inr(b.feePaise)}`);
    if (b.returnsPaise !== 0n) await S('Period by spend type', `${FUND_SPEND_TYPE_LABEL[b.type]} — returns`, inr(b.returnsPaise));
  }
  await S('Today (all time)', 'Opening balance', inr(t.openingPaise));
  await S('Today (all time)', 'Advances received', inr(t.receiptsPaise));
  await S('Today (all time)', 'Adjustments', inr(t.adjustmentsPaise));
  await S('Today (all time)', 'Committed (not yet paid)', -inr(t.committedPaise));
  await S('Today (all time)', 'Paid out', -inr(t.paidPaise));
  await S('Today (all time)', 'Returned (already credited back)', inr(t.returnedPaise), '', 'Informational — returned items net to zero.');
  await S('Today (all time)', 'Balance (= available)', inr(t.balancePaise));
  if (settings?.lowBalanceThresholdPaise != null) {
    const low = t.balancePaise < settings.lowBalanceThresholdPaise;
    await S('Today (all time)', 'Low-balance threshold', inr(settings.lowBalanceThresholdPaise), '', low ? 'LOW — below the threshold (spend is never blocked)' : '');
  }
  for (const b of stmt.byType) {
    await S('Today by spend type', FUND_SPEND_TYPE_LABEL[b.type], -inr(b.netChargedPaise), b.count, `committed ₹${inr(b.committedPaise)} · paid ₹${inr(b.paidPaise)} · returned ₹${inr(b.returnedPaise)} · discount ₹${inr(b.discountPaise)} · fee ₹${inr(b.feePaise)}`);
  }
  if (stmt.receivables.totalPaise > 0n) {
    await S('To recover', 'Paid payouts later reversed (recover off-platform, then record an adjustment)', inr(stmt.receivables.totalPaise), stmt.receivables.items.length);
  }
  if (stmt.preOpeningReturns.items.length) {
    await S('Check', 'Spend before the opening date returned after it (not credited automatically)', inr(stmt.preOpeningReturns.facePaise), stmt.preOpeningReturns.items.length, stmt.preOpeningReturns.items.map((i) => i.ref).slice(0, 50).join(', '));
  }
  if (stmt.excludedEntries.length) {
    await S('Check', 'Receipts / adjustments dated before the opening date (excluded)', inr(stmt.excludedEntries.reduce((s, e) => s + e.amountPaise, 0n)), stmt.excludedEntries.length, stmt.excludedEntries.map((e) => e.ref).join(', '));
  }
  for (const [flag, count] of Object.entries(stmt.flagCounts)) {
    await S('Check', FLAG_WORDS[flag] ?? flag, null, count ?? 0);
  }
  for (const b of stmt.itemsWithoutRate) await S('Check', `Voucher item without a discount rate: ${b.itemLabel}`, null, b.count);
  rows += await sum.end();

  // ── Statement ── (chronological, the period's lines; running balance over the full history)
  const st = new JsonSheet(out, 'Statement');
  for (const l of stmt.lines) {
    if (from && l.date.getTime() < from.getTime()) continue;
    if (to && l.date.getTime() >= to.getTime()) break;
    await st.add({
      Date: d(l.date),
      Entry: EVENT_WORDS[l.event],
      Type: l.type ? FUND_SPEND_TYPE_LABEL[l.type] : '',
      Reference: l.ref,
      Description: l.description,
      'Voucher item': l.itemLabel ?? '',
      'Face (₹)': l.type ? inr(l.facePaise) : null,
      'Rate': l.rateLabel ?? '',
      'Discount (₹)': l.type ? inr(l.discountPaise) : null,
      'Agency fee (₹)': l.type ? inr(l.feePaise) : null,
      'TDS (₹)': l.type === 'TDS_194C' ? inr(l.tdsPaise) : null,
      'Charged (₹)': l.type ? inr(l.chargedPaise) : null,
      'Amount (₹)': inr(l.amountPaise),
      'Balance (₹)': inr(l.balancePaise),
      Status: l.status ? STATUS_WORDS[l.status] : '',
      Committed: d(l.committedAt),
      Paid: d(l.paidAt),
      Returned: d(l.returnedAt),
      UTR: l.utr ?? '',
      'To recover (₹)': l.receivablePaise > 0n ? inr(l.receivablePaise) : null,
      Flags: l.flags.map((f) => FLAG_WORDS[f] ?? f).join('; '),
    });
  }
  rows += await st.end();

  // ── Receipts ──
  const rc = new JsonSheet(out, 'Receipts');
  for (const e of inputs.entryRows) {
    await rc.add({
      Number: e.receiptNumber,
      Type: e.entryType === 'OPENING_BALANCE' ? 'Opening balance' : e.entryType === 'ADJUSTMENT' ? 'Adjustment' : 'Advance received',
      Date: d(e.receivedAt),
      'Amount (₹)': inr(e.amountPaise),
      'UTR / reference': e.referenceNumber ?? '',
      Bank: e.bankName ?? '',
      Mode: e.paymentMode,
      'Reason / note': e.reason ?? e.notes ?? '',
      'Recorded at': d(e.createdAt),
    });
  }
  rows += await rc.end();

  // ── Rates ──
  const rt = new JsonSheet(out, 'Rates');
  for (const r of inputs.rateRows) {
    await rt.add({
      Rate: r.kind === 'AGENCY_FEE' ? 'Agency fee' : 'Voucher discount',
      'Voucher item': r.rewardLabel ?? '',
      'Fee type': r.kind === 'AGENCY_FEE' ? (r.feeType === 'FLAT' ? 'Flat ₹ per payout' : '% of payout') : '',
      Value: r.feeType === 'FLAT' ? `₹${inr(r.flatPaise ?? 0n)}` : r.rateBps != null ? bpsLabel(r.rateBps) : '',
      'Effective from': d(r.effectiveFrom),
      Note: r.note ?? '',
      'Back-dated: lines re-priced': r.repricedLines ?? '',
      'Back-dated: balance change (₹)': r.repriceDeltaPaise != null ? inr(r.repriceDeltaPaise) : '',
      'Recorded at': d(r.createdAt),
    });
  }
  rows += await rt.end();

  // ── About ──
  const ab = new JsonSheet(out, 'About');
  const A = (Figure: string, Meaning: string) => ab.add({ Figure, Meaning });
  await A('Balance', 'Opening balance + advances received ± adjustments − everything committed or paid. It already deducts committed spend, so Balance = Available.');
  await A('Committed', 'Spend approved but not yet paid: a voucher ordered (points debited), a cash redemption confirmed, or a payout batch confirmed.');
  await A('Paid', 'Voucher code issued (delivered), or the bank UTR recorded as paid.');
  await A('Returned', 'Spend that came back: a voucher failed / cancelled / returned with a refund, a cash payout failed, or a payout reversed before payment. A return line credits the same amount the charge took, so a returned item nets to zero.');
  await A('Vouchers', 'Face value minus the client\'s discount % for that voucher item, at the rate in force on the order date. An item with no rate is charged at face value and flagged.');
  await A('Cash redemptions / target payouts / visibility payouts', 'Face value plus the agency fee (% of the payout or a flat ₹ per payout line), at the fee in force on the commit date. No fee set → no fee, flagged.');
  await A('TDS 194C', 'What Gifsy actually pays as 194C TDS on top of payouts (gross-up, or a no-PAN payout paid in full), recovered from this client — in full, dated with the bank run it was recorded with, one line per TDS amount. TDS recorded since 24 Nov 2026 stores its bank run, so its line never moves; an older line can move if one of its payouts is later re-banked. The first TDS line of the year for a PAN notes when it includes TDS for earlier payouts (yearly limit crossed). TDS is never returned: TDS on a reversed payout stays deposited. It is absorbed only if the same PAN/outlet gets more 194C payouts later in the same financial year; otherwise it is not recovered. A negative true-up is a credit on the day it was recorded. TDS recorded before the opening date is excluded.');
  await A('Not on this statement', 'Points credits (money leaves only when points are redeemed), physical gifts, Voucher Dispersal campaigns, GST held back on visibility payouts, 194R TDS (paid by the client) and DEDUCT-method TDS (part of the gross award). No GST is charged on the portal.');
  await A('To recover', 'A payout already paid and later reversed. The money is with the outlet; once Gifsy recovers it, an adjustment credits the advance.');
  await A('Opening balance', 'The balance at the START of its date. Spend committed before that date is inside the opening figure and is ignored.');
  await A('Rates', 'Rates are never edited: a change is a new rate effective from a date. A change dated in the past re-prices the spend already committed from that date; Gifsy confirms the effect first and the statement shows a "Rate change" line with the number of lines re-priced and the balance change.');
  await A('Low balance', 'When the balance is below the client\'s threshold, a banner shows and an e-mail goes to the configured recipients once a day, Monday to Saturday, once an opening balance is recorded. Nothing is ever blocked.');
  rows += await ab.end();

  return { rowCount: rows };
}

export const FUND_RECONCILIATION_KIND: ExportKindDef<FundReconciliationParams> = {
  kind: FUND_RECONCILIATION_KIND_ID,
  label: 'Fund reconciliation',
  // Same as GET /v1/fund/export.
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'payouts:read' },
  parseParams(raw: unknown, user: JwtPayload) {
    if (platformWide(user) || !user.clientId || user.clientId === REPORTS_CLIENT_ID) {
      throw new BadRequestException('Open a client first to download its fund reconciliation.');
    }
    const q = parseQueryDto(FundExportQueryDto, raw);
    if (q.from) istDayStart(q.from);
    if (q.to) istDayStart(q.to);
    if (q.from && q.to && q.from > q.to) throw new BadRequestException('"from" must be on or before "to"');
    return { from: q.from ?? null, to: q.to ?? null };
  },
  // Computed in memory per request exactly like the screen (one client's rows) → streams instantly.
  isHeavy: () => false,
  describeParams: (p) => `${p.from ?? 'Start'} → ${p.to ?? 'today'}`,
  fileName: (p, now) => `fund-reconciliation-${p.from ?? 'start'}-to-${p.to ?? istDateKey(now)}.xlsx`,
  run,
};

export const FUND_EXPORT_KINDS: readonly AnyExportKind[] = [FUND_RECONCILIATION_KIND];
