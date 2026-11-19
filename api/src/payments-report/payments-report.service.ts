import { Injectable } from '@nestjs/common';
import { CreditEntryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isSettledByTds, PAYMENT_ENTRY_SELECT, paymentsOrderBy, paymentsTotals, paymentsWhere } from './payments-report.query';
import { PAYMENTS_DEFAULT_PAGE_SIZE, PAYMENTS_MAX_PAGE_SIZE } from './dto/payments-report.dto';
import { formatINR } from '../common/money';
import { istDate } from '../credits/tds-credit';

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
  /** 1-based page (default 1). */
  page?: number;
  /** Rows per page (default 50, clamped to 1..200). */
  pageSize?: number;
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
   * ONE PAGE of payout payments (paidAt not null by default) in the scope's [from,to] range, across ALL streams,
   * enriched (batched, no N+1) with the payout batch header, outlet geography, the owning ChannelPartner, the frozen
   * invoice number, and the outlet's tagged sales rep + full reporting chain.
   *
   * MEMORY: only `pageSize` (≤ 200) entries are ever loaded per request, and only THEIR outlets / assignments are
   * joined. The totals are a DATABASE aggregate over every matching entry (paymentsTotals), so they cover the whole
   * range regardless of page. The order is total (… id ↓), identical to the Excel export's.
   */
  async paymentReport(scope: PaymentsReportScope) {
    const requestedPage = Math.max(1, Math.floor(scope.page ?? 1));
    const pageSize = Math.min(PAYMENTS_MAX_PAGE_SIZE, Math.max(1, Math.floor(scope.pageSize ?? PAYMENTS_DEFAULT_PAGE_SIZE)));
    const where = paymentsWhere(scope);
    const orderBy = paymentsOrderBy(scope);

    // The totals and the page are read in ONE REPEATABLE READ snapshot, so the cards (totals) and the pager
    // ("Showing 1–50 of N") always describe the same set of rows even while payouts are being written. The page is
    // CLAMPED to the last page (a page past the end — e.g. the range shrank — returns the last page, never an empty
    // page with non-zero totals); the effective page is returned so the client can follow.
    const { totals, page, entries } = await this.prisma.$transaction(
      async (tx) => {
        const t = await paymentsTotals(tx, where);
        const lastPage = Math.max(1, Math.ceil(t.count / pageSize));
        const p = Math.min(requestedPage, lastPage);
        const rows = await tx.creditPayoutEntry.findMany({
          where,
          orderBy,
          skip: (p - 1) * pageSize,
          take: pageSize,
          // Fix round B (L1): + the reversal / TDS-credit marks, in the SAME query (screen only — the export kind keeps
          // PAYMENT_ENTRY_SELECT). Prisma loads the two relations for this page's ids only.
          select: {
            ...PAYMENT_ENTRY_SELECT,
            tdsBaseReversedAt: true,
            reversalAllocations: { where: { state: { in: ['APPLIED_RECEIVABLE', 'APPLIED_CANCELLED'] } } /* owner D2: a fully withheld PAID payout reversed → CANCELLED, owed 0 */, select: { receivablePaise: true, tdsCreditPaise: true } },
            tdsCreditApplications: {
              where: { releasedAt: null },
              select: { amountPaise: true, tdsCredit: { select: { clientId: true } } },
            },
          },
        });
        return { totals: t, page: p, entries: rows };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

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
      // A non-success row has a null paidAt but carries the uploaded failure date in attemptedAt —
      // show that so a FAILED row has a date instead of a blank. PAID rows use paidAt as before.
      const displayDate = e.paidAt ?? e.attemptedAt;
      return {
        clientId: e.clientId,
        paymentDate: displayDate ? displayDate.toISOString() : null,
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
        // B-L6: a TDS-withheld settlement has no UTR — labelled via settledByTds (screen + export).
        utr: isSettledByTds(e.utr) ? null : (e.utr ?? null),
        settledByTds: isSettledByTds(e.utr),
        status: e.status,
        payoutHeader: e.download?.downloadCode ?? null,
        groupType: e.download?.groupType ?? null,
        payoutField: e.fieldName,
        remarks: e.narration ?? null,
        // The raw bank/vendor reason captured from the UTR upload on a FAILED row (null on PAID).
        failureReason: e.failureReason ?? null,
        period: e.period,
        tdsSection: e.tdsSection,
        tdsMethodology: e.tdsMethodology,
        tdsDeducted: this.money(e.tdsDeductedPaise),
        invoiceNumber: e.autoInvoice?.invoiceNumber ?? null,
        gstRegistrationType: o?.partner?.gstRegistrationType ?? null,
        panNumber: o?.partner?.panNumber ?? null,
        phone: o?.partner?.phone ?? null,
        // Fix round B (L1): only on a reversed / credit-adjusted entry — every other row is shaped exactly as before.
        ...this.reversalMarks(e),
      };
    });

    return {
      scope: {
        clientId: scope.clientId ?? null,
        from: scope.from ?? null,
        to: scope.to ?? null,
      },
      page,
      pageSize,
      /** Every entry matching the filters (all pages). */
      totalRows: totals.count,
      totalPages: Math.ceil(totals.count / pageSize),
      /** Same as totalRows — kept for callers of the pre-paging envelope (it was "rows matching the filters"). */
      count: totals.count,
      // Whole-range totals (DB aggregate over every matching entry), NOT a sum of this page.
      totals: {
        count: totals.count,
        amount: this.money(totals.amountPaise),
        tdsDeducted: this.money(totals.tdsDeductedPaise),
      },
      rows,
    };
  }

  /**
   * L1 — one row's marks: `reversal` (a PAID entry later reversed by the engine: owed back, TDS credit, date) and
   * `tdsCreditPaise` / `tdsNote` (its TDS was lowered by an earlier TDS credit — own or another programme's, 194C).
   */
  private reversalMarks(r: {
    clientId: string;
    amountPaise: bigint;
    tdsBaseReversedAt?: Date | null;
    reversalAllocations?: Array<{ receivablePaise: bigint; tdsCreditPaise: bigint }>;
    tdsCreditApplications?: Array<{ amountPaise: bigint; tdsCredit: { clientId: string } | null }>;
  }): {
    reversal?: { receivablePaise: number; tdsCreditPaise: number; reversedAt: string; note: string };
    tdsCreditPaise?: number;
    tdsNote?: string;
  } {
    const m: {
      reversal?: { receivablePaise: number; tdsCreditPaise: number; reversedAt: string; note: string };
      tdsCreditPaise?: number;
      tdsNote?: string;
    } = {};
    if (r.tdsBaseReversedAt) {
      const a = r.reversalAllocations?.[0];
      const owed = a ? a.receivablePaise : r.amountPaise;
      const credit = a ? a.tdsCreditPaise : 0n;
      m.reversal = {
        receivablePaise: Number(owed),
        tdsCreditPaise: Number(credit),
        reversedAt: r.tdsBaseReversedAt.toISOString(),
        note:
          `Reversed on ${istDate(r.tdsBaseReversedAt)} — ` +
          (owed > 0n ? `${formatINR(owed)} owed back (receivable)` : 'nothing owed back (the whole amount was withheld as TDS)') +
          (credit > 0n ? `; ${formatINR(credit)} TDS credit carried forward` : ''),
      };
    }
    const apps = r.tdsCreditApplications ?? [];
    const credit = apps.reduce((s, x) => s + x.amountPaise, 0n);
    if (credit > 0n) {
      const other = apps.filter((x) => x.tdsCredit && x.tdsCredit.clientId !== r.clientId).reduce((s, x) => s + x.amountPaise, 0n);
      m.tdsCreditPaise = Number(credit);
      m.tdsNote =
        `TDS lowered by ${formatINR(credit)} adjusted from earlier TDS credit` +
        (other > 0n ? ` (${formatINR(other)} from another programme)` : '');
    }
    return m;
  }

  // The .xlsx twin (GET …/payments-report/export) is the 'payments-report' export kind
  // (exports/kinds/batch2/payments-report.kind.ts): EVERY matching row (same WHERE + order), streamed page by page,
  // with a Summary from the same paymentsTotals aggregate.
}
