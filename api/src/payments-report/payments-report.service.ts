import { Injectable } from '@nestjs/common';
import { CreditEntryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { buildXlsx } from '../common/xlsx';
import { istDayRangeFilter, istDateKey } from '../common/ist-date';

/**
 * Payments Report service — a READ-ONLY report of all payout PAYMENTS in a date range, across
 * ALL payout streams (visibility 194C + incentive/standard).
 *
 * Deliberately mirrors the sibling visibility-payout TDS report (tds-reports.service.ts —
 * payoutReport/payoutReportXlsx): same ReportScope idea, same money() BigInt→{paise,inr} helper,
 * same buildXlsx serialisation, and the same "one findMany per entity, no N+1" join discipline
 * (CreditPayoutEntry.outletId is the outlet CODE, so outlets are joined by outletCode scoped by
 * clientId — never the PK).
 *
 * KEY DIFFERENCE FROM THE TDS SIBLING: this report does NOT filter on tdsSection. The TDS report
 * selects only visibility-stream entries (tdsSection not null); filtering it here would silently
 * DROP every incentive/standard payment. Instead we select entries that were ACTUALLY PAID —
 * paidAt is not null — optionally bounded by a [from,to] range and/or a status filter.
 *
 * SCOPING IS THE CALLER'S RESPONSIBILITY: the controller resolves `clientId` from the JWT
 * (CLIENT_ADMIN pinned to their own tenant; GIFSY_ADMIN platform-wide or ?clientId=) and passes
 * it here. An undefined clientId means platform-wide (un-assumed GIFSY only).
 */

export interface PaymentsReportScope {
  /** undefined = platform-wide (un-assumed GIFSY); a value = single-tenant scope. */
  clientId?: string;
  /** Inclusive lower bound on paidAt (ISO string). */
  from?: string;
  /** Inclusive upper bound on paidAt (ISO string). */
  to?: string;
  /** Optional payment-status filter. */
  status?: CreditEntryStatus;
}

/** A tenant-scoped SalesUser node used to build the reporting chain (cycle-safe up-walk). */
interface SalesNode {
  id: string;
  reportingToId: string | null;
  employeeCode: string;
  isActive: boolean;
  user: { name: string | null } | null;
  hierarchyLevel: { code: string } | null;
}

@Injectable()
export class PaymentsReportService {
  /** Hard cap on rows returned/exported — bounds memory (query + in-memory xlsx). Overflow → `truncated`. */
  private static readonly MAX_ROWS = 10000;

  constructor(private readonly prisma: PrismaService) {}

  private money(paise: bigint): { paise: string; inr: number } {
    return { paise: paise.toString(), inr: Number(paise) / 100 };
  }

  /**
   * Walk `reportingToId` UPWARD from the tagged rep to the top of the tree, producing a readable
   * bottom-up chain string like "XSR-M001 (Rep Name) → ASM-002 (Mgr) → RSM-003 (Head)". Cycle-safe
   * (mirrors sales-hierarchy-access.helper) — a self/loop reference stops the walk rather than
   * spinning. Returns null when the start node is unknown.
   */
  private reportingChain(startId: string, nodes: Map<string, SalesNode>): string | null {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current: string | null = startId;
    while (current) {
      if (seen.has(current)) break; // cycle guard
      seen.add(current);
      const n = nodes.get(current);
      if (!n) break; // dangling reference
      const name = n.user?.name ?? '';
      parts.push(name ? `${n.employeeCode} (${name})` : n.employeeCode);
      current = n.reportingToId;
    }
    return parts.length ? parts.join(' → ') : null;
  }

  /**
   * All payout payments (paidAt not null) in the scope's [from,to] range, across ALL streams,
   * enriched (batched, no N+1) with the payout batch header, outlet geography, the owning
   * ChannelPartner, the frozen invoice number, and the outlet's tagged sales rep + full reporting
   * chain.
   */
  async paymentReport(scope: PaymentsReportScope) {
    // paidAt is ALWAYS constrained not-null (a payment is a paid entry); the range narrows further.
    // A date-only from/to (YYYY-MM-DD from <input type="date">) is interpreted as a FULL INCLUSIVE
    // IST day via the shared istDayRangeFilter — otherwise a naive `new Date("YYYY-MM-DD")` (= 05:30
    // IST) skips the first 5.5h of `from` AND truncates almost all of `to` (same trap the roster /
    // gift / reports / payout date filters fix). A full ISO datetime is used as-given.
    const paidAt: Prisma.DateTimeNullableFilter = { not: null };
    const range = istDayRangeFilter(scope.from, scope.to);
    if (range?.gte) paidAt.gte = range.gte;
    if (range?.lte) paidAt.lte = range.lte;

    const where: Prisma.CreditPayoutEntryWhereInput = { paidAt };
    if (scope.clientId) where.clientId = scope.clientId;
    if (scope.status) where.status = scope.status;
    // NOTE: intentionally NO tdsSection filter — that is the TDS report's job and would drop
    // every incentive/standard-stream payment from this cross-stream payments report.

    // Bound the result set: a huge date range (or platform-wide + no filters) could otherwise load
    // every paid entry across all tenants + build the whole xlsx in memory (OOM on a capped pod).
    // Fetch MAX_ROWS+1; if we overflow, flag `truncated` so the caller shows a "narrow the range"
    // banner rather than a silently-partial financial report. take + orderBy return the most-recent.
    const rawEntries = await this.prisma.creditPayoutEntry.findMany({
      where,
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      take: PaymentsReportService.MAX_ROWS + 1,
      select: {
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
        tdsSection: true,
        tdsMethodology: true,
        tdsDeductedPaise: true,
        // Payout header/batch (STANDARD/SEPARATE) via the download relation — batched in this query.
        download: { select: { downloadCode: true, groupType: true } },
        // Frozen invoice number via the AutoInvoice relation — batched in this query.
        autoInvoice: { select: { invoiceNumber: true } },
      },
    });
    const truncated = rawEntries.length > PaymentsReportService.MAX_ROWS;
    const entries = truncated ? rawEntries.slice(0, PaymentsReportService.MAX_ROWS) : rawEntries;

    // ── Outlets by (clientId, outletCode) — ONE findMany, with the partner nested (no N+1). ──
    const outletCodes = [...new Set(entries.map((e) => e.outletId))];
    const outlets = outletCodes.length
      ? await this.prisma.outlet.findMany({
          where: {
            outletCode: { in: outletCodes },
            ...(scope.clientId ? { clientId: scope.clientId } : {}),
          },
          select: {
            id: true,
            clientId: true,
            outletCode: true,
            partnerId: true,
            zone: true,
            state: true,
            city: true,
            partner: {
              select: {
                businessName: true,
                ownerName: true,
                phone: true,
                panNumber: true,
                gstRegistrationType: true,
                entityType: true,
              },
            },
          },
        })
      : [];
    const outletMap = new Map(outlets.map((o) => [`${o.clientId}|${o.outletCode}`, o]));

    // ── Active sales-rep tag per outlet — ONE findMany over the outlet PKs (unassignedAt null). ──
    const outletPks = outlets.map((o) => o.id);
    const assignments = outletPks.length
      ? await this.prisma.salesUserAssignment.findMany({
          where: { outletId: { in: outletPks }, unassignedAt: null },
          // Deterministic "latest active assignment wins" when an outlet has >1 active row,
          // so the chosen rep (and its reporting chain) is stable run-to-run.
          orderBy: { assignedAt: 'desc' },
          select: { outletId: true, salesUserId: true },
        })
      : [];
    const repByOutletPk = new Map<string, string>();
    for (const a of assignments) {
      if (a.outletId && a.salesUserId && !repByOutletPk.has(a.outletId)) {
        repByOutletPk.set(a.outletId, a.salesUserId);
      }
    }

    // ── Tenant SalesUser rows — ONE findMany, then a parent map for the reporting-chain up-walk. ──
    const clientIds = [...new Set(outlets.map((o) => o.clientId))];
    const salesUsers: SalesNode[] = clientIds.length
      ? await this.prisma.salesUser.findMany({
          where: { clientId: { in: clientIds } },
          select: {
            id: true,
            reportingToId: true,
            employeeCode: true,
            isActive: true,
            user: { select: { name: true } },
            hierarchyLevel: { select: { code: true } },
          },
        })
      : [];
    const salesMap = new Map(salesUsers.map((s) => [s.id, s]));

    const rows = entries.map((e) => {
      const o = outletMap.get(`${e.clientId}|${e.outletId}`);
      const repId = o ? repByOutletPk.get(o.id) : undefined;
      const rep = repId ? salesMap.get(repId) : undefined;
      return {
        clientId: e.clientId,
        paymentDate: e.paidAt ? e.paidAt.toISOString() : null,
        outletCode: e.outletId,
        outletName: e.outletName,
        businessName: o?.partner?.businessName ?? null,
        ownerName: o?.partner?.ownerName ?? null,
        zone: o?.zone ?? null,
        state: o?.state ?? null,
        city: o?.city ?? null,
        salesRepCode: rep?.employeeCode ?? null,
        salesRepName: rep?.user?.name ?? null,
        salesRepRole: rep?.hierarchyLevel?.code ?? null,
        reportingChain: rep ? this.reportingChain(rep.id, salesMap) : null,
        amount: this.money(e.amountPaise),
        utr: e.utr ?? null,
        status: e.status,
        payoutHeader: e.download?.downloadCode ?? null,
        groupType: e.download?.groupType ?? null,
        payoutField: e.fieldName,
        remarks: e.narration ?? null,
        period: e.period,
        tdsSection: e.tdsSection,
        tdsMethodology: e.tdsMethodology,
        tdsDeducted: this.money(e.tdsDeductedPaise),
        invoiceNumber: e.autoInvoice?.invoiceNumber ?? null,
        gstRegistrationType: o?.partner?.gstRegistrationType ?? null,
        panNumber: o?.partner?.panNumber ?? null,
        phone: o?.partner?.phone ?? null,
      };
    });

    const totalAmountPaise = entries.reduce((s, e) => s + e.amountPaise, 0n);

    return {
      scope: {
        clientId: scope.clientId ?? null,
        from: scope.from ?? null,
        to: scope.to ?? null,
      },
      count: rows.length,
      totals: { amount: this.money(totalAmountPaise) },
      // `truncated` = the query hit MAX_ROWS; the caller must show a "narrow the date range for a
      // complete report" banner (totals then reflect the shown rows only, not the full range).
      truncated,
      maxRows: PaymentsReportService.MAX_ROWS,
      rows,
    };
  }

  async paymentReportXlsx(
    scope: PaymentsReportScope,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const report = await this.paymentReport(scope);
    const sheetRows = report.rows.map((r, i) => ({
      'S.No': i + 1,
      'Client': r.clientId,
      // Format the stored UTC instant as the IST calendar day (raw ISO would print UTC — off-by-one
      // in the 00:00–05:30 IST window). The JSON envelope keeps raw ISO for the FE to format.
      'Payment Date': r.paymentDate ? istDateKey(new Date(r.paymentDate)) : '',
      'Outlet Code': r.outletCode ?? '',
      'Outlet Name': r.outletName,
      'Business Name': r.businessName ?? '',
      'Owner Name': r.ownerName ?? '',
      'Zone': r.zone ?? '',
      'State': r.state ?? '',
      'City': r.city ?? '',
      'Sales Rep Code': r.salesRepCode ?? '',
      'Sales Rep Name': r.salesRepName ?? '',
      'Sales Rep Role': r.salesRepRole ?? '',
      'Reporting Chain': r.reportingChain ?? '',
      'Amount (₹)': r.amount.inr,
      'UTR': r.utr ?? '',
      'Status': r.status,
      'Payout Header': r.payoutHeader ?? '',
      'Group Type': r.groupType ?? '',
      'Payout Field': r.payoutField,
      'Remarks': r.remarks ?? '',
      'Period': r.period,
      'TDS Section': r.tdsSection ?? '',
      'TDS Methodology': r.tdsMethodology ?? '',
      'TDS Deducted (₹)': r.tdsDeducted.inr,
      'Invoice No.': r.invoiceNumber ?? '',
      'GST Reg Type': r.gstRegistrationType ?? '',
      'PAN': r.panNumber ?? '',
      'Phone': r.phone ?? '',
    }));
    const summaryRows = [
      { Metric: 'Rows', Value: report.count },
      { Metric: 'Total Amount (₹)', Value: report.totals.amount.inr },
      ...(report.truncated
        ? [{ Metric: `TRUNCATED — showing first ${report.maxRows}; narrow the date range for a complete report`, Value: 'YES' }]
        : []),
    ];
    const buffer = buildXlsx([
      { name: 'Payments', rows: sheetRows },
      { name: 'Summary', rows: summaryRows },
    ]);
    const suffix = scope.clientId ? scope.clientId : 'all';
    return { buffer, filename: `payments-report-${suffix}.xlsx` };
  }
}
