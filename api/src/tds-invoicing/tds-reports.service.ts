import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildXlsx } from '../common/xlsx';

/**
 * Visibility-payout TDS reports service — Wave 1 Stream C, §6.
 *
 * Three read-only reports (JSON + .xlsx), all money in integer paise (BigInt), serialised to
 * strings for JSON with a rupee mirror for display; the .xlsx builder (buildXlsx) runs every
 * string cell through cellSafe (formula-injection guard) at the serialisation boundary.
 *
 *   1. payoutReport       — visibility-stream payout rows with each outlet's GST registration
 *                           type + the FROZEN tdsSection / tdsMethodology (stamped at confirm).
 *   2. unregisteredReport — invoices/payouts to UNREGISTERED retailers WITH invoice numbers, so
 *                           TGSL computes RCM off-portal (D6). GIFSY-only.
 *   3. recoveryReport     — TdsRecoveryEntry rows ("in lieu of TDS deduction", GROSS_UP pro-rata
 *                           tenant recovery/attribution) + a liability summary.
 *
 * SCOPING IS THE CALLER'S RESPONSIBILITY: the controller resolves `clientId` from the JWT
 * (CLIENT_ADMIN pinned to their own tenant; GIFSY_ADMIN platform-wide or ?clientId=) and passes
 * it here. An undefined clientId means platform-wide (GIFSY only).
 */

export interface ReportScope {
  /** undefined = platform-wide (GIFSY); a value = single-tenant scope. */
  clientId?: string;
  period?: string;
  fy?: string;
}

@Injectable()
export class TdsReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private money(paise: bigint): { paise: string; inr: number } {
    return { paise: paise.toString(), inr: Number(paise) / 100 };
  }

  private inr(paise: bigint): number {
    return Number(paise) / 100;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. PAYOUT REPORT — GST reg type + frozen TDS treatment
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Visibility-stream payout rows (those stamped with a frozen tdsSection at confirm) enriched
   * with the outlet's GST registration type + entity type from ChannelPartner. Legacy/incentive
   * payouts (tdsSection null) are excluded — this is the TDS-regime payout report.
   */
  async payoutReport(scope: ReportScope) {
    const where: Prisma.CreditPayoutEntryWhereInput = {
      // Only entries stamped under the visibility-payout TDS regime carry a frozen section.
      tdsSection: { not: null },
    };
    if (scope.clientId) where.clientId = scope.clientId;
    if (scope.period) where.period = scope.period;

    const entries = await this.prisma.creditPayoutEntry.findMany({
      where,
      orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
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
        autoInvoiceId: true,
        autoInvoice: { select: { invoiceNumber: true } },
      },
    });

    // Enrich with partner GST reg type / entity type (one findMany, no N+1). FIX-E:
    // CreditPayoutEntry.outletId is the outlet CODE (not the PK), so the join is by outletCode
    // scoped by clientId (mirrors credits.service / tds.service) — the old id-based join never
    // matched and left every enriched column blank.
    const outletCodes = [...new Set(entries.map((e) => e.outletId))];
    const outlets = outletCodes.length
      ? await this.prisma.outlet.findMany({
          where: {
            outletCode: { in: outletCodes },
            ...(scope.clientId ? { clientId: scope.clientId } : {}),
          },
          select: {
            clientId: true,
            outletCode: true,
            partner: {
              select: {
                gstRegistrationType: true,
                entityType: true,
                panNumber: true,
                businessName: true,
              },
            },
          },
        })
      : [];
    const outletMap = new Map(outlets.map((o) => [`${o.clientId}|${o.outletCode}`, o]));

    const rows = entries.map((e) => {
      const o = outletMap.get(`${e.clientId}|${e.outletId}`);
      return {
        clientId: e.clientId,
        outletCode: e.outletId,
        outletName: e.outletName,
        businessName: o?.partner?.businessName ?? null,
        panNumber: o?.partner?.panNumber ?? null,
        gstRegistrationType: o?.partner?.gstRegistrationType ?? null,
        entityType: o?.partner?.entityType ?? null,
        fieldName: e.fieldName,
        period: e.period,
        amount: this.money(e.amountPaise),
        tdsSection: e.tdsSection,
        tdsMethodology: e.tdsMethodology,
        tdsDeducted: this.money(e.tdsDeductedPaise),
        invoiceNumber: e.autoInvoice?.invoiceNumber ?? null,
      };
    });

    const totalAmountPaise = entries.reduce((s, e) => s + e.amountPaise, 0n);
    const totalTdsDeductedPaise = entries.reduce((s, e) => s + e.tdsDeductedPaise, 0n);

    return {
      scope: { clientId: scope.clientId ?? null, period: scope.period ?? null },
      count: rows.length,
      totals: {
        amount: this.money(totalAmountPaise),
        tdsDeducted: this.money(totalTdsDeductedPaise),
      },
      rows,
    };
  }

  async payoutReportXlsx(scope: ReportScope): Promise<{ buffer: Buffer; filename: string }> {
    const report = await this.payoutReport(scope);
    const sheetRows = report.rows.map((r, i) => ({
      'S.No': i + 1,
      'Client': r.clientId,
      'Outlet Code': r.outletCode ?? '',
      'Outlet Name': r.outletName,
      'Business Name': r.businessName ?? '',
      'PAN': r.panNumber ?? '',
      'GST Reg Type': r.gstRegistrationType ?? '',
      'Entity Type': r.entityType ?? '',
      'Payout Field': r.fieldName,
      'Period': r.period,
      'Amount (₹)': r.amount.inr,
      'TDS Section': r.tdsSection ?? '',
      'TDS Methodology': r.tdsMethodology ?? '',
      'TDS Deducted (₹)': r.tdsDeducted.inr,
      'Invoice No.': r.invoiceNumber ?? '',
    }));
    const summaryRows = [
      { Metric: 'Rows', Value: report.count },
      { Metric: 'Total Amount (₹)', Value: report.totals.amount.inr },
      { Metric: 'Total TDS Deducted (₹)', Value: report.totals.tdsDeducted.inr },
    ];
    const buffer = buildXlsx([
      { name: 'Payouts', rows: sheetRows },
      { name: 'Summary', rows: summaryRows },
    ]);
    const suffix = scope.clientId ? scope.clientId : 'all';
    return { buffer, filename: `payout-report-${suffix}.xlsx` };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. UNREGISTERED-RETAILER / RCM REPORT — invoice numbers (GIFSY-only)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Invoices raised to UNREGISTERED retailers, WITH invoice numbers, so TGSL computes the RCM
   * liability off-portal (D6). No GST is charged on these invoices; the report is the RCM source.
   * Filtered in-app by the partner's gstRegistrationType (AutoInvoice has no partner relation).
   */
  async unregisteredReport(scope: ReportScope) {
    const where: Prisma.AutoInvoiceWhereInput = {};
    if (scope.clientId) where.clientId = scope.clientId;
    if (scope.period) where.period = scope.period;

    const invoices = await this.prisma.autoInvoice.findMany({
      where,
      orderBy: [{ period: 'desc' }, { invoiceDate: 'desc' }],
      select: {
        id: true,
        clientId: true,
        invoiceNumber: true,
        partnerId: true,
        outletCode: true,
        period: true,
        invoiceDate: true,
        invoiceKind: true,
        subtotalPaise: true,
        gstPaise: true,
        totalPaise: true,
      },
    });

    // Resolve each invoice's partner GST registration type, then keep only UNREGISTERED.
    const partnerIds = [...new Set(invoices.map((inv) => inv.partnerId))];
    const partners = partnerIds.length
      ? await this.prisma.channelPartner.findMany({
          where: { id: { in: partnerIds } },
          select: {
            id: true,
            gstRegistrationType: true,
            businessName: true,
            ownerName: true,
            panNumber: true,
          },
        })
      : [];
    const partnerMap = new Map(partners.map((p) => [p.id, p]));

    const unregistered = invoices.filter(
      (inv) => partnerMap.get(inv.partnerId)?.gstRegistrationType === 'UNREGISTERED',
    );

    const rows = unregistered.map((inv) => {
      const p = partnerMap.get(inv.partnerId);
      return {
        clientId: inv.clientId,
        invoiceNumber: inv.invoiceNumber,
        invoiceKind: inv.invoiceKind,
        partnerId: inv.partnerId,
        businessName: p?.businessName ?? null,
        ownerName: p?.ownerName ?? null,
        panNumber: p?.panNumber ?? null,
        outletCode: inv.outletCode,
        period: inv.period,
        invoiceDate: inv.invoiceDate.toISOString(),
        subtotal: this.money(inv.subtotalPaise),
        gst: this.money(inv.gstPaise),
        total: this.money(inv.totalPaise),
      };
    });

    const totalSubtotalPaise = unregistered.reduce((s, inv) => s + inv.subtotalPaise, 0n);

    return {
      scope: { clientId: scope.clientId ?? null, period: scope.period ?? null },
      note: 'RCM is computed off-portal by TGSL from this list (D6).',
      count: rows.length,
      totals: { subtotal: this.money(totalSubtotalPaise) },
      rows,
    };
  }

  async unregisteredReportXlsx(scope: ReportScope): Promise<{ buffer: Buffer; filename: string }> {
    const report = await this.unregisteredReport(scope);
    const sheetRows = report.rows.map((r, i) => ({
      'S.No': i + 1,
      'Client': r.clientId,
      'Invoice No.': r.invoiceNumber,
      'Invoice Kind': r.invoiceKind,
      'Business Name': r.businessName ?? '',
      'Owner Name': r.ownerName ?? '',
      'PAN': r.panNumber ?? '',
      'Outlet Code': r.outletCode,
      'Period': r.period,
      'Invoice Date': r.invoiceDate,
      'Taxable Value (₹)': r.subtotal.inr,
    }));
    const buffer = buildXlsx([{ name: 'Unregistered-RCM', rows: sheetRows }]);
    const suffix = scope.clientId ? scope.clientId : 'all';
    return { buffer, filename: `unregistered-rcm-report-${suffix}.xlsx` };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. TDS LIABILITY + TENANT-WISE RECOVERY / ATTRIBUTION REPORT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * TdsRecoveryEntry rows ("in lieu of TDS deduction") — the GROSS_UP pro-rata tenant recovery
   * ledger. Dashboard/report only (never on the invoice face — D11). Scoped by clientId (a tenant
   * sees only its own recovery liability; GIFSY sees all or one tenant) + optional FY.
   */
  async recoveryReport(scope: ReportScope) {
    const where: Prisma.TdsRecoveryEntryWhereInput = {};
    if (scope.clientId) where.clientId = scope.clientId;
    if (scope.fy) where.fyLabel = scope.fy;

    const entries = await this.prisma.tdsRecoveryEntry.findMany({
      where,
      orderBy: [{ fyLabel: 'desc' }, { createdAt: 'desc' }],
    });

    // FIX-9/FIX-B: no-PAN visibility recovery is written with panNumber='__NO_PAN__:<outletCode>'
    // (no AutoInvoice, no PAN aggregation). The outlet is encoded into panNumber (TdsRecoveryEntry
    // has no outletCode column) so the recovery telescopes per (clientId, outlet, FY). Flag those
    // rows (startsWith prefix) + subtotal them so the CA sees the tenant's no-PAN obligation, now
    // with per-outlet visibility in the panNumber cell.
    const NO_PAN = '__NO_PAN__';
    const rows = entries.map((e) => ({
      clientId: e.clientId,
      panNumber: e.panNumber,
      isNoPan: e.panNumber.startsWith(NO_PAN),
      section: e.section,
      fyLabel: e.fyLabel,
      tdsInvoiceId: e.tdsInvoiceId,
      panTdsTotal: this.money(e.panTdsTotalPaise),
      tenantBase: this.money(e.tenantBasePaise),
      panBase: this.money(e.panBasePaise),
      tenantShare: this.money(e.tenantSharePaise),
      createdAt: e.createdAt.toISOString(),
    }));

    const totalTenantSharePaise = entries.reduce((s, e) => s + e.tenantSharePaise, 0n);
    const noPanTenantSharePaise = entries
      .filter((e) => e.panNumber.startsWith(NO_PAN))
      .reduce((s, e) => s + e.tenantSharePaise, 0n);

    return {
      label: 'in lieu of TDS deduction',
      scope: { clientId: scope.clientId ?? null, fy: scope.fy ?? null },
      count: rows.length,
      totals: {
        tenantShare: this.money(totalTenantSharePaise),
        noPanTenantShare: this.money(noPanTenantSharePaise),
      },
      rows,
    };
  }

  async recoveryReportXlsx(scope: ReportScope): Promise<{ buffer: Buffer; filename: string }> {
    const report = await this.recoveryReport(scope);
    const sheetRows = report.rows.map((r, i) => ({
      'S.No': i + 1,
      'Client': r.clientId,
      'PAN': r.panNumber,
      'No PAN?': r.isNoPan ? 'Y' : 'N',
      'Section': r.section,
      'FY': r.fyLabel,
      'PAN TDS Total (₹)': r.panTdsTotal.inr,
      'Tenant Base (₹)': r.tenantBase.inr,
      'PAN Base (₹)': r.panBase.inr,
      'Tenant Share — in lieu of TDS (₹)': r.tenantShare.inr,
      'TDS Invoice ID': r.tdsInvoiceId ?? '',
      'Recorded At': r.createdAt,
    }));
    const summaryRows = [
      { Metric: 'Rows', Value: report.count },
      { Metric: 'Total Tenant Share — in lieu of TDS (₹)', Value: report.totals.tenantShare.inr },
      { Metric: 'No-PAN Tenant Share — in lieu of TDS (₹)', Value: report.totals.noPanTenantShare.inr },
    ];
    const buffer = buildXlsx([
      { name: 'Recovery', rows: sheetRows },
      { name: 'Summary', rows: summaryRows },
    ]);
    const suffix = scope.clientId ? scope.clientId : 'all';
    return { buffer, filename: `tds-recovery-report-${suffix}.xlsx` };
  }
}
