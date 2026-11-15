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
  const where: Prisma.CreditPayoutEntryWhereInput = { tdsSection: { not: null } };
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
