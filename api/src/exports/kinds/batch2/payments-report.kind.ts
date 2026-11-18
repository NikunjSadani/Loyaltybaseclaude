/**
 * Payments Report — GET /v1/admin/payments-report/export as an export kind (Downloads page design). Sheet "Payments"
 * (29 columns) + sheet "Summary" (Rows, Total Amount, Total TDS Deducted).
 *
 * UNCAPPED: every entry matching the filters is written (the old 10,000-row cap and its TRUNCATED notice are gone —
 * the screen is paged, so there is no longer a "first 10,000 on screen" to match).
 *
 * Same row set, order and totals as the screen, by construction: WHERE / ORDER BY / SELECT and the totals aggregate
 * all come from payments-report/payments-report.query.ts (order ends in id ↓, so it is total and identical to the
 * screen's page boundaries). The Summary numbers are the DATABASE aggregate (paymentsTotals) — the same call the
 * screen's totals card uses — and are cross-checked against the rows actually streamed.
 *
 * Paging / memory: pages of ≤ 2,000 by OFFSET (attemptedAt is nullable, which a keyset cursor cannot page correctly),
 * all inside ONE REPEATABLE READ transaction (one consistent snapshot: concurrent payout changes can't duplicate /
 * skip rows, and the aggregate sees exactly the rows written). Each page is written to the streaming xlsx writer and
 * dropped before the next is read, so at most one page (+ its outlet / partner / assignment lookups) is in memory;
 * the tenant's SalesUser tree (≈ 1k small rows per tenant, needed to walk any rep's reporting chain) is loaded once
 * per tenant seen. Ranges over 31 days / open-ended are heavy → prepared in the background on the Downloads page.
 */
import { CreditEntryStatus, Prisma } from '@prisma/client';
import { istDateKey } from '../../../common/ist-date';
import { platformWide } from '../../../common/tenant-scope';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { PaymentsReportQueryDto } from '../../../payments-report/dto/payments-report.dto';
import {
  isSettledByTds,
  SETTLED_BY_TDS_LABEL,
  PAYMENT_ENTRY_SELECT,
  paymentsOrderBy,
  paymentsTotals,
  paymentsWhere,
} from '../../../payments-report/payments-report.query';
import { isBoundedRange } from '../batch1/common';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { EXPORT_PAGE_SIZE, JsonSheet, parseQueryDto } from './kind-support';

export interface PaymentsReportParams {
  /** Resolved tenant scope at request time (null = platform-wide, un-assumed GIFSY_ADMIN only). */
  clientId: string | null;
  from: string | null;
  to: string | null;
  status: CreditEntryStatus | null;
}

function scopeOf(user: JwtPayload, requested: string | null | undefined): string | null {
  return platformWide(user) ? (requested ?? null) : user.clientId;
}

interface SalesNode {
  id: string;
  reportingToId: string | null;
  employeeCode: string;
  user: { name: string | null } | null;
  hierarchyLevel: { code: string } | null;
}

/** Bottom-up chain "XSR-1 (Rep) → ASM-2 (Mgr)"; cycle-safe (same walk as PaymentsReportService.reportingChain). */
function reportingChain(startId: string, nodes: Map<string, SalesNode>): string | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: string | null = startId;
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const n = nodes.get(current);
    if (!n) break;
    const name = n.user?.name ?? '';
    parts.push(name ? `${n.employeeCode} (${name})` : n.employeeCode);
    current = n.reportingToId;
  }
  return parts.length ? parts.join(' → ') : null;
}

const inr = (paise: bigint) => Number(paise) / 100;

/** Snapshot window for one export (pages of ≤ 2,000 rows + their lookups, streamed as written; ~48k rows ≈ 25 pages). */
export const PAYMENTS_EXPORT_TX_TIMEOUT_MS = 15 * 60_000;

/**
 * Every read runs inside ONE REPEATABLE READ transaction, so all pages (and their outlet / assignment / sales-tree
 * lookups) see the same snapshot: a payout inserted, re-paid or deleted while the export is streaming can never shift
 * the OFFSET pages — no row duplicated or skipped, and the Summary aggregate covers exactly the rows written.
 */
async function run(ctx: ExportRunContext, p: PaymentsReportParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  return ctx.prisma.$transaction((tx) => runIn(tx, ctx, p, out), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 10_000,
    timeout: PAYMENTS_EXPORT_TX_TIMEOUT_MS,
  });
}

async function runIn(
  prisma: Prisma.TransactionClient,
  ctx: ExportRunContext,
  p: PaymentsReportParams,
  out: XlsxStreamWriter,
): Promise<{ rowCount: number }> {
  const clientId = scopeOf(ctx.user, p.clientId);
  const filter = { clientId, from: p.from, to: p.to, status: p.status };
  const where = paymentsWhere(filter);
  const orderBy = paymentsOrderBy(filter);

  const salesByTenant = new Map<string, Map<string, SalesNode>>();
  const sheet = new JsonSheet(out, 'Payments');
  let written = 0;
  let streamedAmount = 0n;
  let streamedTds = 0n;

  for (;;) {
    const entries = await prisma.creditPayoutEntry.findMany({
      where,
      orderBy,
      skip: written,
      take: EXPORT_PAGE_SIZE,
      select: PAYMENT_ENTRY_SELECT,
    });
    if (entries.length) {
      const codes = [...new Set(entries.map((e) => e.outletId))];
      const outlets = await prisma.outlet.findMany({
        where: { outletCode: { in: codes }, ...(clientId ? { clientId } : {}) },
        select: {
          id: true,
          clientId: true,
          outletCode: true,
          zone: true,
          state: true,
          city: true,
          partner: {
            select: { businessName: true, ownerName: true, phone: true, panNumber: true, gstRegistrationType: true, entityType: true },
          },
        },
      });
      const outletMap = new Map(outlets.map((o) => [`${o.clientId}|${o.outletCode}`, o]));
      const pks = outlets.map((o) => o.id);
      const assignments = pks.length
        ? await prisma.salesUserAssignment.findMany({
            where: { outletId: { in: pks }, unassignedAt: null },
            orderBy: { assignedAt: 'desc' }, // latest active assignment wins (stable)
            select: { outletId: true, salesUserId: true },
          })
        : [];
      const repByOutletPk = new Map<string, string>();
      for (const a of assignments) {
        if (a.outletId && a.salesUserId && !repByOutletPk.has(a.outletId)) repByOutletPk.set(a.outletId, a.salesUserId);
      }
      const newTenants = [...new Set(outlets.map((o) => o.clientId))].filter((c) => !salesByTenant.has(c));
      if (newTenants.length) {
        const users = await prisma.salesUser.findMany({
          where: { clientId: { in: newTenants } },
          select: {
            id: true,
            clientId: true,
            reportingToId: true,
            employeeCode: true,
            user: { select: { name: true } },
            hierarchyLevel: { select: { code: true } },
          },
        });
        for (const c of newTenants) salesByTenant.set(c, new Map());
        for (const u of users) salesByTenant.get(u.clientId)?.set(u.id, u);
      }

      for (const e of entries) {
        const o = outletMap.get(`${e.clientId}|${e.outletId}`);
        const nodes = o ? salesByTenant.get(o.clientId) : undefined;
        const repId = o ? repByOutletPk.get(o.id) : undefined;
        const rep = repId ? nodes?.get(repId) : undefined;
        const displayDate = e.paidAt ?? e.attemptedAt;
        streamedAmount += e.amountPaise;
        streamedTds += e.tdsDeductedPaise;
        await sheet.add({
          'S.No': ++written,
          Client: e.clientId,
          // The IST calendar day (raw ISO would print UTC — off-by-one in the 00:00–05:30 IST window).
          'Payment Date': displayDate ? istDateKey(new Date(displayDate.toISOString())) : '',
          'Outlet Code': e.outletId ?? '',
          'Outlet Name': e.outletName,
          'Business Name': o?.partner?.businessName ?? '',
          'Owner Name': o?.partner?.ownerName ?? '',
          Zone: o?.zone ?? '',
          State: o?.state ?? '',
          City: o?.city ?? '',
          'Sales Rep Code': rep?.employeeCode ?? '',
          'Sales Rep Name': rep?.user?.name ?? '',
          'Sales Rep Role': rep?.hierarchyLevel?.code ?? '',
          'Reporting Chain': (rep && nodes ? reportingChain(rep.id, nodes) : null) ?? '',
          'Amount (₹)': inr(e.amountPaise),
          // B-L6: never the internal TDS-WITHHELD reference — the same label the screen shows.
          UTR: isSettledByTds(e.utr) ? SETTLED_BY_TDS_LABEL : (e.utr ?? ''),
          Status: e.status,
          'Payout Header': e.download?.downloadCode ?? '',
          'Group Type': e.download?.groupType ?? '',
          'Payout Field': e.fieldName,
          Remarks: e.narration ?? '',
          'Failure Reason': e.failureReason ?? '',
          Period: e.period,
          'TDS Section': e.tdsSection ?? '',
          'TDS Methodology': e.tdsMethodology ?? '',
          'TDS Deducted (₹)': inr(e.tdsDeductedPaise),
          'Invoice No.': e.autoInvoice?.invoiceNumber ?? '',
          'GST Reg Type': o?.partner?.gstRegistrationType ?? '',
          PAN: o?.partner?.panNumber ?? '',
          Phone: o?.partner?.phone ?? '',
        });
      }
    }
    if (entries.length < EXPORT_PAGE_SIZE) break;
  }
  const rowCount = await sheet.end();

  // Summary = the SAME database aggregate the screen's totals card shows (same WHERE), read in the same snapshot.
  const totals = await paymentsTotals(prisma, where);
  if (totals.count !== written || totals.amountPaise !== streamedAmount || totals.tdsDeductedPaise !== streamedTds) {
    // Cannot happen inside one REPEATABLE READ snapshot with a shared WHERE — fail loudly rather than hand out a
    // financial file whose Summary disagrees with its own rows.
    throw new Error(
      `payments-report export: streamed ${written} rows / ${streamedAmount} paise but the aggregate is ${totals.count} / ${totals.amountPaise}`,
    );
  }

  const summary = new JsonSheet(out, 'Summary');
  await summary.add({ Metric: 'Rows', Value: totals.count });
  await summary.add({ Metric: 'Total Amount (₹)', Value: inr(totals.amountPaise) });
  await summary.add({ Metric: 'Total TDS Deducted (₹)', Value: inr(totals.tdsDeductedPaise) });
  await summary.end();
  return { rowCount };
}

export const PAYMENTS_REPORT_KIND: ExportKindDef<PaymentsReportParams> = {
  kind: 'payments-report',
  label: 'Payments report',
  // Same as GET admin/payments-report/export.
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:read' },
  parseParams(raw: unknown, user: JwtPayload) {
    const q = parseQueryDto(PaymentsReportQueryDto, raw);
    return { clientId: scopeOf(user, q.clientId), from: q.from ?? null, to: q.to ?? null, status: q.status ?? null };
  },
  // Uncapped (every matching row). A range of ≤ 31 days streams instantly (one tenant OR all tenants, as before); an
  // open-ended or longer range is prepared in the background (Downloads page). Memory is flat either way.
  isHeavy: (p) => !isBoundedRange(p.from ?? undefined, p.to ?? undefined),
  describeParams: (p) =>
    [p.from || p.to ? `${p.from ?? '…'} – ${p.to ?? '…'}` : 'All dates', p.status ?? 'Paid', p.clientId ?? 'All tenants'].join(' · '),
  fileName: (p) => `payments-report-${p.clientId ? p.clientId : 'all'}.xlsx`,
  run,
};
