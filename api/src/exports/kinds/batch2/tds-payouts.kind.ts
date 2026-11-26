/**
 * Visibility-payout TDS report — GET /v1/admin/tds-reports/payouts/export as an export kind (Downloads page design).
 * Output identical to the old TdsReportsService.payoutReportXlsx: sheet "Payouts" (S.No … Invoice No.) + sheet
 * "Summary" (Rows / Total Amount / Total TDS Deducted).
 *
 * Paging: CreditPayoutEntry rows stamped with a frozen tdsSection, ordered period ↓, createdAt ↓ (id ↓ as the keyset
 * tiebreak), ≤ 2,000 per read; each page's partner join (outlet by clientId|code) covers that page's codes only. The
 * Summary totals are summed in BigInt paise while streaming (bounded: two counters), so no row is held.
 *
 * Scope exactly as the endpoint: a CLIENT_ADMIN / assumed operator is pinned to their tenant (any ?clientId= ignored);
 * an un-assumed GIFSY_ADMIN may pass ?clientId= or omit it for platform-wide.
 */
import type { Prisma } from '@prisma/client';
import { platformWide } from '../../../common/tenant-scope';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { PayoutReportQueryDto } from '../../../tds-invoicing/dto/tds-reports.dto';
import { TdsReportsService } from '../../../tds-invoicing/tds-reports.service';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { JsonSheet, keysetPages, monthWords, parseQueryDto } from './kind-support';

export interface TdsPayoutsParams {
  /** The resolved tenant scope at request time (null = platform-wide, un-assumed GIFSY_ADMIN only). */
  clientId: string | null;
  period: string | null;
}

/** Same rule as TdsReportsController.resolveClientId. */
function scopeOf(user: JwtPayload, requested: string | null | undefined): string | null {
  return platformWide(user) ? (requested ?? null) : user.clientId;
}

const inr = (paise: bigint) => Number(paise) / 100;

async function run(ctx: ExportRunContext, p: TdsPayoutsParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const clientId = scopeOf(ctx.user, p.clientId);
  // Cancelled payouts (owner 2026-11-25) were never paid and carry no TDS — same rule as the on-screen report.
  const where: Prisma.CreditPayoutEntryWhereInput = { tdsSection: { not: null }, status: { not: 'CANCELLED' } };
  if (clientId) where.clientId = clientId;
  if (p.period) where.period = p.period;

  const sheet = new JsonSheet(out, 'Payouts');
  let sno = 0;
  let totalAmount = 0n;
  let totalTds = 0n;
  for await (const entries of keysetPages((page) =>
    ctx.prisma.creditPayoutEntry.findMany({
      where,
      orderBy: [{ period: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        clientId: true,
        outletId: true,
        outletName: true,
        fieldName: true,
        period: true,
        amountPaise: true,
        tdsSection: true,
        tdsMethodology: true,
        tdsDeductedPaise: true,
        autoInvoice: { select: { invoiceNumber: true } },
      },
      ...page,
    }),
  )) {
    // CreditPayoutEntry.outletId is the outlet CODE → join by (clientId, outletCode), this page's codes only.
    const codes = [...new Set(entries.map((e) => e.outletId))];
    const outlets = await ctx.prisma.outlet.findMany({
      where: { outletCode: { in: codes }, ...(clientId ? { clientId } : {}) },
      select: {
        clientId: true,
        outletCode: true,
        partner: { select: { gstRegistrationType: true, entityType: true, panNumber: true, businessName: true } },
      },
    });
    const byKey = new Map(outlets.map((o) => [`${o.clientId}|${o.outletCode}`, o]));
    for (const e of entries) {
      const o = byKey.get(`${e.clientId}|${e.outletId}`);
      totalAmount += e.amountPaise;
      totalTds += e.tdsDeductedPaise;
      await sheet.add({
        'S.No': ++sno,
        Client: e.clientId,
        'Outlet Code': e.outletId ?? '',
        'Outlet Name': e.outletName,
        'Business Name': o?.partner?.businessName ?? '',
        PAN: o?.partner?.panNumber ?? '',
        'GST Reg Type': o?.partner?.gstRegistrationType ?? '',
        'Entity Type': o?.partner?.entityType ?? '',
        'Payout Field': e.fieldName,
        Period: e.period,
        'Amount (₹)': inr(e.amountPaise),
        'TDS Section': e.tdsSection ?? '',
        'TDS Methodology': e.tdsMethodology ?? '',
        'TDS Deducted (₹)': inr(e.tdsDeductedPaise),
        'Invoice No.': e.autoInvoice?.invoiceNumber ?? '',
      });
    }
  }
  const rowCount = await sheet.end();

  const summary = new JsonSheet(out, 'Summary');
  await summary.add({ Metric: 'Rows', Value: sno });
  await summary.add({ Metric: 'Total Amount (₹)', Value: inr(totalAmount) });
  await summary.add({ Metric: 'Total TDS Deducted (₹)', Value: inr(totalTds) });
  await summary.end();

  // Policy round B (WALLET-REVERSAL-ENGINE-DESIGN.md §8.1): TDS credits from reversed PAID payouts — created, applied
  // to later payouts, outstanding. A SEPARATE sheet, written only when the scope has any credit, so the "Payouts" and
  // "Summary" sheets stay byte-identical to the old builder (parity) and a tenant without credits gets the same file.
  const credits = await new TdsReportsService(ctx.prisma as never).tdsCreditSection(ctx.prisma as never, {
    ...(clientId ? { clientId } : {}),
    ...(p.period ? { period: p.period } : {}),
  });
  if (credits.count > 0) {
    const sheetC = new JsonSheet(out, 'TDS Credits');
    for (const c of credits.rows) {
      await sheetC.add({
        Line: 'Credit created',
        Client: c.clientId,
        PAN: c.panNumber,
        Section: c.section,
        FY: c.fyLabel,
        'Credit ID': c.creditId,
        'Outlet Code': c.sourceOutletCode ?? '',
        'Outlet Name': c.sourceOutletName ?? '',
        Period: c.sourcePeriod ?? '',
        'Amount (₹)': c.credit.inr,
        'Applied (₹)': c.applied.inr,
        'Outstanding (₹)': c.outstanding.inr,
        Date: c.createdAt,
        // Fix round B: the credit's scope (L2), D2 "unused … not carried forward" and L6 previous-PAN call-outs.
        Note: [
          `TDS withheld on the reversed PAID payout ${c.sourceEntryId ?? ''} (payout ${c.sourceAmount.inr}) stays deposited — carried forward on this PAN`,
          c.scopeNote,
          c.unusedNote,
          c.previousPanNote,
        ].filter(Boolean).join(' · '),
      });
      for (const a of c.applications) {
        await sheetC.add({
          Line: a.released ? 'Applied — released' : 'Applied',
          Client: c.clientId,
          PAN: c.panNumber,
          Section: c.section,
          FY: c.fyLabel,
          'Credit ID': c.creditId,
          'Outlet Code': a.outletCode ?? '',
          'Outlet Name': a.outletName ?? '',
          Period: a.period ?? '',
          'Amount (₹)': a.amount.inr,
          'Applied (₹)': '',
          'Outstanding (₹)': '',
          Date: a.released ? (a.releasedAt ?? '') : a.appliedAt,
          Note: a.note,
        });
      }
    }
    await sheetC.add({ Line: 'TOTAL created', 'Amount (₹)': credits.totals.created.inr });
    await sheetC.add({ Line: 'TOTAL applied', 'Amount (₹)': credits.totals.applied.inr });
    await sheetC.add({ Line: 'TOTAL outstanding', 'Amount (₹)': credits.totals.outstanding.inr });
    await sheetC.end();
  }
  return { rowCount };
}

export const TDS_PAYOUTS_KIND: ExportKindDef<TdsPayoutsParams> = {
  kind: 'tds-payouts',
  label: 'TDS payout report',
  // Same as GET admin/tds-reports/payouts/export (@Roles only, no @RequirePermission).
  access: { roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'] },
  parseParams(raw: unknown, user: JwtPayload) {
    const q = parseQueryDto(PayoutReportQueryDto, raw);
    return { clientId: scopeOf(user, q.clientId), period: q.period ?? null };
  },
  // One tenant × one period ≈ one row per outlet (≈ 6.5k at Bajaj) streams instantly; every period (the whole payout
  // history, 48k+ rows and growing) or all tenants is prepared in the background.
  isHeavy: (p) => !p.period || !p.clientId,
  describeParams: (p) => `${p.period ? monthWords(p.period) : 'All periods'} · ${p.clientId ?? 'All tenants'}`,
  fileName: (p) => `payout-report-${p.clientId ? p.clientId : 'all'}.xlsx`,
  run,
};
