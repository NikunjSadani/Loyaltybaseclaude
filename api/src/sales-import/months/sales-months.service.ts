import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SalesMonthStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import { currentMonthKey } from '../../targets/targets.helpers';
import type {
  FocusAcceptanceList,
  FocusAcceptanceRequest,
  SalesMonthRebuildProductListResult,
  SalesMonthReopenRequest,
  SalesMonthReopenResult,
  SalesMonthRow,
  SalesMonthActiveJob,
  SalesMonthLastJob,
} from '../sales-import.contract';
import { historyRetentionMessage, isBeyondHistoryRetention } from '../retention-window';
import { classifyMonthSummaries, insertMonthCombosSql } from '../kpi/month-combos';
import { isMonthKey, monthLabel, resolveMonthState, shiftMonthKey } from './month-state';
import { activeJobsByMonth, assertNoActiveJob, lastJobsByMonth } from '../apply/apply-jobs-data';
import {
  kpiLabelsOf,
  latestTargetWriteByMonth,
  listFocusAcceptances,
  targetRowOf,
  targetsNewerThanApply,
  tenantHasTargetNamesDef,
} from '../kpi/focus-data';
import { focusKey, splitFocusName } from '../kpi/focus-products';

/** Longest acceptance key accepted (a focus token key; real ones are a few characters). */
export const FOCUS_ACCEPTANCE_MAX_KEY = 200;

/** Max months one list call returns. */
export const MAX_MONTH_RANGE = 36;

type Downstream = SalesMonthRow['downstream'];
const NO_DOWNSTREAM: Downstream = { creditBatches: 0, exports: 0 };

/** AuditLog entity of a sales month (apply / close / reopen / D-1 export records all use it). */
export const salesMonthEntityId = (clientId: string, month: string) => `${clientId}:${month}`;

/**
 * M5: points artefacts already produced for each month — credit batches (any status) for the period, and the
 * points-compute export / report downloads the D-1 guard records as AuditLog EXPORT rows on the month entity.
 */
export async function downstreamArtifacts(
  db: Pick<Prisma.TransactionClient, 'creditBatch' | 'auditLog'>,
  clientId: string,
  months: string[],
): Promise<Map<string, Downstream>> {
  const out = new Map<string, Downstream>(months.map((m) => [m, { ...NO_DOWNSTREAM }]));
  if (months.length === 0) return out;
  const [batches, exportRows] = await Promise.all([
    db.creditBatch.groupBy({ by: ['period'], where: { clientId, period: { in: months } }, _count: { _all: true } }),
    db.auditLog.groupBy({
      by: ['entityId'],
      where: { entityType: 'SALES_MONTH', action: 'EXPORT', entityId: { in: months.map((m) => salesMonthEntityId(clientId, m)) } },
      _count: { _all: true },
    }),
  ]);
  for (const b of batches) out.get(b.period)!.creditBatches = b._count._all;
  for (const e of exportRows) {
    const month = e.entityId.slice(clientId.length + 1);
    if (out.has(month)) out.get(month)!.exports = e._count._all;
  }
  return out;
}

type HistoryMeta = {
  sourceImportId: string;
  appliedAt: Date;
  lineRows: number;
  combosSourceImportId: string | null;
  combosAppliedAt: Date | null;
};

/**
 * "Rebuild product list" runs at apply scale (§10c): the month write itself allows 300 s, so a month's summary rebuild
 * gets 240 s per statement (incl. the wait for the month lock) and 280 s for the transaction.
 */
export const REBUILD_PRODUCT_LIST_STATEMENT_TIMEOUT_MS = 240_000;
export const REBUILD_PRODUCT_LIST_TX_TIMEOUT_MS = 280_000;

/**
 * The stored month history per month: which import it holds and when it was applied. Reads the small per-month HEADER
 * table (sales_month_history_sets, unique (clientId, month)) — never the line rows (final check H1: Prisma's `distinct`
 * is applied in Node, so a `distinct` over sales_month_histories fetched every line of every month). Months older than
 * the history window (retention-window.ts: 10 years while SALES_RETENTION_V2 is off, current + 3 previous with it on)
 * have NO history here, even while the sweep is still deleting them.
 */
export async function historyMetaByMonth(
  db: Pick<Prisma.TransactionClient, 'salesMonthHistorySet'>,
  clientId: string,
  months: string[],
): Promise<Map<string, HistoryMeta>> {
  const kept = months.filter((m) => !isBeyondHistoryRetention(m));
  if (kept.length === 0) return new Map();
  const rows = await db.salesMonthHistorySet.findMany({
    where: { clientId, month: { in: kept } },
    select: { month: true, sourceImportId: true, appliedAt: true, lineRows: true, combosSourceImportId: true, combosAppliedAt: true },
  });
  return new Map(rows.map((r) => [r.month, r]));
}

export function downstreamWarnings(month: string, d: Downstream): string[] {
  const w: string[] = [];
  if (d.creditBatches > 0) {
    w.push(`${d.creditBatches} credit batch(es) already exist for ${monthLabel(month)}; points credited from them will not change automatically. Use the reversal process if the new numbers differ.`);
  }
  if (d.exports > 0) {
    w.push(`Points reports / exports for ${monthLabel(month)} were downloaded ${d.exports} time(s); anything already sent to the client may no longer match.`);
  }
  return w;
}

/**
 * Month state list / close / reopen with the per-(client, month) advisory lock + audit (plan §7.3; task K-4).
 * OWNER: Lane K. Close and reopen take the SAME lock as apply, so they serialise against an in-flight apply.
 */
@Injectable()
export class SalesMonthsService {
  constructor(readonly prisma: PrismaService) {}

  async list(clientId: string, from?: string, to?: string): Promise<SalesMonthRow[]> {
    const current = currentMonthKey();
    const end = to ?? current;
    const start = from ?? shiftMonthKey(end, -5);
    if (!isMonthKey(start) || !isMonthKey(end)) throw new BadRequestException('from/to must be YYYY-MM.');
    if (start > end) throw new BadRequestException('from must not be after to.');
    const months: string[] = [];
    for (let m = start; m <= end && months.length < MAX_MONTH_RANGE; m = shiftMonthKey(m, 1)) months.push(m);

    const rows = await this.prisma.salesMonthStatus.findMany({ where: { clientId, month: { in: months } } });
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    const names = await this.userNames(rows.map((r) => r.closedById));
    const [downstream, history, targetTimes, active, finished] = await Promise.all([
      downstreamArtifacts(this.prisma, clientId, months),
      historyMetaByMonth(this.prisma, clientId, months),
      this.targetChangeTimes(clientId, months),
      activeJobsByMonth(this.prisma, clientId, months),
      lastJobsByMonth(this.prisma, clientId, months),
    ]);
    return months
      .reverse()
      .map((m) => this.toRow(m, current, byMonth.get(m) ?? null, names, downstream.get(m), history.get(m), targetTimes.get(m), active.get(m), finished.get(m)));
  }

  async close(user: JwtPayload, month: string): Promise<SalesMonthRow> {
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    const clientId = user.clientId;
    const row = await this.prisma.$transaction(
      async (tx) => {
        await lockSalesMonth(tx, clientId, month);
        // Owner 2026-11-18: never close a month while an Apply / Recalculate of it is queued or running — checked UNDER the
        // month lock, in the same transaction as the state change (final review L4). An apply queued just after this
        // close is refused loudly by the worker ("<Month> is CLOSED") when it re-checks under the same lock.
        await assertNoActiveJob(tx, clientId, month);
        const current = currentMonthKey();
        const existing = await tx.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
        const st = resolveMonthState(month, current, existing);
        if (st.relation === 'CURRENT') throw new ConflictException(`${monthLabel(month)} is the current month and cannot be closed yet.`);
        if (st.relation === 'FUTURE') throw new ConflictException(`${monthLabel(month)} has not started yet.`);
        if (st.state === 'CLOSED') throw new ConflictException(`${monthLabel(month)} is already closed.`);
        const now = new Date();
        const saved = await tx.salesMonthStatus.upsert({
          where: { clientId_month: { clientId, month } },
          create: { clientId, month, state: 'CLOSED', closedAt: now, closedById: user.sub },
          update: { state: 'CLOSED', closedAt: now, closedById: user.sub },
        });
        await tx.auditLog.create({
          data: {
            action: 'UPDATE',
            entityType: 'SALES_MONTH',
            entityId: `${clientId}:${month}`,
            actorId: user.sub,
            oldValues: { state: st.state, implicit: st.implicit },
            newValues: { state: 'CLOSED', action: 'close' },
            metadata: { clientId, month, action: 'close', lastAppliedAt: saved.lastAppliedAt?.toISOString() ?? null },
          },
        });
        return saved;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const downstream = (await downstreamArtifacts(this.prisma, clientId, [month])).get(month);
    const history = (await historyMetaByMonth(this.prisma, clientId, [month])).get(month);
    const targetAt = (await this.targetChangeTimes(clientId, [month])).get(month);
    return this.toRow(month, currentMonthKey(), row, await this.userNames([row.closedById]), downstream, history, targetAt);
  }

  /**
   * GIFSY_ADMIN working inside the tenant (assumed) only — the controller's @Roles is the first gate.
   * M5: when credit batches / points exports already exist for the month, reopening needs
   * `acknowledgeDownstream: true` (409 otherwise, listing them); the response carries the same warnings.
   */
  async reopen(user: JwtPayload, month: string, body: SalesMonthReopenRequest = {}): Promise<SalesMonthReopenResult> {
    // THIS role check is the REAL reopen gate — do not remove it. The route's @Roles('GIFSY_ADMIN') does NOT keep
    // staff out: RolesGuard admits a GIFSY_STAFF past @Roles on any route carrying a @RequirePermission (here
    // targets:upload — RBAC Option-X), so an assumed staff member holding targets:upload reaches this method.
    // Reopen stays owner-only (owner 2026-11-25). Spec: sales-months.spec.ts "staff with targets:upload … 403".
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Only a Gifsy admin can reopen a month.');
    if (!user.assumed) throw new BadRequestException('Assume the tenant to reopen a month.');
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    const clientId = user.clientId;
    const ack = body?.acknowledgeDownstream === true;
    let warnings: string[] = [];
    let downstream: Downstream = { ...NO_DOWNSTREAM };
    const row = await this.prisma.$transaction(
      async (tx) => {
        await lockSalesMonth(tx, clientId, month);
        await assertNoActiveJob(tx, clientId, month); // under the month lock (final review L4)
        const existing = await tx.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
        const st = resolveMonthState(month, currentMonthKey(), existing);
        if (st.relation === 'CURRENT' || st.relation === 'FUTURE') {
          throw new ConflictException(`${monthLabel(month)} is not closed (it is the current or a future month).`);
        }
        if (st.state === 'OPEN') throw new ConflictException(`${monthLabel(month)} is already open.`);
        downstream = (await downstreamArtifacts(tx, clientId, [month])).get(month)!;
        warnings = downstreamWarnings(month, downstream);
        if (warnings.length > 0 && !ack) {
          throw new ConflictException(`Reopening ${monthLabel(month)} needs confirmation: ${warnings.join(' ')}`);
        }
        const now = new Date();
        const saved = await tx.salesMonthStatus.upsert({
          where: { clientId_month: { clientId, month } },
          create: { clientId, month, state: 'OPEN', reopenedAt: now, reopenedById: user.sub },
          update: { state: 'OPEN', reopenedAt: now, reopenedById: user.sub },
        });
        await tx.auditLog.create({
          data: {
            action: 'UPDATE',
            entityType: 'SALES_MONTH',
            entityId: `${clientId}:${month}`,
            actorId: user.sub,
            oldValues: { state: st.state, implicit: st.implicit },
            newValues: { state: 'OPEN', action: 'reopen' },
            metadata: { clientId, month, action: 'reopen', acknowledgedDownstream: warnings.length > 0, downstream },
          },
        });
        return saved;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const history = (await historyMetaByMonth(this.prisma, clientId, [month])).get(month);
    const targetAt = (await this.targetChangeTimes(clientId, [month])).get(month);
    return { ...this.toRow(month, currentMonthKey(), row, await this.userNames([row.closedById]), downstream, history, targetAt), warnings };
  }

  /**
   * "Rebuild product list" (§10c): side-effect-free on figures — under the SAME blocking month lock as apply, in one
   * transaction, DELETE the month's combos summary and rebuild it FROM the stored history lines, then stamp the header
   * with its own source. Allowed for OPEN and CLOSED months (no achievement / KPI value / history line changes). Audited.
   */
  async rebuildProductList(user: JwtPayload, month: string): Promise<SalesMonthRebuildProductListResult> {
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    // A month outside the history window (retention-window.ts) is being deleted by the sweep: nothing to rebuild (the
    // same cutoff as every reader), and the 404 says why.
    if (isBeyondHistoryRetention(month)) throw new NotFoundException(historyRetentionMessage(month));
    const clientId = user.clientId;
    try {
      await this.prisma.$transaction(
        async (tx) => {
          // Constant (SET takes no bind parameters); bounds the lock wait and every statement below.
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REBUILD_PRODUCT_LIST_STATEMENT_TIMEOUT_MS}`);
          await lockSalesMonth(tx, clientId, month);
          const header = await tx.salesMonthHistorySet.findUnique({
            where: { clientId_month: { clientId, month } },
            select: { sourceImportId: true, appliedAt: true, combosSourceImportId: true, combosAppliedAt: true },
          });
          if (!header) throw new NotFoundException(`${monthLabel(month)} has no stored sales lines.`);
          await tx.$executeRaw(Prisma.sql`DELETE FROM "sales_month_history_combos" WHERE "clientId" = ${clientId} AND "month" = ${month}`);
          const combos = await tx.$executeRaw(insertMonthCombosSql(clientId, month, header.sourceImportId, header.appliedAt));
          // updateMany: a retention purge between the read and here leaves no header → 404, and the tx rolls back.
          const stamped = await tx.salesMonthHistorySet.updateMany({
            where: { clientId, month },
            data: { combosSourceImportId: header.sourceImportId, combosAppliedAt: header.appliedAt },
          });
          if (stamped.count === 0) throw new NotFoundException(`${monthLabel(month)} has no stored sales lines.`);
          await tx.auditLog.create({
            data: {
              action: 'UPDATE',
              entityType: 'SALES_MONTH',
              entityId: `${clientId}:${month}`,
              actorId: user.sub,
              oldValues: { combosSourceImportId: header.combosSourceImportId, combosAppliedAt: header.combosAppliedAt?.toISOString() ?? null },
              newValues: { action: 'rebuild-product-list', combos: Number(combos), sourceImportId: header.sourceImportId },
              metadata: { clientId, month, action: 'rebuild-product-list' },
            },
          });
        },
        { timeout: REBUILD_PRODUCT_LIST_TX_TIMEOUT_MS, maxWait: 10_000 },
      );
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/statement timeout|canceling statement|57014|expired|already closed|P2028/i.test(msg) || (e as { code?: unknown })?.code === 'P2028') {
        throw new ConflictException(`${monthLabel(month)} is busy (a sales file is being applied, or the list is very large). Try again in a few minutes.`);
      }
      throw e;
    }
    const [row, downstream, history, targetTimes] = await Promise.all([
      this.prisma.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } }),
      downstreamArtifacts(this.prisma, clientId, [month]),
      historyMetaByMonth(this.prisma, clientId, [month]),
      this.targetChangeTimes(clientId, [month]),
    ]);
    return this.toRow(
      month, currentMonthKey(), row, await this.userNames([row?.closedById]), downstream.get(month), history.get(month), targetTimes.get(month),
    );
  }

  // ─── FOCUS-FROM-TARGETS: "Accept — not sold yet" (design §5) ──────────────────────────────────────────────────

  /** The month's accepted UNMATCHED focus tokens. */
  async listAcceptances(clientId: string, month: string): Promise<FocusAcceptanceList> {
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    return { month, acceptances: await listFocusAcceptances(this.prisma, clientId, month) };
  }

  /**
   * POST admin/sales-months/:month/focus-acceptances — accept an UNMATCHED focus token of a TARGET_NAMES KPI as "not sold
   * yet" for this month (it then counts as 0 and no longer blocks). Under the month lock; month must be OPEN (409);
   * kpiCode must be an enabled TARGET_NAMES definition (400); the key is normalized with focusKey. Idempotent (an
   * existing acceptance is kept as it is, no second audit row). Audited.
   */
  async accept(user: JwtPayload, month: string, body: FocusAcceptanceRequest): Promise<FocusAcceptanceList> {
    const { kpiCode, key, namesKpi } = await this.acceptanceArgs(user.clientId, month, body?.kpiCode, body?.key);
    const clientId = user.clientId;
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockOpenMonth(tx, clientId, month);
        await this.assertKeyInMonthTargets(tx, clientId, month, namesKpi, key);
        const existing = await tx.salesFocusAcceptance.findUnique({ where: { clientId_month_kpiCode_key: { clientId, month, kpiCode, key } } });
        if (existing) return;
        const row = await tx.salesFocusAcceptance.create({ data: { clientId, month, kpiCode, key, acceptedById: user.sub } });
        await tx.auditLog.create({
          data: {
            action: 'CREATE',
            entityType: 'SALES_FOCUS_ACCEPTANCE',
            entityId: row.id,
            actorId: user.sub,
            newValues: { month, kpiCode, key, acceptedAt: row.acceptedAt.toISOString() },
            metadata: { clientId, month, kpiCode, key, action: 'accept-not-sold-yet' },
          },
        });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return this.listAcceptances(clientId, month);
  }

  /** DELETE admin/sales-months/:month/focus-acceptances?kpiCode=&key= — remove an acceptance (idempotent). Audited. */
  async unaccept(user: JwtPayload, month: string, rawKpiCode: unknown, rawKey: unknown): Promise<FocusAcceptanceList> {
    const clientId = user.clientId;
    const { kpiCode, key } = await this.acceptanceArgs(clientId, month, rawKpiCode, rawKey, { requireDefinition: false });
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockOpenMonth(tx, clientId, month);
        const existing = await tx.salesFocusAcceptance.findUnique({ where: { clientId_month_kpiCode_key: { clientId, month, kpiCode, key } } });
        if (!existing) return;
        await tx.salesFocusAcceptance.delete({ where: { id: existing.id } });
        await tx.auditLog.create({
          data: {
            action: 'DELETE',
            entityType: 'SALES_FOCUS_ACCEPTANCE',
            entityId: existing.id,
            actorId: user.sub,
            oldValues: {
              month, kpiCode, key, acceptedById: existing.acceptedById, acceptedAt: existing.acceptedAt.toISOString(),
            },
            metadata: { clientId, month, kpiCode, key, action: 'undo-accept-not-sold-yet' },
          },
        });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return this.listAcceptances(clientId, month);
  }

  private async acceptanceArgs(
    clientId: string,
    month: string,
    rawKpiCode: unknown,
    rawKey: unknown,
    opts: { requireDefinition: boolean } = { requireDefinition: true },
  ): Promise<{ kpiCode: string; key: string; namesKpi: string }> {
    if (!isMonthKey(month)) throw new BadRequestException('month must be YYYY-MM.');
    const kpiCode = typeof rawKpiCode === 'string' ? rawKpiCode.trim() : '';
    if (!kpiCode) throw new BadRequestException('kpiCode is required.');
    if (typeof rawKey !== 'string') throw new BadRequestException('key is required.');
    const key = focusKey(rawKey);
    if (!key) throw new BadRequestException('key is required.');
    if (key.length > FOCUS_ACCEPTANCE_MAX_KEY || /[&,]/.test(key)) {
      throw new BadRequestException('key must be ONE focus product as written in the target file (not a list).');
    }
    if (opts.requireDefinition) {
      const def = await this.prisma.salesKpiDefinition.findFirst({
        where: { clientId, kpiCode, enabled: true, productSource: 'TARGET_NAMES' },
        select: { id: true, focusNamesFromKpi: true },
      });
      if (!def) throw new BadRequestException(`"${kpiCode}" is not a Sales Import KPI whose products come from the target file.`);
      // FOCUS-NAMES-FROM-KPI: a borrowing KPI's names are written under the KPI it borrows from.
      const from = typeof def.focusNamesFromKpi === 'string' ? def.focusNamesFromKpi.trim() : '';
      return { kpiCode, key, namesKpi: from === '' ? kpiCode : from };
    }
    return { kpiCode, key, namesKpi: kpiCode };
  }

  /**
   * Audit follow-up: only a product name that the month's target file actually carries for this KPI can be accepted
   * (a stray key would sit in the table, silently pre-accepting a future typo). Cheap: the month's target rows' names for
   * the KPI, split into tokens — no catalogue needed.
   */
  private async assertKeyInMonthTargets(
    tx: Prisma.TransactionClient,
    clientId: string,
    month: string,
    kpiCode: string,
    key: string,
  ): Promise<void> {
    const rows = await tx.outletTarget.findMany({ where: { clientId, month }, select: { targetValues: true } });
    for (const r of rows) {
      const name = targetRowOf(r.targetValues).names[kpiCode];
      if (name && splitFocusName(name).some((t) => focusKey(t) === key)) return;
    }
    const label = ((await kpiLabelsOf(tx, clientId, [kpiCode])).get(kpiCode) ?? '').trim() || kpiCode;
    throw new BadRequestException(`"${key}" is not a product name in the ${monthLabel(month)} target file for ${label}.`);
  }

  /** Month lock + the month must be OPEN (acceptances change what an apply / recalculate of the month would write). */
  private async lockOpenMonth(tx: Prisma.TransactionClient, clientId: string, month: string): Promise<void> {
    await lockSalesMonth(tx, clientId, month);
    const override = await tx.salesMonthStatus.findUnique({ where: { clientId_month: { clientId, month } } });
    const st = resolveMonthState(month, currentMonthKey(), override);
    if (st.state !== 'OPEN') throw new ConflictException(`${monthLabel(month)} is CLOSED. Only Gifsy can reopen it.`);
  }

  private toRow(
    month: string,
    current: string,
    row: SalesMonthStatus | null,
    names: Map<string, string>,
    downstream: Downstream = NO_DOWNSTREAM,
    history?: HistoryMeta,
    /** When the month's target rows were last written — ONLY for a tenant with a TARGET_NAMES KPI (targetChangeTimes). */
    targetUploadedAt?: Date,
    /** The month's queued / running Apply / Recalculate (list only; close / reopen refuse while one exists). */
    activeJob?: SalesMonthActiveJob,
    lastJob?: SalesMonthLastJob,
  ): SalesMonthRow {
    const st = resolveMonthState(month, current, row);
    const closedExplicit = st.state === 'CLOSED' && !st.implicit;
    return {
      month,
      state: st.state,
      implicit: st.implicit,
      closedAt: closedExplicit && row?.closedAt ? row.closedAt.toISOString() : null,
      closedBy: closedExplicit && row?.closedById ? (names.get(row.closedById) ?? null) : null,
      lastAppliedAt: row?.lastAppliedAt ? row.lastAppliedAt.toISOString() : null,
      lastAppliedImportId: row?.lastAppliedImportId ?? null,
      canClose: st.canClose,
      canReopen: st.canReopen,
      downstream: { ...downstream },
      hasHistory: !!history,
      historySourceImportId: history?.sourceImportId ?? null,
      historyAppliedAt: history ? history.appliedAt.toISOString() : null,
      productListCurrent: !history || ['current', 'empty'].includes(classifyMonthSummaries([{ month, ...history }]).get(month)!),
      // FOCUS-FROM-TARGETS §11: targets uploaded after the month's last apply (apply or recalculate) → "recalculate".
      // targetChangeTimes is empty for a tenant without a TARGET_NAMES KPI (B-M1) → always false there.
      targetsChangedSinceApply: targetsNewerThanApply(targetUploadedAt ?? null, row?.lastAppliedAt ?? null, targetUploadedAt !== undefined),
      activeJob: activeJob ?? null,
      lastJob: lastJob ?? null,
    };
  }

  /**
   * FOCUS-FROM-TARGETS §11 / audit follow-up: month → when its target ROWS were last written (MAX updatedAt, one GROUP BY
   * for every month) — but only when the tenant has an enabled TARGET_NAMES definition. Without one the targets change no
   * applied figure, so "Targets changed — recalculate" must never show (and the target table is not read at all).
   */
  private async targetChangeTimes(clientId: string, months: string[]): Promise<Map<string, Date>> {
    if (!(await tenantHasTargetNamesDef(this.prisma, clientId))) return new Map();
    return latestTargetWriteByMonth(this.prisma, clientId, months);
  }

  private async userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (list.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
