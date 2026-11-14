/**
 * Payments Report — GET /v1/admin/payments-report/export as an export kind (Downloads page design). Output identical
 * to the old PaymentsReportService.paymentReportXlsx: sheet "Payments" (29 columns) + sheet "Summary" (Rows, Total
 * Amount, and the TRUNCATED notice when the 10,000-row cap is hit — the cap is kept so the file matches the on-screen
 * report and its banner).
 *
 * Paging: the same where/order as the report (paidAt ↓ or, for a non-PAID status filter, attemptedAt ↓ NULLS LAST;
 * then createdAt ↓; id ↓ as the tiebreak) read in pages of ≤ 2,000 by OFFSET, all inside ONE REPEATABLE READ
 * transaction (one consistent snapshot: concurrent payout changes can't duplicate / skip rows or double-count) — attemptedAt is nullable, which a
 * keyset cursor cannot page correctly, and the 10,000-row cap bounds it to ≤ 6 reads. Each page's outlet, partner and
 * active-assignment lookups cover that page only; the tenant's SalesUser tree (≈ 1k small rows per tenant, needed to
 * walk any rep's reporting chain) is loaded once per tenant seen. Totals are summed in BigInt paise while streaming.
 */
import { CreditEntryStatus, Prisma } from '@prisma/client';
import { istDateKey, istDayRangeFilter } from '../../../common/ist-date';
import { platformWide } from '../../../common/tenant-scope';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { PaymentsReportQueryDto } from '../../../payments-report/dto/payments-report.dto';
import { PaymentsReportService } from '../../../payments-report/payments-report.service';
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

/** Snapshot window for one export (≤ 6 page reads of ≤ 2,000 rows + their lookups, streamed as written). */
export const PAYMENTS_EXPORT_TX_TIMEOUT_MS = 15 * 60_000;

/**
 * Every read runs inside ONE REPEATABLE READ transaction, so all pages (and their outlet / assignment / sales-tree
 * lookups) see the same snapshot: a payout inserted, re-paid or deleted while the export is streaming can never shift
 * the OFFSET pages — no row duplicated or skipped, and the Summary total is exactly the sum of the rows written.
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
  const range = istDayRangeFilter(p.from ?? undefined, p.to ?? undefined);

  const where: Prisma.CreditPayoutEntryWhereInput = {};
  if (clientId) where.clientId = clientId;
  if (p.status) where.status = p.status;
  const nonPaidStatus = !!p.status && p.status !== CreditEntryStatus.PAID;
  if (nonPaidStatus) {
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
  const orderBy: Prisma.CreditPayoutEntryOrderByWithRelationInput[] = nonPaidStatus
    ? [{ attemptedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }]
    : [{ paidAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];

  const max = PaymentsReportService.MAX_ROWS;
  const salesByTenant = new Map<string, Map<string, SalesNode>>();
  const sheet = new JsonSheet(out, 'Payments');
  let written = 0;
  let fetched = 0;
  let total = 0n;

  for (;;) {
    // Read one row past the cap so a truncated report is detected exactly like the old `take: MAX_ROWS + 1`.
    const take = Math.min(EXPORT_PAGE_SIZE, max + 1 - fetched);
    if (take <= 0) break;
    const page = await prisma.creditPayoutEntry.findMany({
      where,
      orderBy,
      skip: fetched,
      take,
      select: {
        id: true,
        clientId: true,
        outletId: true,
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
      },
    });
    fetched += page.length;
    const entries = page.slice(0, Math.max(0, max - written));
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
        total += e.amountPaise;
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
          UTR: e.utr ?? '',
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
    if (page.length < take) break;
  }
  const rowCount = await sheet.end();
  const truncated = fetched > max;

  const summary = new JsonSheet(out, 'Summary');
  await summary.add({ Metric: 'Rows', Value: written });
  await summary.add({ Metric: 'Total Amount (₹)', Value: inr(total) });
  if (truncated) {
    await summary.add({ Metric: `TRUNCATED — showing first ${max}; narrow the date range for a complete report`, Value: 'YES' });
  }
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
  // Capped at 10,000 rows (as the on-screen report) and streamed with flat memory → always instant.
  isHeavy: () => false,
  describeParams: (p) =>
    [p.from || p.to ? `${p.from ?? '…'} – ${p.to ?? '…'}` : 'All dates', p.status ?? 'Paid', p.clientId ?? 'All tenants'].join(' · '),
  fileName: (p) => `payments-report-${p.clientId ? p.clientId : 'all'}.xlsx`,
  run,
};
