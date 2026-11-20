/**
 * Redemption report → Excel — GET /v1/reports/redemptions/export (owner-approved 2026-11-20, all clients).
 *
 * Sheets: "Redemptions" (one row per order) · "Status history" (one row per status change) · "Summary" (points / ₹ by
 * zone, state, ASM level, reward, status, reward type, delivery) · "About" (filters, generated time, every column and
 * every placeholder explained, data-handling notes).
 *
 * SCOPE: one tenant — the JWT tenant for a CLIENT_ADMIN / assumed Gifsy operator (?clientId= ignored), the ?clientId=
 * client for an un-assumed GIFSY_ADMIN (required). Re-resolved from the requester at run time (worker too).
 * ROLES: GIFSY_ADMIN + CLIENT_ADMIN + reports:read — the payments-report precedent (money + personal data), stricter
 * than the usage report (which also admits MIS_USER).
 *
 * QUERIES (fixed per page, never per row): per tenant — levels, the SalesUser tree, outlet-type display names; per page
 * of ≤ 2,000 orders — orders (+ reward/category/vendor/partner/outlet via select), status history, cash payouts,
 * outlet/partner assignments, actor names (only the ones not yet cached); the status-history pass — one history page
 * read + names per page. Every read runs in ONE REPEATABLE READ snapshot.
 *
 * NEVER SELECTED: voucherCode, voucherPin, payeePan / panNumber, deliveryName / deliveryPhone / deliveryAddressLine1/2,
 * bank details. The redeemer's phone is masked to its last 4 digits (redemption-report.rows.ts).
 *
 * Personal data leaves the system → 0 rows = 404 (no file) and one AuditLog row (EXPORT / REDEMPTION_REPORT) is written
 * BEFORE any byte, exactly like the usage / installed-users exports.
 */
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { istDateTimeCell } from '../../../common/ist-date';
import type { XlsxCell, XlsxStreamWriter } from '../../../common/xlsx-stream';
import { RedemptionReportQueryDto } from '../../../reports/dto/redemption-report.dto';
import {
  describeRedemptionParams,
  REDEMPTION_LIGHT_MAX_DAYS,
  assertRedemptionClientKnown,
  rangeDays,
  resolveRedemptionClientId,
  resolveRedemptionWhere,
  resolveRedemptionParams,
  type RedemptionReportParams,
} from '../../../reports/redemptions/redemption-report.query';
import {
  HISTORY_HEADERS,
  NOT_RECORDED,
  RedemptionSummary,
  SUMMARY_HEADERS,
  historyRow,
  levelHeader,
  assignmentOutlets,
  outletOf,
  pickPayout,
  placedById,
  redemptionHeaders,
  redemptionRow,
  type HierarchyCtx,
  type HistoryRow,
  type LevelDef,
  type PayoutRow,
  type ReportOrder,
  type SalesNode,
} from '../../../reports/redemptions/redemption-report.rows';
import { redemptionAboutRows } from '../../../reports/redemptions/redemption-report.about';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import { EXPORT_PAGE_SIZE, parseQueryDto } from './kind-support';

export const REDEMPTION_REPORT_NONE_MESSAGE = '0 redemptions matched these filters.';
export const REDEMPTION_EXPORT_TX_TIMEOUT_MS = 15 * 60_000;

/** Exactly the columns the report shows — nothing secret (see header). Exported for the never-selected test. */
export const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  quantity: true,
  pointsDeducted: true,
  totalPointsCost: true,
  valuePaise: true,
  redemptionMode: true,
  fulfilmentChannel: true,
  deliveryCity: true,
  deliveryState: true,
  deliveryPincode: true,
  trackingNumber: true,
  logisticsPartner: true,
  voucherProvider: true,
  podUrl: true,
  dispatchedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  cancelReason: true,
  metadata: true,
  createdAt: true,
  reward: { select: { name: true, metadata: true, category: { select: { name: true } } } },
  fulfilledByVendor: { select: { name: true } },
  partner: {
    select: {
      id: true,
      userId: true,
      ownerName: true,
      businessName: true,
      phone: true,
      user: { select: { name: true, role: true } },
      outlets: {
        where: { deletedAt: null },
        // ALL live outlets: the row shows the primary one (comparePrimary); the others are the rep-assignment fallback.
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          isPrimary: true,
          isActive: true,
          createdAt: true,
          id: true,
          outletCode: true,
          name: true,
          city: true,
          state: true,
          zone: true,
          programName: true,
          programCategory: true,
          outletTypeId: true,
          outletType: { select: { name: true, code: true } },
        },
      },
    },
  },
} satisfies Prisma.RedemptionOrderSelect;

const HISTORY_SELECT = {
  id: true,
  orderId: true,
  fromStatus: true,
  toStatus: true,
  changedById: true,
  notes: true,
  createdAt: true,
} satisfies Prisma.RedemptionStatusHistorySelect;

type Db = Prisma.TransactionClient;

/** Re-pin the tenant from the requester (a stored request can never widen its own scope). */
function pinned(user: JwtPayload, p: RedemptionReportParams): RedemptionReportParams {
  return { ...p, clientId: resolveRedemptionClientId(user, p.clientId) };
}

/** Actor-name cache: fetch only ids not seen yet, one query per page at most. */
class Names {
  private readonly map = new Map<string, string>();
  async load(db: Db, ids: Iterable<string | null | undefined>): Promise<void> {
    const missing = [...new Set([...ids].filter((x): x is string => !!x && !this.map.has(x)))];
    if (!missing.length) return;
    const users = await db.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } });
    for (const u of users) this.map.set(u.id, (u.name ?? '').trim() || NOT_RECORDED);
    for (const id of missing) if (!this.map.has(id)) this.map.set(id, NOT_RECORDED);
  }
  readonly nameOf = (id: string | null): string => (id ? this.map.get(id) ?? NOT_RECORDED : NOT_RECORDED);
}

async function run(ctx: ExportRunContext, raw: RedemptionReportParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const p = pinned(ctx.user, raw);
  await assertRedemptionClientKnown(ctx.prisma, ctx.user, p.clientId);
  const where = await resolveRedemptionWhere(ctx.prisma, p);

  // 1. Nothing matched → 404, no file, no audit row.
  const matched = await ctx.prisma.redemptionOrder.count({ where });
  if (!matched) throw new NotFoundException(REDEMPTION_REPORT_NONE_MESSAGE);

  // 2. Audit BEFORE any byte leaves (names + masked phones + money).
  await ctx.prisma.auditLog.create({
    data: {
      action: 'EXPORT',
      entityType: 'REDEMPTION_REPORT',
      entityId: p.clientId,
      actorId: ctx.user.sub,
      metadata: {
        route: 'reports/redemptions/export',
        clientId: p.clientId,
        assumed: !!ctx.user.assumed,
        actorRole: ctx.user.role,
        rowCount: matched,
        filters: { from: p.from, to: p.to, status: p.status, rewardType: p.rewardType, zone: p.zone, state: p.state },
      },
    },
  });

  // 3. The workbook, from one consistent snapshot.
  return ctx.prisma.$transaction((tx) => runIn(tx, ctx, p, where, out), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 10_000,
    timeout: REDEMPTION_EXPORT_TX_TIMEOUT_MS,
  });
}

export async function runIn(
  db: Db,
  ctx: Pick<ExportRunContext, 'user' | 'now'>,
  p: RedemptionReportParams,
  where: Prisma.RedemptionOrderWhereInput,
  out: XlsxStreamWriter,
): Promise<{ rowCount: number }> {
  const clientId = p.clientId;

  // ── Tenant-level lookups (once) ──
  const levels: LevelDef[] = await db.salesHierarchyLevel.findMany({
    where: { clientId, level: { gte: 0 } }, // negative = parked rows mid-upload, never real levels
    orderBy: { level: 'asc' },
    select: { id: true, code: true, name: true, level: true },
  });
  const salesUsers: SalesNode[] = await db.salesUser.findMany({
    where: { clientId },
    select: {
      id: true,
      reportingToId: true,
      employeeCode: true,
      hierarchyLevelId: true,
      isActive: true,
      deletedAt: true,
      user: { select: { name: true, status: true } },
    },
  });
  const typeConfigs = await db.outletTypeClientConfig.findMany({
    where: { clientId, displayName: { not: null } },
    select: { outletTypeId: true, displayName: true },
  });
  const typeDisplay = new Map<string, string>();
  for (const t of typeConfigs) if (t.displayName?.trim()) typeDisplay.set(t.outletTypeId, t.displayName.trim());
  const hierarchy: HierarchyCtx = { clientId, levels, nodes: new Map(salesUsers.map((n) => [n.id, n])) };

  // Summary "by ASM": the tenant's ASM level (code ASM), else its level 3; none → section omitted (About says so).
  const asmPos = levels.findIndex((l) => l.code.toUpperCase() === 'ASM') >= 0
    ? levels.findIndex((l) => l.code.toUpperCase() === 'ASM')
    : levels.findIndex((l) => l.level === 3);
  const asmLabel = asmPos >= 0 ? levelHeader(clientId, levels[asmPos]) : null;
  const summary = new RedemptionSummary(asmLabel, asmPos >= 0 ? asmPos * 2 : null);

  const names = new Names();
  const orderMeta = new Map<string, { orderNumber: string; outletCode: string }>();
  const headers = redemptionHeaders(hierarchy);

  // ── Sheet 1: Redemptions ──
  const sheet = await out.addSheet('Redemptions', headers, {
    widths: headers.map((h) => Math.min(40, Math.max(12, h.length + 2))),
  });
  let written = 0;
  let cursor: string | null = null;
  for (;;) {
    const fetched = (await db.redemptionOrder.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), // keyset: resume after the last row written
      take: EXPORT_PAGE_SIZE + 1, // one extra row = "there is another page" without an extra round trip
      select: ORDER_SELECT,
    })) as unknown as ReportOrder[];
    const page = fetched.slice(0, EXPORT_PAGE_SIZE);
    if (page.length) {
      const ids = page.map((o) => o.id);
      const history: HistoryRow[] = await db.redemptionStatusHistory.findMany({
        where: { orderId: { in: ids } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: HISTORY_SELECT,
      });
      const payouts: PayoutRow[] = await db.payoutTransaction.findMany({
        where: { redemptionOrderId: { in: ids } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { redemptionOrderId: true, status: true, completedAt: true, providerRefId: true, tdsPaise: true },
      });
      const outletPks = [...new Set(page.flatMap((o) => (o.partner?.outlets ?? []).map((x) => x.id)))];
      const partnerIds = [...new Set(page.map((o) => o.partner?.id).filter((x): x is string => !!x))];
      const assignments = await db.salesUserAssignment.findMany({
        where: {
          unassignedAt: null,
          salesUser: { clientId },
          OR: [{ outletId: { in: outletPks } }, { partnerId: { in: partnerIds } }],
        },
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }], // latest active assignment wins
        select: { outletId: true, partnerId: true, salesUserId: true },
      });
      await names.load(db, [...history.map((h) => h.changedById), ...page.map(placedById)]);

      const historyBy = new Map<string, HistoryRow[]>();
      for (const h of history) {
        const list = historyBy.get(h.orderId);
        if (list) list.push(h);
        else historyBy.set(h.orderId, [h]);
      }
      const payoutsBy = new Map<string, PayoutRow[]>(); // newest first (query order)
      for (const t of payouts) {
        if (!t.redemptionOrderId) continue;
        const list = payoutsBy.get(t.redemptionOrderId);
        if (list) list.push(t);
        else payoutsBy.set(t.redemptionOrderId, [t]);
      }
      const repByOutlet = new Map<string, string>();
      const repByPartner = new Map<string, string>();
      for (const a of assignments) {
        if (a.outletId && !repByOutlet.has(a.outletId)) repByOutlet.set(a.outletId, a.salesUserId);
        if (a.partnerId && !repByPartner.has(a.partnerId)) repByPartner.set(a.partnerId, a.salesUserId);
      }

      for (const o of page) {
        const outlet = outletOf(o);
        // Primary outlet's active rep → the member's other outlets (active first, oldest first) → partner-level.
        let repId: string | null = null;
        for (const x of assignmentOutlets(o)) {
          const r = repByOutlet.get(x.id);
          if (r) {
            repId = r;
            break;
          }
        }
        repId ??= (o.partner ? repByPartner.get(o.partner.id) : undefined) ?? null;
        const { cells, facts } = redemptionRow({
          order: o,
          history: historyBy.get(o.id) ?? [],
          payout: pickPayout(payoutsBy.get(o.id) ?? []),
          repId,
          typeDisplay,
          nameOf: names.nameOf,
          hierarchy,
          now: ctx.now,
        });
        await sheet.addRow(cells);
        summary.add(facts);
        orderMeta.set(o.id, { orderNumber: o.orderNumber, outletCode: outlet?.outletCode ?? NOT_RECORDED });
        written++;
      }
      cursor = page[page.length - 1].id;
    }
    if (fetched.length <= EXPORT_PAGE_SIZE) break;
  }

  // ── Sheet 2: Status history (second paged pass over the same snapshot) ──
  const hist = await out.addSheet('Status history', [...HISTORY_HEADERS], { widths: [18, 14, 14, 14, 18, 24, 50] });
  let histWritten = 0;
  let histCursor: string | null = null;
  for (;;) {
    const fetched: HistoryRow[] = await db.redemptionStatusHistory.findMany({
      where: { order: where },
      orderBy: [{ order: { createdAt: 'asc' } }, { orderId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      ...(histCursor ? { cursor: { id: histCursor }, skip: 1 } : {}),
      take: EXPORT_PAGE_SIZE + 1,
      select: HISTORY_SELECT,
    });
    const page = fetched.slice(0, EXPORT_PAGE_SIZE);
    if (page.length) {
      await names.load(db, page.map((h) => h.changedById));
      for (const h of page) {
        const m = orderMeta.get(h.orderId);
        await hist.addRow(historyRow(h, m?.orderNumber ?? NOT_RECORDED, m?.outletCode ?? NOT_RECORDED, names.nameOf));
        histWritten++;
      }
      histCursor = page[page.length - 1].id;
    }
    if (fetched.length <= EXPORT_PAGE_SIZE) break;
  }

  // ── Sheet 3: Summary ──
  const sum = await out.addSheet('Summary', [...SUMMARY_HEADERS], { widths: [20, 36, 10, 16, 16, 20, 20, 14, 16] });
  for (const r of summary.rows()) await sum.addRow(r);

  // ── Sheet 4: About ──
  const about = await out.addSheet('About', ['About this report', ''], { widths: [34, 120] });
  const lines: XlsxCell[][] = redemptionAboutRows({
    params: p,
    filterLine: describeRedemptionParams(p),
    generatedAt: istDateTimeCell(ctx.now),
    orders: written,
    statusChanges: histWritten,
    hierarchyHeaders: levels.map((l) => levelHeader(clientId, l)),
    asmLabel,
  });
  for (const line of lines) await about.addRow(line);

  return { rowCount: written };
}

export const REDEMPTION_REPORT_KIND: ExportKindDef<RedemptionReportParams> = {
  kind: 'redemption-report',
  label: 'Redemption report',
  // Same as GET /v1/reports/redemptions/export — the payments-report precedent (no MIS_USER).
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:read' },
  parseParams(raw: unknown, user: JwtPayload) {
    const q = parseQueryDto(RedemptionReportQueryDto, raw);
    return resolveRedemptionParams(q, user, new Date());
  },
  isHeavy: (p) => rangeDays(p) > REDEMPTION_LIGHT_MAX_DAYS,
  describeParams: describeRedemptionParams,
  fileName: (p) => `redemption-report-${p.clientId}-${p.from}-to-${p.to}.xlsx`,
  run,
};
