import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentMonthKey } from '../../targets/targets.helpers';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { SalesKpiDefService } from '../kpi/sales-kpi-def.service';
import { definitionsHash, stableStringify } from '../kpi/sales-kpi.helper';
import { mappingFingerprint } from '../ingest/mapping-fingerprint';
import type { SalesColumnMapping } from '../sales-import.contract';
import { lastDayOfMonth, monthLabel as monthLabelOf, shiftMonthKey } from '../months/month-state';
import { SalesPreviewService } from './sales-preview.service';
import { SalesApplyService, outletsAffected } from './sales-apply.service';
import { withRetentionV2 } from '../retention-env.testspec';

// ─── Date-relative months ──────────────────────────────────────────────────────
const CUR = currentMonthKey();
const PREV = shiftMonthKey(CUR, -1);
const OLD = shiftMonthKey(CUR, -2);
const FUT = shiftMonthKey(CUR, 1);
const AT = new Date();

const user: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'Admin' };

const DEF_ROWS = [
  { id: 'd1', clientId: 't1', kpiCode: 'OWN_AMT', measure: 'AMOUNT', filter: { anyOf: [{ dimA: 'P' }] }, outletTypes: [], programs: [], enabled: true, order: 0 },
  { id: 'd2', clientId: 't1', kpiCode: 'OWN_QTY', measure: 'QUANTITY', filter: {}, outletTypes: ['WHOLESALER'], programs: [], enabled: true, order: 1 },
];
const LITE = DEF_ROWS.map((d) => ({ kpiCode: d.kpiCode, measure: d.measure as 'AMOUNT' | 'QUANTITY', filter: d.filter, outletTypes: d.outletTypes, programs: d.programs }));
const HASH = definitionsHash(LITE);
const MAPPING: SalesColumnMapping = {
  headerRow: 'auto', outletCode: 'CODE', invoiceDate: 'DATE', amount: 'AMT', quantity: 'QTY',
  dimensions: [{ key: 'dimA', label: 'A', header: 'A' }, { key: 'dimB', label: 'B', header: 'B' }], dateOrder: 'DMY',
};
const VERSION = 3;

const ROSTER = [
  { id: 'id-O1', outletCode: 'O1', name: 'One', programName: null, outletType: { code: 'WHOLESALER' } },
  { id: 'id-O2', outletCode: 'O2', name: 'Two', programName: null, outletType: { code: 'RETAIL' } },
  { id: 'id-O3', outletCode: 'O3', name: 'Three', programName: null, outletType: { code: 'RETAIL' } }, // no lines → zero-fill
];
const summary = (month: string, over: Record<string, unknown> = {}) => ({
  month,
  firstDate: `${month}-01`,
  lastDate: month === CUR ? `${month}-02` : lastDayOfMonth(month),
  lines: 3,
  matchedOutlets: 2,
  unmatchedCustomers: 1,
  matchedAmountRupees: 0,
  matchedQuantity: 0,
  unmatchedAmountRupees: 0,
  unmatchedQuantity: 0,
  ...over,
});
/** sales-day-level: every fixture aggregate carries its day split (default: one line on day 3). `days: null` = processed before day-level storage. */
const agg = (
  id: number, month: string, outletCode: string, dims: Record<string, string>, amountPaise: bigint, qtyMicro: bigint,
  days: Array<[number, string, string, number]> | null = [[3, String(amountPaise), String(qtyMicro * 1_000_000n), 1]],
) => ({
  id: BigInt(id), importId: 'imp1', month, outletCode, dims, dimKey: stableStringify(dims), amountPaise, qtyPico: qtyMicro * 1_000_000n, lines: 1, days,
});

function makeDb(opts: {
  months?: string[];
  statuses?: Array<Record<string, unknown>>;
  existing?: Array<Record<string, unknown>>;
  defs?: Array<{
    id: string; clientId: string; kpiCode: string; measure: string; filter: Record<string, unknown>;
    outletTypes: string[]; programs: string[]; enabled: boolean; order: number; productSource?: string;
  }>;
  /** The mapping the import was processed with AND the tenant's current profile (unless `profile` overrides it). */
  mapping?: SalesColumnMapping;
  /** Replaces the default aggregates (aggregate-shaped rows of import imp1). */
  aggs?: Array<ReturnType<typeof agg>>;
  /** The newest SalesImportApply of the month (another import `imp0` whose latest invoice in the month is `lastDate`). */
  lastApply?: { lastDate: string } | null;
  roster?: Array<Record<string, unknown>>;
  /** Stored month history (SalesMonthHistory rows, aggregate-shaped with customerCode). */
  history?: Array<Record<string, unknown>>;
  historyAppliedAt?: Date;
  /** The stored set's header: mapping fingerprint + dimension keys its lines were parsed with. */
  historySet?: { mappingFingerprint?: string | null; dimensionKeys?: string[] };
  profile?: SalesColumnMapping;
  rosterAdded?: number;
  /** L4: KpiDef.outletType per KPI code (absent = a shared KPI). */
  kpiTypes?: Record<string, string | null>;
  /**
   * FOCUS-FROM-TARGETS: OutletTarget rows (any month). A row's updatedAt (when it was written) = its own `updatedAt`, else
   * its batch's time from `targetBatches`.
   */
  targets?: Array<{ outletCode: string; month: string; targetValues: Record<string, unknown>; batchId: string; updatedAt?: Date }>;
  targetBatches?: Array<{ id: string; createdAt: Date }>;
  /** Distinct product combos of the stored months (sales_month_history_combos). */
  historyCombos?: Array<Record<string, string>>;
  historyCombosAfterApply?: Array<Record<string, string>>;
  acceptances?: Array<{ month: string; kpiCode: string; key: string; acceptedById: string; acceptedAt: Date }>;
  /** Active job rows (activeJobsByMonth shape) for the preview. */
  activeJobs?: Array<Record<string, unknown>>;
  /** Finished job rows (lastJobsByMonth shape) for the preview. */
  lastJobs?: Array<Record<string, unknown>>;
  /** Extra KpiDef rows (code + label) beyond OWN_AMT / OWN_QTY. */
  extraKpis?: Array<{ code: string; label: string }>;
} = {}) {
  const months = opts.months ?? [PREV, CUR];
  const log: string[] = [];
  const aggs = opts.aggs ?? months.flatMap((m, i) => [
    agg(i * 10 + 1, m, 'O1', { dimA: 'P', dimB: '500' }, 10000n, 1_500000n),
    agg(i * 10 + 2, m, 'O1', { dimA: 'Q', dimB: '500' }, 5000n, 500000n),
    agg(i * 10 + 3, m, 'O2', { dimA: 'P', dimB: '50' }, -2500n, 0n),
    agg(i * 10 + 4, m, 'GONE', { dimA: 'P', dimB: '50' }, 99999n, 0n), // not on the CURRENT roster → never written
    agg(i * 10 + 5, m, 'O4', { dimA: 'P', dimB: '50' }, 700n, 0n), // only written if O4 is on the roster at apply time
  ]);
  const imp: Record<string, unknown> & { monthSummaries: unknown; processingVersion: number } = {
    id: 'imp1', clientId: 't1', status: 'READY', createdAt: AT, finishedAt: AT, purgedAt: null,
    processingVersion: VERSION, mappingFingerprint: mappingFingerprint(opts.mapping ?? MAPPING),
    mappingSnapshot: opts.mapping ?? MAPPING,
    monthSummaries: months.map((m) => summary(m)),
  };
  const lastImp = { id: 'imp0', monthSummaries: months.map((m) => summary(m, { lastDate: opts.lastApply?.lastDate ?? `${m}-28` })) };
  const statuses = opts.statuses ?? [];
  const db = {
    log,
    imp,
    salesImport: {
      findFirst: jest.fn(async ({ where }: { where: { id?: string; clientId: string } }) =>
        where.clientId !== 't1' ? null : where.id === 'imp0' ? lastImp : !where.id || where.id === 'imp1' ? imp : null),
    },
    salesImportProfile: { findUnique: jest.fn(async () => ({ columnMapping: opts.profile ?? opts.mapping ?? MAPPING })) },
    salesMonthHistorySet: {
      findUnique: jest.fn(async () =>
        opts.history
          ? {
              sourceImportId: 'imp0',
              appliedAt: opts.historyAppliedAt ?? AT,
              mappingFingerprint: opts.historySet?.mappingFingerprint === undefined ? mappingFingerprint(MAPPING) : opts.historySet.mappingFingerprint,
              dimensionKeys: opts.historySet?.dimensionKeys ?? ['dimA', 'dimB'],
            }
          : null),
      upsert: jest.fn(async (a: unknown) => { log.push('history.set'); return a; }),
    },
    salesMonthHistory: {
      findMany: jest.fn(async ({ where, take }: { where: { month: string; id?: { gt: bigint } }; take: number }) =>
        (opts.history ?? []).filter((h) => h.month === where.month && (!where.id || (h.id as bigint) > where.id.gt)).slice(0, take)),
    },
    // lockImportRow(…, 'SHARE') — H1: the apply holds the import row FOR SHARE
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      const text = q.strings.join('?');
      // Background jobs: the active Apply / Recalculate of the previewed months (none unless a test sets them).
      if (text.includes('DISTINCT ON (m."month")')) return opts.lastJobs ?? [];
      if (text.includes('FROM "sales_apply_job_months"')) return opts.activeJobs ?? [];
      // FOCUS-FROM-TARGETS catalogue reads (only for a tenant with a TARGET_NAMES definition)
      if (text.includes('FROM "sales_month_history_combos"')) {
        // `historyCombosAfterApply`: what the stored product lists hold once a month's apply rewrote its own list
        const combos = opts.historyCombosAfterApply && log.includes('combos.insert') ? opts.historyCombosAfterApply : (opts.historyCombos ?? []);
        return combos.map((d) => ({ dims: JSON.stringify(d) }));
      }
      if (text.includes('FROM "sales_import_aggregates"')) {
        return [...new Set(aggs.map((a) => a.dimKey))].map((k) => ({ dims: k }));
      }
      log.push(`import.${/FOR (\w+)/.exec(q.strings.join('?'))?.[1]?.toLowerCase()}`);
      return q.values[0] === 'imp1' && q.values[1] === 't1' ? [{ ...imp }] : [];
    }),
    salesKpiDefinition: { findMany: jest.fn(async () => opts.defs ?? DEF_ROWS) },
    outlet: { findMany: jest.fn(async () => opts.roster ?? ROSTER), count: jest.fn(async () => opts.rosterAdded ?? 0) },
    kpiDef: {
      findMany: jest.fn(async () => [
        { code: 'OWN_AMT', label: 'Owned ₹', outletType: opts.kpiTypes?.OWN_AMT ?? null },
        { code: 'OWN_QTY', label: 'Owned cases', outletType: opts.kpiTypes?.OWN_QTY ?? null },
        ...(opts.extraKpis ?? []).map((k) => ({ ...k, outletType: null })),
      ]),
    },
    outletTarget: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string; month: string } }) =>
        where.clientId !== 't1'
          ? []
          : (opts.targets ?? [])
              .filter((t) => t.month === where.month)
              .map((t) => ({ ...t, updatedAt: t.updatedAt ?? (opts.targetBatches ?? []).find((b) => b.id === t.batchId)?.createdAt ?? AT }))),
    },
    targetUploadBatch: {
      aggregate: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const times = (opts.targetBatches ?? []).filter((b) => where.id.in.includes(b.id)).map((b) => b.createdAt.getTime());
        return { _max: { createdAt: times.length ? new Date(Math.max(...times)) : null } };
      }),
    },
    salesFocusAcceptance: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string; month: string } }) =>
        where.clientId !== 't1' ? [] : (opts.acceptances ?? []).filter((a) => a.month === where.month)),
    },
    salesMonthStatus: {
      findMany: jest.fn(async () => statuses),
      findUnique: jest.fn(async ({ where }: { where: { clientId_month: { month: string } } }) =>
        statuses.find((s) => s.month === where.clientId_month.month) ?? null),
      upsert: jest.fn(async (a: unknown) => { log.push('status.upsert'); return a; }),
    },
    salesImportAggregate: {
      findMany: jest.fn(async ({ where, take }: { where: { month?: string; id?: { gt: bigint } }; take: number }) =>
        aggs
          .filter((a) => (!where.month || a.month === where.month) && (!where.id || a.id > where.id.gt))
          .slice(0, take)),
    },
    outletSalesRecord: {
      findMany: jest.fn(async () => opts.existing ?? []),
    },
    salesImportApply: {
      findFirst: jest.fn(async () =>
        opts.lastApply ? { importId: 'imp0', createdAt: AT, appliedById: 'u0', definitionsSnapshot: DEF_ROWS } : null),
      create: jest.fn(async () => { log.push('apply.create'); return { id: 'apply1' }; }),
    },
    salesUploadBatch: { create: jest.fn(async (a: { data: Record<string, unknown> }) => { log.push('batch.create'); return { id: 'batch1', ...a.data }; }) },
    auditLog: { create: jest.fn(async () => { log.push('audit'); return {}; }) },
    salesDaySet: {
      upsert: jest.fn(async (a: unknown) => { log.push('dayset.upsert'); return a; }),
      deleteMany: jest.fn(async () => { log.push('dayset.delete'); return { count: 1 }; }),
    },
    user: {
      findUnique: jest.fn(async () => ({ name: 'Applier' })),
      findMany: jest.fn(async () => [{ id: 'u1', name: 'Admin' }]),
    },
    $executeRaw: jest.fn(async (q: Prisma.Sql | TemplateStringsArray) => {
      const text = 'strings' in (q as Prisma.Sql) ? (q as Prisma.Sql).strings.join('?') : (q as TemplateStringsArray).join('?');
      log.push(
        text.includes('pg_advisory_xact_lock') ? 'lock'
          : text.includes('outlet_sales_days') ? (text.includes('DELETE') ? 'days.delete' : 'days.insert')
          : text.includes('sales_month_history_combos') ? (text.includes('DELETE') ? 'combos.delete' : 'combos.insert')
          : text.includes('sales_month_histories') ? (text.includes('DELETE') ? 'history.delete' : 'history.insert')
          : text.includes('INSERT') ? 'insert' : 'strip',
      );
      return 1;
    }),
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
  };
  return db;
}

function services(db: ReturnType<typeof makeDb>) {
  const defs = new SalesKpiDefService(db as never);
  return { preview: new SalesPreviewService(db as never, defs), apply: new SalesApplyService(db as never, defs) };
}

const sqlCalls = (db: ReturnType<typeof makeDb>) =>
  db.$executeRaw.mock.calls.map((c) => c[0] as unknown as Prisma.Sql).map((q) => ({ text: q.strings.join('?'), values: q.values }));

// ─── PREVIEW ─────────────────────────────────────────────────────────────────

describe('SalesPreviewService', () => {
  it('cross-tenant / unknown import → 404', async () => {
    const db = makeDb();
    await expect(services(db).preview.preview('t1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('computes new totals (roster-only, scope-aware, zero-fill) and deltas vs current rows', async () => {
    const db = makeDb({
      existing: [
        { outletCode: 'O1', kpiValues: { OWN_AMT: 40, MANUAL: 7 }, batch: { status: 'COMPLETED', createdAt: AT } },
      ],
    });
    const p = await services(db).preview.preview('t1', 'imp1');
    expect(p.definitionsHash).toBe(HASH);
    expect(p).toMatchObject({ processingVersion: VERSION, mappingChanged: false, rosterOutletsAddedSinceProcessing: 0 });
    const prev = p.months.find((m) => m.month === PREV)!;
    const amt = prev.kpis.find((k) => k.kpiCode === 'OWN_AMT')!;
    // O1: P 100.00 ; O2: P -25.00 ; GONE ignored ; O3 zero → 75
    expect(amt).toEqual(expect.objectContaining({ newTotal: 75, currentTotal: 40, delta: 35, outletsNonZero: 2, outletsNegative: 1, label: 'Owned ₹' }));
    const qty = prev.kpis.find((k) => k.kpiCode === 'OWN_QTY')!;
    expect(qty.newTotal).toBe(2); // only O1 is a WHOLESALER: 1.5 + 0.5
    expect(prev.zeroFillOutlets).toBe(1); // O3
    expect(prev.warnings).toEqual(expect.arrayContaining(['NEGATIVE_VALUES', 'REPLACES_MANUAL_VALUES']));
    expect(prev.canApply).toBe(true);
    expect(prev.monthState).toBe('OPEN');
    // M6: matched / unmatched recomputed against the CURRENT roster (GONE + O4 are not on it)
    expect(prev).toMatchObject({ matchedOutlets: 2, unmatchedCustomers: 2, matchedAmountRupees: 125, unmatchedAmountRupees: 1006.99 });
  });

  it('partial months warn; the CURRENT month never gets ENDS_BEFORE_MONTH_END', async () => {
    const db = makeDb();
    db.imp.monthSummaries = [summary(PREV, { firstDate: `${PREV}-05`, lastDate: `${PREV}-20` }), summary(CUR)];
    const p = await services(db).preview.preview('t1', 'imp1');
    expect(p.months[0].warnings).toEqual(expect.arrayContaining(['STARTS_AFTER_FIRST', 'ENDS_BEFORE_MONTH_END']));
    expect(p.months[1].warnings).not.toContain('ENDS_BEFORE_MONTH_END');
  });

  it('M6: an outlet added to the roster AFTER processing is included (no ROSTER_CHANGED block); the count is informational', async () => {
    const roster = [...ROSTER, { outletCode: 'O4', name: 'Four', programName: null, outletType: { code: 'RETAIL' } }];
    const p = await services(makeDb({ roster, rosterAdded: 1 })).preview.preview('t1', 'imp1');
    expect(p.rosterOutletsAddedSinceProcessing).toBe(1);
    const prev = p.months.find((m) => m.month === PREV)!;
    expect(prev.canApply).toBe(true);
    expect(prev.kpis.find((k) => k.kpiCode === 'OWN_AMT')!.newTotal).toBe(82); // 100 - 25 + O4's 7
    expect(prev).toMatchObject({ matchedOutlets: 3, unmatchedCustomers: 1 });
  });

  it('H2: a changed column mapping blocks every month with a clear reason', async () => {
    const p = await services(makeDb({ profile: { ...MAPPING, amount: 'GROSS' } })).preview.preview('t1', 'imp1');
    expect(p.mappingChanged).toBe(true);
    for (const m of p.months) {
      expect(m.canApply).toBe(false);
      expect(m.blockedReason).toMatch(/column mapping changed.*Reprocess/);
    }
    // a label-only change is NOT a mapping change
    const same = await services(makeDb({ profile: { ...MAPPING, dimensions: MAPPING.dimensions.map((d) => ({ ...d, label: 'x' })) } })).preview.preview('t1', 'imp1');
    expect(same.mappingChanged).toBe(false);
  });

  it('a CLOSED month and an implicitly-closed older month are blocked; a future month is blocked', async () => {
    const db = makeDb({ months: [OLD, PREV, FUT], statuses: [{ month: PREV, state: 'CLOSED', closedAt: AT, lastAppliedImportId: null }] });
    const p = await services(db).preview.preview('t1', 'imp1');
    const by = Object.fromEntries(p.months.map((m) => [m.month, m]));
    expect(by[OLD]).toEqual(expect.objectContaining({ monthState: 'CLOSED', canApply: false }));
    expect(by[PREV]).toEqual(expect.objectContaining({ monthState: 'CLOSED', canApply: false }));
    expect(by[PREV].blockedReason).toMatch(/Only Gifsy can reopen/);
    expect(by[FUT]).toEqual(expect.objectContaining({ canApply: false }));
    expect(by[FUT].blockedReason).toMatch(/not started/);
  });

  it('UX-1: OLDER_THAN_LAST_APPLIED compares DATA recency (latest invoice date in the month), not upload time; both dates exposed', async () => {
    // imp1 covers PREV to its last day; the last-applied imp0 ends EARLIER → imp1 is newer data, no warning
    const newer = await services(makeDb({ lastApply: { lastDate: `${PREV}-10` } })).preview.preview('t1', 'imp1');
    const m1 = newer.months.find((m) => m.month === PREV)!;
    expect(m1.warnings).not.toContain('OLDER_THAN_LAST_APPLIED');
    expect(m1.lastApplied).toEqual(expect.objectContaining({ importId: 'imp0', lastInvoiceDate: `${PREV}-10`, byName: 'Applier' }));
    expect(m1.lastDate).toBe(lastDayOfMonth(PREV));
    // imp0 had data up to the 28th, this file (partial) only to the 20th → older data
    const db = makeDb({ lastApply: { lastDate: `${PREV}-28` } });
    db.imp.monthSummaries = [summary(PREV, { lastDate: `${PREV}-20` })];
    const older = await services(db).preview.preview('t1', 'imp1');
    expect(older.months[0].warnings).toContain('OLDER_THAN_LAST_APPLIED');
  });

  it('no owned KPI → every month blocked with a clear reason', async () => {
    const p = await services(makeDb({ defs: [] })).preview.preview('t1', 'imp1');
    expect(p.months.every((m) => !m.canApply && /No importer-owned KPIs/.test(m.blockedReason ?? ''))).toBe(true);
  });
});

// ─── APPLY ───────────────────────────────────────────────────────────────────

describe('SalesApplyService', () => {
  const body = (months: string[], over: Record<string, unknown> = {}) => ({ months, expectedDefinitionsHash: HASH, processingVersion: VERSION, ...over });

  it('definitions-hash mismatch → 409 BEFORE any transaction', async () => {
    const db = makeDb();
    await expect(services(db).apply.apply(user, 'imp1', body([PREV], { expectedDefinitionsHash: 'x' }))).rejects.toBeInstanceOf(ConflictException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('missing partial-month ack → 400 before any write; acked → applies', async () => {
    const db = makeDb();
    db.imp.monthSummaries = [summary(PREV, { firstDate: `${PREV}-05` })];
    await expect(services(db).apply.apply(user, 'imp1', body([PREV]))).rejects.toBeInstanceOf(BadRequestException);
    expect(db.$transaction).not.toHaveBeenCalled();
    const r = await services(db).apply.apply(user, 'imp1', body([PREV], { acknowledgePartialMonths: [PREV] }));
    expect(r.results[0].ok).toBe(true);
  });

  it('older-than-last-applied (data recency) needs its own ack', async () => {
    const db = makeDb({ lastApply: { lastDate: `${PREV}-28` } });
    db.imp.monthSummaries = [summary(PREV, { lastDate: `${PREV}-20` })];
    await expect(services(db).apply.apply(user, 'imp1', body([PREV], { acknowledgePartialMonths: [PREV] }))).rejects.toThrow(/older/);
    const r = await services(db).apply.apply(user, 'imp1', body([PREV], { acknowledgeOlderThanLastApplied: true, acknowledgePartialMonths: [PREV] }));
    expect(r.results[0].ok).toBe(true);
  });

  it('M7: the older-than-last-applied ack is re-checked UNDER the month lock (another import applied meanwhile)', async () => {
    const db = makeDb();
    db.imp.monthSummaries = [summary(PREV, { lastDate: `${PREV}-20` })];
    let calls = 0; // pre-check: no last apply; inside the locked tx: a newer-data import was applied meanwhile
    db.salesImportApply.findFirst.mockImplementation(async () =>
      calls++ === 0 ? null : ({ importId: 'imp0', createdAt: AT, appliedById: 'u0', definitionsSnapshot: DEF_ROWS } as never));
    const r = await services(db).apply.apply(user, 'imp1', body([PREV], { acknowledgePartialMonths: [PREV] }));
    expect(r.results[0]).toEqual(expect.objectContaining({ ok: false }));
    expect(r.results[0].error).toMatch(/older than in the file last applied/);
    expect(db.salesUploadBatch.create).not.toHaveBeenCalled();
  });

  it('M7: processingVersion — 409 before any tx when stale; a reprocess racing in → ok:false under the lock', async () => {
    const db = makeDb();
    await expect(services(db).apply.apply(user, 'imp1', body([PREV], { processingVersion: VERSION - 1 }))).rejects.toThrow(/reprocessed/);
    expect(db.$transaction).not.toHaveBeenCalled();
    await expect(services(db).apply.apply(user, 'imp1', { months: [PREV], expectedDefinitionsHash: HASH } as never)).rejects.toThrow(/processingVersion/);
    db.$queryRaw.mockImplementation(async () => [{ ...db.imp, processingVersion: VERSION + 1 }]);
    const r = await services(db).apply.apply(user, 'imp1', body([PREV]));
    expect(r.results[0].error).toMatch(/reprocessed/);
    expect(db.salesUploadBatch.create).not.toHaveBeenCalled();
  });

  it('H1: the import row is re-checked under FOR SHARE — no longer READY / purged → ok:false, nothing written', async () => {
    const db = makeDb();
    db.$queryRaw.mockImplementation(async () => [{ ...db.imp, status: 'QUEUED' }]);
    expect((await services(db).apply.apply(user, 'imp1', body([PREV]))).results[0].error).toMatch(/no longer READY/);
    db.$queryRaw.mockImplementation(async () => [{ ...db.imp, purgedAt: AT }]);
    expect((await services(db).apply.apply(user, 'imp1', body([PREV]))).results[0].error).toMatch(/retention/);
    expect(db.salesUploadBatch.create).not.toHaveBeenCalled();
  });

  it('H2: a changed column mapping → 409 before any tx', async () => {
    const db = makeDb({ profile: { ...MAPPING, quantity: 'CASES' } });
    await expect(services(db).apply.apply(user, 'imp1', body([PREV]))).rejects.toThrow(/column mapping changed/);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('happy path: lock FIRST, SALES_IMPORT batch, owned-only merge SQL, strip of other rows, history, pointer, audit', async () => {
    const db = makeDb();
    const r = await services(db).apply.apply(user, 'imp1', body([PREV]));
    expect(r.results).toEqual([{
      month: PREV, ok: true, applyId: 'apply1', outletsWritten: 3, outletsZeroFilled: 1,
      dayData: { written: true, outlets: 2, rows: 2, lastDay: Number(lastDayOfMonth(PREV).slice(8)) },
    }]);
    expect(db.log).toEqual(['lock', 'import.share', 'batch.create', 'insert', 'strip', 'history.delete', 'history.insert', 'combos.delete', 'combos.insert', 'history.set', 'days.delete', 'days.insert', 'dayset.upsert', 'apply.create', 'status.upsert', 'audit']);

    const sql = sqlCalls(db);
    expect(sql[0].values).toEqual([`sales-month:t1:${PREV}`]);
    const ins = sql[1];
    expect(ins.text).toContain(`- ?::text[]) || EXCLUDED."kpiValues"`);
    expect(ins.text).not.toMatch(/"batchId"\s*=\s*EXCLUDED/); // existing rows keep their batchId
    expect(ins.values).toContainEqual(['OWN_AMT', 'OWN_QTY']);
    expect(ins.values).toContainEqual(['O1', 'O2', 'O3']); // GONE never written
    expect(ins.values).toContainEqual([
      JSON.stringify({ OWN_AMT: 100, OWN_QTY: 2 }), // O1 wholesaler
      JSON.stringify({ OWN_AMT: -25 }), // O2 retail → OWN_QTY out of scope → omitted
      JSON.stringify({ OWN_AMT: 0 }), // O3 zero-filled
    ]);
    const strip = sql[2];
    expect(strip.text).toContain('NOT ("outletCode" = ANY(');
    expect(strip.values).toContainEqual(['O1', 'O2', 'O3']);

    const batch = db.salesUploadBatch.create.mock.calls[0][0].data;
    expect(batch).toEqual(expect.objectContaining({ clientId: 't1', month: PREV, status: 'SALES_IMPORT', totalRows: 3 }));
    const apply = (db.salesImportApply.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(apply).toEqual(expect.objectContaining({ definitionsHash: HASH, outletsWritten: 3, outletsZeroFilled: 1, batchId: 'batch1' }));
    expect(apply.totals).toEqual({ OWN_AMT: { before: 0, after: 75 }, OWN_QTY: { before: 0, after: 2 } });
    const audit = (db.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(audit).toEqual(expect.objectContaining({ action: 'IMPORT', entityType: 'SALES_MONTH', entityId: `t1:${PREV}`, actorId: 'u1' }));
    expect(audit.metadata).toEqual(expect.objectContaining({ clientId: 't1', applyId: 'apply1' }));
    // a first status row records the CURRENT resolved state with NO closedAt/reopenedAt (never an explicit override)
    const st = (db.salesMonthStatus.upsert.mock.calls[0] as unknown as [{ create: Record<string, unknown> }])[0].create;
    expect(st).toEqual(expect.objectContaining({ state: 'OPEN', lastAppliedImportId: 'imp1' }));
    expect(st.closedAt).toBeUndefined();
  });

  it('a CLOSED month → ok:false, nothing written for it; the other month still applies', async () => {
    const db = makeDb({ statuses: [{ month: PREV, state: 'CLOSED', closedAt: AT }] });
    const r = await services(db).apply.apply(user, 'imp1', body([PREV, CUR]));
    const by = Object.fromEntries(r.results.map((x) => [x.month, x]));
    expect(by[PREV].ok).toBe(false);
    expect(by[PREV].error).toMatch(/CLOSED/);
    expect(by[CUR].ok).toBe(true);
    expect(db.salesUploadBatch.create).toHaveBeenCalledTimes(1);
    expect(db.salesUploadBatch.create.mock.calls[0][0].data.month).toBe(CUR);
  });

  it('an unexpected DB error in one month is reported generically; others continue', async () => {
    const db = makeDb();
    let n = 0;
    db.salesUploadBatch.create.mockImplementation(async (a: { data: Record<string, unknown> }) => {
      if (n++ === 0) throw new Error('deadlock detected');
      return { id: 'batch2', ...a.data };
    });
    const r = await services(db).apply.apply(user, 'imp1', body([PREV, CUR]));
    expect(r.results[0]).toEqual(expect.objectContaining({ month: PREV, ok: false }));
    expect(r.results[0].error).not.toMatch(/deadlock/);
    expect(r.results[1]).toEqual(expect.objectContaining({ month: CUR, ok: true }));
  });

  it('a month not in the file → ok:false', async () => {
    const r1 = await services(makeDb()).apply.apply(user, 'imp1', body([OLD]));
    expect(r1.results[0]).toEqual(expect.objectContaining({ ok: false }));
    expect(r1.results[0].error).toMatch(/not in this file/);
  });

  it('M6: apply maps file codes onto the roster AT APPLY TIME (an outlet added after processing is written)', async () => {
    const roster = [...ROSTER, { outletCode: 'O4', name: 'Four', programName: null, outletType: { code: 'RETAIL' } }];
    const db = makeDb({ roster });
    const r = await services(db).apply.apply(user, 'imp1', body([PREV]));
    expect(r.results[0]).toEqual(expect.objectContaining({ ok: true, outletsWritten: 4 }));
    const ins = sqlCalls(db)[1];
    expect(ins.values).toContainEqual(['O1', 'O2', 'O3', 'O4']);
  });

  it('body validation', async () => {
    const s = services(makeDb()).apply;
    await expect(s.apply(user, 'imp1', { months: [], expectedDefinitionsHash: HASH, processingVersion: VERSION })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.apply(user, 'imp1', { months: ['2026-13'], expectedDefinitionsHash: HASH, processingVersion: VERSION })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.apply(user, 'imp1', { months: [PREV, PREV], expectedDefinitionsHash: HASH, processingVersion: VERSION })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.apply(user, 'imp1', { months: [PREV] } as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cross-tenant import id → 404', async () => {
    await expect(services(makeDb()).apply.apply({ ...user, clientId: 't2' }, 'imp1', body([PREV]))).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─── MONTH HISTORY + RECALCULATE (owner decision 2026-11-10) ─────────────────────────────────────────────────────

describe('month history', () => {
  const body = (months: string[]) => ({ months, expectedDefinitionsHash: HASH, processingVersion: VERSION });

  it('apply REPLACES the month history with this import’s lines (PROGRAMME outlets only — roster now — with their day split) inside the same tx', async () => {
    const db = makeDb();
    await services(db).apply.apply(user, 'imp1', body([PREV]));
    const sql = sqlCalls(db);
    const del = sql.find((q) => q.text.includes('DELETE FROM "sales_month_histories"'))!;
    expect(del.values).toEqual(['t1', PREV]);
    const ins = sql.find((q) => q.text.includes('INSERT INTO "sales_month_histories"'))!;
    expect(ins.text).toContain('FROM "sales_import_aggregates" a');
    // owner decision 2026-11-18: unmatched customers are NOT kept (inner join on the roster, outletId never null)
    expect(ins.text).not.toContain('LEFT JOIN');
    expect(ins.text).toMatch(/\bJOIN unnest\(/);
    expect(ins.text).toContain('r.id IS NOT NULL');
    expect(ins.text).toContain('a."days"'); // the day split travels with the line (recalculate can rebuild day data)
    expect(ins.text).toContain('md5(a."outletCode" || chr(31) || a."dimKey")'); // bounded unique key (final check L1)
    // the set header records the source import + the mapping its lines were parsed with (final check M1)
    const header = (db.salesMonthHistorySet.upsert.mock.calls[0] as unknown as [{ where: unknown; create: Record<string, unknown> }])[0];
    expect(header.where).toEqual({ clientId_month: { clientId: 't1', month: PREV } });
    expect(header.create).toEqual(expect.objectContaining({ sourceImportId: 'imp1', mappingFingerprint: mappingFingerprint(MAPPING), dimensionKeys: ['dimA', 'dimB'], appliedById: 'u1' }));
    expect(ins.values).toEqual(expect.arrayContaining(['t1', 'imp1', 'u1', ['O1', 'O2', 'O3'], ['id-O1', 'id-O2', 'id-O3'], PREV]));
    expect(db.log.indexOf('history.delete')).toBeLessThan(db.log.indexOf('history.insert'));
    expect(db.log.indexOf('history.insert')).toBeLessThan(db.log.indexOf('apply.create'));
    expect((db.salesImportApply.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data.source).toBe('IMPORT');
  });

  it('audit M1: the per-month combos summary is replaced in the SAME tx from the just-written history lines (one INSERT … SELECT … GROUP BY)', async () => {
    const db = makeDb();
    await services(db).apply.apply(user, 'imp1', body([PREV]));
    const sql = sqlCalls(db);
    const del = sql.find((q) => q.text.includes('DELETE FROM "sales_month_history_combos"'))!;
    expect(del.values).toEqual(['t1', PREV]);
    const ins = sql.filter((q) => q.text.includes('INSERT INTO "sales_month_history_combos"'));
    expect(ins).toHaveLength(1);
    expect(ins[0].text).toContain('FROM "sales_month_histories" h');
    // re-check L-b: plain GROUP BY on dimKey + dims (1:1), no array_agg
    expect(ins[0].text).toMatch(/GROUP BY h."clientId", h."month", h."dimKey", h."dims"\s*$/);
    expect(ins[0].text).not.toContain('array_agg');
    expect(ins[0].text).toContain('md5(h."dimKey")');
    // re-check L-a: stamped with the set it summarises — the SAME sourceImportId / appliedAt as the set header
    const header = (db.salesMonthHistorySet.upsert.mock.calls[0] as unknown as [{ create: { sourceImportId: string; appliedAt: Date } }])[0];
    expect(ins[0].values).toEqual(['imp1', header.create.appliedAt.toISOString(), 't1', PREV]);
    expect(header.create.sourceImportId).toBe('imp1');
    // re-check L1: the header is stamped with the summary's set in the same tx
    expect(header.create).toEqual(expect.objectContaining({ combosSourceImportId: 'imp1', combosAppliedAt: header.create.appliedAt }));
    expect(db.log.indexOf('history.insert')).toBeLessThan(db.log.indexOf('combos.delete'));
    expect(db.log.indexOf('combos.insert')).toBeLessThan(db.log.indexOf('apply.create'));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  const hist = (id: number, month: string, code: string, dims: Record<string, string>, paise: bigint, micro: bigint) => ({
    id: BigInt(id), month, customerCode: code, dims, dimKey: stableStringify(dims), amountPaise: paise, qtyPico: micro * 1_000_000n, lines: 1,
  });
  const HISTORY = [
    hist(1, PREV, 'O1', { dimA: 'P', dimB: '500' }, 10000n, 1_500000n),
    hist(2, PREV, 'O2', { dimA: 'P', dimB: '50' }, -2500n, 0n),
    hist(3, PREV, 'O4', { dimA: 'P', dimB: '50' }, 700n, 0n), // unmatched when applied; on the roster now
    hist(4, PREV, 'ZZ', { dimA: 'P', dimB: '50' }, 99n, 0n), // still unmatched
  ];

  it('recalculate preview: CURRENT definitions × CURRENT roster over the stored history; deltas + outlets affected; 404 without history', async () => {
    const roster = [...ROSTER, { id: 'id-O4', outletCode: 'O4', name: 'Four', programName: null, outletType: { code: 'RETAIL' } }];
    const db = makeDb({ roster, history: HISTORY, existing: [{ outletCode: 'O1', kpiValues: { OWN_AMT: 100, OWN_QTY: 1.5 }, batch: { status: 'SALES_IMPORT', createdAt: AT } }] });
    const p = await services(db).apply.recalcPreview('t1', PREV);
    expect(p).toMatchObject({
      month: PREV, monthState: 'OPEN', canApply: true, definitionsHash: HASH, historySourceImportId: 'imp0', historyAppliedAt: AT.toISOString(),
      matchedOutlets: 3, unmatchedCustomers: 1, unmatchedAmountRupees: 0.99, zeroFillOutlets: 1,
    });
    expect(p.kpis.find((k) => k.kpiCode === 'OWN_AMT')).toEqual(expect.objectContaining({ newTotal: 82, currentTotal: 100, delta: -18 }));
    // O1 unchanged; O2, O3, O4 are new rows → 3 affected
    expect(p.outletsAffected).toBe(3);
    expect(p.warnings).toContain('NEGATIVE_VALUES');
    await expect(services(makeDb()).apply.recalcPreview('t1', PREV)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('recalculate: rewrites like apply with source HISTORY (history itself untouched), under the month lock', async () => {
    const db = makeDb({ history: HISTORY });
    const r = await services(db).apply.recalculate(user, PREV, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() });
    expect(r).toEqual(expect.objectContaining({ month: PREV, ok: true, outletsWritten: 3 }));
    // these stored lines predate day-level storage → the month's day data is removed, and the result says so
    expect(r.dayData).toEqual(expect.objectContaining({ written: false, reason: expect.stringMatching(/before day-by-day sales were stored/) }));
    expect(db.log).toEqual(['lock', 'batch.create', 'insert', 'strip', 'days.delete', 'dayset.delete', 'apply.create', 'status.upsert', 'audit']);
    const apply = (db.salesImportApply.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(apply).toEqual(expect.objectContaining({ source: 'HISTORY', importId: 'imp0' }));
    const audit = (db.auditLog.create.mock.calls[0] as unknown as [{ data: { newValues: Record<string, unknown> } }])[0].data;
    expect(audit.newValues).toEqual(expect.objectContaining({ source: 'HISTORY', importId: 'imp0' }));
    expect(sqlCalls(db)[1].values).toContainEqual(['O1', 'O2', 'O3']);
  });

  it('final check M1: a KPI using a dimension the stored lines lack BLOCKS recalculation; a changed mapping with all dims present only WARNS', async () => {
    const missing = makeDb({ history: HISTORY, historySet: { dimensionKeys: ['dimB'] } }); // OWN_AMT filters on dimA
    const p = await services(missing).apply.recalcPreview('t1', PREV);
    expect(p.canApply).toBe(false);
    expect(p.blockedReason).toMatch(/OWN_AMT \(dimA\)/);
    await expect(services(missing).apply.recalculate(user, PREV, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() }))
      .rejects.toThrow(/OWN_AMT \(dimA\)/);
    expect(missing.salesUploadBatch.create).not.toHaveBeenCalled();

    const changed = makeDb({ history: HISTORY, historySet: { mappingFingerprint: 'an-older-mapping' } });
    const q = await services(changed).apply.recalcPreview('t1', PREV);
    expect(q.canApply).toBe(true);
    expect(q.warnings).toContain('MAPPING_CHANGED');
    const same = await services(makeDb({ history: HISTORY })).apply.recalcPreview('t1', PREV);
    expect(same.warnings).not.toContain('MAPPING_CHANGED');
  });

  it('final check L2: the history write logs its delete / insert durations and row counts', async () => {
    const db = makeDb();
    const svc = services(db).apply;
    const logSpy = jest.spyOn((svc as unknown as { log: { log: (m: string) => void } }).log, 'log').mockImplementation(() => undefined);
    await svc.apply(user, 'imp1', { months: [PREV], expectedDefinitionsHash: HASH, processingVersion: VERSION });
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('month history written'))!;
    expect(JSON.parse(line)).toEqual(expect.objectContaining({ clientId: 't1', month: PREV, deleteMs: expect.any(Number), insertMs: expect.any(Number), insertedRows: 1 }));
  });

  it('recalculate refuses: CLOSED month, stale history / definitions (409), no history (404), bad body (400)', async () => {
    const ok = { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() };
    const closed = makeDb({ history: HISTORY, statuses: [{ month: PREV, state: 'CLOSED', closedAt: AT }] });
    await expect(services(closed).apply.recalculate(user, PREV, ok)).rejects.toThrow(/CLOSED/);
    expect(closed.salesUploadBatch.create).not.toHaveBeenCalled();
    const stale = makeDb({ history: HISTORY, historyAppliedAt: new Date(AT.getTime() + 1000) });
    await expect(services(stale).apply.recalculate(user, PREV, ok)).rejects.toBeInstanceOf(ConflictException);
    await expect(services(makeDb({ history: HISTORY })).apply.recalculate(user, PREV, { ...ok, expectedDefinitionsHash: 'x' })).rejects.toBeInstanceOf(ConflictException);
    await expect(services(makeDb()).apply.recalculate(user, PREV, ok)).rejects.toBeInstanceOf(NotFoundException);
    await expect(services(makeDb({ history: HISTORY })).apply.recalculate(user, PREV, {} as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(services(makeDb({ history: HISTORY })).apply.recalculate(user, 'bad', ok)).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── L4: KpiDef.outletType scopes apply / recalculate ────────────────────────────────────────────────────────────

describe('L4: a type-tagged KPI (KpiDef.outletType) only writes outlets of that type', () => {
  const hashWith = (types: Record<string, string>) =>
    definitionsHash(LITE.map((d) => ({ ...d, kpiOutletType: types[d.kpiCode] ?? null })));

  it('apply: OWN_AMT tagged RETAIL → the WHOLESALER outlet gets no OWN_AMT key (omitted, never 0); retail outlets do', async () => {
    const kpiTypes = { OWN_AMT: 'RETAIL' };
    const db = makeDb({ kpiTypes });
    const p = await services(db).preview.preview('t1', 'imp1');
    expect(p.definitionsHash).toBe(hashWith(kpiTypes));
    expect(p.definitionsHash).not.toBe(HASH);
    expect(p.months.find((m) => m.month === PREV)!.kpis.find((k) => k.kpiCode === 'OWN_AMT')!.newTotal).toBe(-25); // O2 only
    const r = await services(db).apply.apply(user, 'imp1', { months: [PREV], expectedDefinitionsHash: hashWith(kpiTypes), processingVersion: VERSION });
    expect(r.results[0]).toEqual(expect.objectContaining({ ok: true, outletsWritten: 3 }));
    const ins = sqlCalls(db)[1];
    expect(ins.values).toContainEqual(['O1', 'O2', 'O3']);
    expect(ins.values).toContainEqual([
      JSON.stringify({ OWN_QTY: 2 }), // O1 wholesaler: OWN_AMT out of the KPI's type → omitted
      JSON.stringify({ OWN_AMT: -25 }),
      JSON.stringify({ OWN_AMT: 0 }),
    ]);
  });

  it('both scopes set and disjoint (KpiDef RETAIL × definition WHOLESALER) → no outlet gets that KPI', async () => {
    const kpiTypes = { OWN_QTY: 'RETAIL' };
    const db = makeDb({ kpiTypes });
    await services(db).apply.apply(user, 'imp1', { months: [PREV], expectedDefinitionsHash: hashWith(kpiTypes), processingVersion: VERSION });
    expect(sqlCalls(db)[1].values).toContainEqual([
      JSON.stringify({ OWN_AMT: 100 }),
      JSON.stringify({ OWN_AMT: -25 }),
      JSON.stringify({ OWN_AMT: 0 }),
    ]);
  });

  it('a KpiDef.outletType change after the preview changes the hash → apply 409 before any write', async () => {
    const db = makeDb({ kpiTypes: { OWN_AMT: 'RETAIL' } });
    await expect(services(db).apply.apply(user, 'imp1', { months: [PREV], expectedDefinitionsHash: HASH, processingVersion: VERSION }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('recalculate honours it too: OWN_AMT tagged WHOLESALER → only O1 is written; retail outlets in no scope are untouched', async () => {
    const kpiTypes = { OWN_AMT: 'WHOLESALER' };
    const hist = (id: number, code: string, dims: Record<string, string>, paise: bigint, micro: bigint) => ({
      id: BigInt(id), month: PREV, customerCode: code, dims, dimKey: stableStringify(dims), amountPaise: paise, qtyPico: micro * 1_000_000n, lines: 1,
    });
    const db = makeDb({ kpiTypes, history: [hist(1, 'O1', { dimA: 'P', dimB: '500' }, 10000n, 1_500000n), hist(2, 'O2', { dimA: 'P', dimB: '50' }, -2500n, 0n)] });
    const pv = await services(db).apply.recalcPreview('t1', PREV);
    expect(pv.definitionsHash).toBe(hashWith(kpiTypes));
    const r = await services(db).apply.recalculate(user, PREV, { expectedDefinitionsHash: hashWith(kpiTypes), expectedHistoryAppliedAt: AT.toISOString() });
    expect(r).toEqual(expect.objectContaining({ ok: true, outletsWritten: 1 }));
    const ins = sqlCalls(db)[1];
    expect(ins.values).toContainEqual(['O1']);
    expect(ins.values).toContainEqual([JSON.stringify({ OWN_AMT: 100, OWN_QTY: 1.5 })]);
  });

  it('no KpiDef.outletType anywhere (every current tenant) → the hash and the written values are exactly as before', async () => {
    const p = await services(makeDb()).preview.preview('t1', 'imp1');
    expect(p.definitionsHash).toBe(HASH);
  });
});

describe('outletsAffected', () => {
  it('counts changed, new and stripped rows; ignores identical and non-owned keys', () => {
    const existing = [
      { outletCode: 'A', kpiValues: { K: 1, M: 9 } }, // unchanged
      { outletCode: 'B', kpiValues: { K: 1 } }, // changed
      { outletCode: 'C', kpiValues: { K: 2 } }, // not written → owned key stripped
      { outletCode: 'D', kpiValues: { M: 3 } }, // only non-owned → untouched
    ];
    const rows = [{ outletCode: 'A', values: { K: 1 } }, { outletCode: 'B', values: { K: 2 } }, { outletCode: 'E', values: { K: 0 } }];
    expect(outletsAffected(existing, rows, ['K'])).toBe(3); // B, C, E
  });
  it('audit follow-up: a new outlet with NO owned value is not counted (writeMonth does not create an empty record)', () => {
    expect(outletsAffected([], [{ outletCode: 'N', values: {} }], ['K'])).toBe(0);
    // an existing row that ends with no owned value still counts (its owned keys are stripped)
    expect(outletsAffected([{ outletCode: 'X', kpiValues: { K: 1 } }], [{ outletCode: 'X', values: {} }], ['K'])).toBe(1);
  });
});

// ─── FOCUS-FROM-TARGETS (design platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md) — REAL focus-products ─────────────

describe('FOCUS-FROM-TARGETS: preview / apply / recalculate with products from the target file', () => {
  const FOCUS_DEF = {
    id: 'd3', clientId: 't1', kpiCode: 'FOCUS', measure: 'AMOUNT', filter: {}, outletTypes: [] as string[], programs: [] as string[],
    enabled: true, order: 2, productSource: 'TARGET_NAMES',
  };
  const FDEFS = [...DEF_ROWS, FOCUS_DEF];
  const EXTRA = [{ code: 'FOCUS', label: 'Focus Brand 1' }];
  const LATER = new Date(AT.getTime() + 3_600_000);
  const EARLIER = new Date(AT.getTime() - 3_600_000);
  // PREV targets: O1 → "P500" (dimA P + dimB 500 = ₹100), O2 → "Q" (brand Q, not bought → 0), O3 → no row.
  const tgt = (month: string, code: string, value: number, name?: string, batchId = 'tb1') => ({
    outletCode: code, month, batchId,
    targetValues: { FOCUS: value, OWN_AMT: 1, ...(name ? { __names: { FOCUS: name } } : {}) },
  });
  const TARGETS = [tgt(PREV, 'O1', 10, 'P500'), tgt(PREV, 'O2', 5, 'Q')];
  const COMBOS = [{ dimA: 'Q', dimB: '50' }]; // a stored month knew brand Q
  const fdb = (over: Parameters<typeof makeDb>[0] = {}) =>
    makeDb({ months: [PREV], defs: FDEFS, extraKpis: EXTRA, targets: TARGETS, targetBatches: [{ id: 'tb1', createdAt: EARLIER }], historyCombos: COMBOS, ...over });
  const applyBody = (p: { definitionsHash: string; months: Array<{ month: string; reconciliation: { focusFingerprint: string } }> }, over: Record<string, unknown> = {}) => ({
    months: [PREV], expectedDefinitionsHash: p.definitionsHash, processingVersion: VERSION,
    expectedFocusFingerprints: Object.fromEntries(p.months.map((m) => [m.month, m.reconciliation.focusFingerprint])),
    ...over,
  });
  const writtenValues = (db: ReturnType<typeof makeDb>) => {
    const ins = sqlCalls(db).find((q) => q.text.includes('INSERT INTO "outlet_sales_records"'))!;
    const codes = ins.values.find((v) => Array.isArray(v) && v.includes('O1')) as string[];
    const vals = (ins.values.find((v) => Array.isArray(v) && String(v[0]).startsWith('{')) as string[]).map((j) => JSON.parse(j));
    return Object.fromEntries(codes.map((c, i) => [c, vals[i]]));
  };

  it('preview: per-outlet focus values, reconciliation (targets, names, fingerprint), canApply; apply writes EXACTLY those values', async () => {
    const db = fdb();
    const p = await services(db).preview.preview('t1', 'imp1');
    const m = p.months[0];
    expect(m.canApply).toBe(true);
    expect(m.kpis.find((k) => k.kpiCode === 'FOCUS')).toEqual(expect.objectContaining({ newTotal: 100, outletsNonZero: 1, label: 'Focus Brand 1' }));
    expect(m.reconciliation.focusFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(m.reconciliation.blockers).toEqual([]);
    expect(m.reconciliation.targets).toEqual(expect.objectContaining({ targetUploadedAt: EARLIER.toISOString(), newerThanLastApply: false }));
    expect(m.reconciliation.targets.kpis.find((k) => k.kpiCode === 'OWN_AMT')).toEqual(expect.objectContaining({ outletsWithTarget: 2, totalTarget: 2 }));
    const names = m.reconciliation.focus[0].names;
    expect(names.map((n) => [n.name, n.outlets, n.achieved.total])).toEqual(expect.arrayContaining([['P500', 1, 100], ['Q', 1, 0]]));
    expect(m.reconciliation.gaps.targetNoSales.outlets).toBe(0);

    const r = await services(db).apply.apply(user, 'imp1', applyBody(p));
    expect(r.results[0]).toEqual(expect.objectContaining({ ok: true }));
    // O3 has no target row → FOCUS omitted (not 0); FILTER KPIs exactly as without focus
    expect(writtenValues(db)).toEqual({ O1: { OWN_AMT: 100, OWN_QTY: 2, FOCUS: 100 }, O2: { OWN_AMT: -25, FOCUS: 0 }, O3: { OWN_AMT: 0 } });
    const audit = (db.auditLog.create.mock.calls[0] as unknown as [{ data: { newValues: Record<string, unknown> } }])[0].data.newValues;
    expect(audit.focusFingerprint).toBe(m.reconciliation.focusFingerprint);
  });

  it('a blocker (unmatched name) → canApply false with a focus reason; apply refuses the month, nothing written', async () => {
    const db = fdb({ targets: [tgt(PREV, 'O1', 10, 'P500'), tgt(PREV, 'O2', 5, 'ZZZ')] });
    const p = await services(db).preview.preview('t1', 'imp1');
    const m = p.months[0];
    expect(m.canApply).toBe(false);
    expect(m.blockedReason).toBe(`1 problem with the focus products in the ${monthLabelOf(PREV)} target file — see Focus brands.`);
    expect(m.reconciliation.blockers).toEqual([expect.objectContaining({ code: 'FOCUS_UNMATCHED', key: 'ZZZ', outlets: 1, sampleOutletCodes: ['O2'] })]);
    const r = await services(db).apply.apply(user, 'imp1', applyBody(p));
    expect(r.results[0]).toEqual(expect.objectContaining({ ok: false, error: m.blockedReason }));
    expect(db.salesUploadBatch.create).not.toHaveBeenCalled();
  });

  it('missing name with a numeric target → FOCUS_MISSING_NAME blocker', async () => {
    const p = await services(fdb({ targets: [tgt(PREV, 'O1', 10, 'P500'), tgt(PREV, 'O2', 5)] })).preview.preview('t1', 'imp1');
    expect(p.months[0].canApply).toBe(false);
    expect(p.months[0].reconciliation.blockers).toEqual([expect.objectContaining({ code: 'FOCUS_MISSING_NAME', outlets: 1 })]);
  });

  it('existing reasons keep precedence over focus blockers (a CLOSED month says CLOSED)', async () => {
    const p = await services(fdb({ targets: [tgt(PREV, 'O2', 5, 'ZZZ')], statuses: [{ month: PREV, state: 'CLOSED', closedAt: AT }] })).preview.preview('t1', 'imp1');
    expect(p.months[0].blockedReason).toMatch(/CLOSED/);
  });

  it('accepting the unmatched token ("not sold yet") clears the blocker; the token shows who accepted it', async () => {
    const db = fdb({
      targets: [tgt(PREV, 'O1', 10, 'P500'), tgt(PREV, 'O2', 5, 'ZZZ')],
      acceptances: [{ month: PREV, kpiCode: 'FOCUS', key: 'ZZZ', acceptedById: 'u1', acceptedAt: AT }],
    });
    const p = await services(db).preview.preview('t1', 'imp1');
    expect(p.months[0].canApply).toBe(true);
    const tok = p.months[0].reconciliation.focus[0].names.find((n) => n.key === 'ZZZ')!.tokens[0];
    expect(tok.accepted).toEqual({ byName: 'Admin', at: AT.toISOString() });
    const r = await services(db).apply.apply(user, 'imp1', applyBody(p));
    expect(r.results[0].ok).toBe(true);
    expect(writtenValues(db).O2).toEqual({ OWN_AMT: -25, FOCUS: 0 });
  });

  it('fingerprint required and checked: missing / wrong → 409 before any write', async () => {
    const db = fdb();
    const p = await services(db).preview.preview('t1', 'imp1');
    await expect(services(db).apply.apply(user, 'imp1', applyBody(p, { expectedFocusFingerprints: {} }))).rejects.toThrow(
      'The targets or focus products changed since the preview. Refresh the preview and try again.',
    );
    await expect(services(db).apply.apply(user, 'imp1', applyBody(p, { expectedFocusFingerprints: { [PREV]: 'x' } }))).rejects.toBeInstanceOf(ConflictException);
    await expect(services(db).apply.apply(user, 'imp1', applyBody(p, { expectedFocusFingerprints: [] }))).rejects.toBeInstanceOf(BadRequestException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('the target file changes between preview and apply → 409 (pre-check), or ok:false when it changes under the lock', async () => {
    const db = fdb();
    const p = await services(db).preview.preview('t1', 'imp1');
    // changed before the apply request: the pre-check refuses with 409
    const changed = [tgt(PREV, 'O1', 10, 'P500'), tgt(PREV, 'O2', 5, 'ZZZ')];
    db.outletTarget.findMany.mockImplementation(async () => changed as never);
    await expect(services(db).apply.apply(user, 'imp1', applyBody(p))).rejects.toThrow(/changed since the preview/);
    expect(db.$transaction).not.toHaveBeenCalled();
    // changed after the pre-check, before the month lock: the re-check under the lock refuses the month (blocker first)
    let n = 0;
    db.outletTarget.findMany.mockImplementation(async () => (n++ === 0 ? TARGETS : changed) as never);
    const r = await services(db).apply.apply(user, 'imp1', applyBody(p));
    expect(r.results[0]).toEqual(expect.objectContaining({ ok: false }));
    expect(r.results[0].error).toMatch(/1 problem with the focus products/);
    // a non-blocking change (another valid name) under the lock → fingerprint mismatch
    n = 0;
    db.outletTarget.findMany.mockImplementation(async () => (n++ === 0 ? TARGETS : [tgt(PREV, 'O1', 10, 'P500'), tgt(PREV, 'O2', 5, 'P')]) as never);
    const r2 = await services(db).apply.apply(user, 'imp1', applyBody(p));
    expect(r2.results[0].error).toMatch(/changed since the preview/);
    expect(db.salesUploadBatch.create).not.toHaveBeenCalled();
  });

  it('no TARGET_NAMES definition → fingerprint "" and not required; values / flags exactly as before; no catalogue read', async () => {
    const db = makeDb({ targets: [tgt(PREV, 'O1', 10, 'P500')], targetBatches: [{ id: 'tb1', createdAt: EARLIER }] });
    const p = await services(db).preview.preview('t1', 'imp1');
    const prev = p.months.find((m) => m.month === PREV)!;
    expect(prev.reconciliation.focusFingerprint).toBe('');
    expect(prev.reconciliation.focus).toEqual([]);
    expect(prev.kpis.map((k) => [k.kpiCode, k.newTotal])).toEqual([['OWN_AMT', 75], ['OWN_QTY', 2]]);
    expect(prev.canApply).toBe(true);
    expect(p.definitionsHash).toBe(HASH);
    const r = await services(db).apply.apply(user, 'imp1', { months: [PREV], expectedDefinitionsHash: HASH, processingVersion: VERSION });
    expect(r.results[0].ok).toBe(true);
    expect(db.log).toEqual(['lock', 'import.share', 'batch.create', 'insert', 'strip', 'history.delete', 'history.insert', 'combos.delete', 'combos.insert', 'history.set', 'days.delete', 'days.insert', 'dayset.upsert', 'apply.create', 'status.upsert', 'audit']);
    expect(writtenValues(db)).toEqual({ O1: { OWN_AMT: 100, OWN_QTY: 2 }, O2: { OWN_AMT: -25 }, O3: { OWN_AMT: 0 } });
    // apply never reads targets / acceptances for such a tenant (the write path is the original one)
    expect(db.outletTarget.findMany).toHaveBeenCalledTimes(2); // the preview's two months only
    expect(db.salesFocusAcceptance.findMany).not.toHaveBeenCalled();
    const audit = (db.auditLog.create.mock.calls[0] as unknown as [{ data: { newValues: Record<string, unknown> } }])[0].data.newValues;
    expect(audit).not.toHaveProperty('focusFingerprint');
  });

  it('newerThanLastApply: targets uploaded after the last apply → true; before → false; never applied → false', async () => {
    const after = await services(fdb({ lastApply: { lastDate: `${PREV}-28` }, targetBatches: [{ id: 'tb1', createdAt: LATER }] })).preview.preview('t1', 'imp1');
    expect(after.months[0].reconciliation.targets.newerThanLastApply).toBe(true);
    const before = await services(fdb({ lastApply: { lastDate: `${PREV}-28` } })).preview.preview('t1', 'imp1');
    expect(before.months[0].reconciliation.targets.newerThanLastApply).toBe(false);
    const never = await services(fdb({ targetBatches: [{ id: 'tb1', createdAt: LATER }] })).preview.preview('t1', 'imp1');
    expect(never.months[0].reconciliation.targets.newerThanLastApply).toBe(false);
  });

  it('audit follow-up (timing): newerThanLastApply follows the target ROWS’ write time, not the upload batch’s', async () => {
    // batch stamped BEFORE the apply, but a chunk of its rows committed AFTER it
    const p = await services(
      fdb({ lastApply: { lastDate: `${PREV}-28` }, targets: [tgt(PREV, 'O1', 10, 'P500'), { ...tgt(PREV, 'O2', 5, 'Q'), updatedAt: LATER }] }),
    ).preview.preview('t1', 'imp1');
    expect(p.months[0].reconciliation.targets.newerThanLastApply).toBe(true);
    expect(p.months[0].reconciliation.targets.targetUploadedAt).toBe(LATER.toISOString());
  });

  it('audit follow-up (B-M1): without a TARGET_NAMES definition newerThanLastApply is never true (targets change no figure)', async () => {
    const p = await services(
      makeDb({ months: [PREV], lastApply: { lastDate: `${PREV}-28` }, targets: [tgt(PREV, 'O1', 10, 'P500')], targetBatches: [{ id: 'tb1', createdAt: LATER }] }),
    ).preview.preview('t1', 'imp1');
    expect(p.months[0].reconciliation.targets.newerThanLastApply).toBe(false);
    expect(p.months[0].reconciliation.targets.targetUploadedAt).toBe(LATER.toISOString()); // still shown
  });

  it('audit follow-up: the reconciliation carries each KPI’s measure (targets + focus)', async () => {
    const p = await services(fdb()).preview.preview('t1', 'imp1');
    const rec = p.months[0].reconciliation;
    expect(rec.targets.kpis.map((k) => [k.kpiCode, k.measure])).toEqual([['OWN_AMT', 'AMOUNT'], ['OWN_QTY', 'QUANTITY'], ['FOCUS', 'AMOUNT']]);
    expect(rec.focus.map((f) => [f.kpiCode, f.measure])).toEqual([['FOCUS', 'AMOUNT']]);
  });

  it('A-M1: a RETRIED background job resolves its remaining month against the FIRST run’s product lists (Sep done, worker killed, Oct still applies)', async () => {
    const R = { dimA: 'R', dimB: '1' };
    const db = fdb({
      months: [PREV, CUR],
      historyCombos: [R],
      historyCombosAfterApply: [], // once PREV is written its product list no longer holds R
      targets: [tgt(PREV, 'O1', 10, 'P500'), tgt(PREV, 'O2', 5, 'R'), tgt(CUR, 'O1', 10, 'P500'), tgt(CUR, 'O2', 5, 'R')],
    });
    const p = await services(db).preview.preview('t1', 'imp1');
    // First run: snapshots the lists, writes PREV, then "dies" before CUR (beforeMonth stops it).
    let basis: Array<{ dims: unknown }> | undefined;
    const { ApplyStopError: Stop } = await import('./sales-apply.service');
    await expect(services(db).apply.apply(user, 'imp1', applyBody(p, { months: [PREV, CUR] }), {
      beforeMonth: async (m) => { if (m === CUR) throw new Stop('worker killed'); },
    }, { onFocusHistory: async (h) => { basis = h; } })).rejects.toBeInstanceOf(Stop);
    expect(basis).toEqual([{ dims: JSON.stringify(R) }]);
    // Retry of CUR only — WITHOUT the snapshot it is refused (R is no longer in the stored lists)…
    await expect(services(db).apply.apply(user, 'imp1', applyBody(p, { months: [CUR] }), {}, {})).rejects.toBeInstanceOf(ConflictException);
    // …WITH the first run's snapshot it applies, and the stored lists are not re-read.
    db.$queryRaw.mockClear();
    const r = await services(db).apply.apply(user, 'imp1', applyBody(p, { months: [CUR] }), {}, { focusHistory: basis });
    expect(r.results).toEqual([expect.objectContaining({ month: CUR, ok: true })]);
    const texts = db.$queryRaw.mock.calls.map((c) => (c[0] as unknown as Prisma.Sql).strings.join('?'));
    expect(texts.filter((t) => t.includes('FROM "sales_month_history_combos"'))).toHaveLength(0);
  });

  it('audit follow-up: ONE catalogue per apply request — applying month A (which rewrites A’s product list) cannot unmatch month B', async () => {
    // "R" is known only from a stored month's product list; month A's apply replaces the stored lists (mock: once a
    // combos.insert ran, the stored lists no longer hold R). Re-reading the catalogue per month would block B after A
    // was already written.
    const R = { dimA: 'R', dimB: '1' };
    const db = fdb({
      months: [PREV, CUR],
      historyCombos: [R],
      historyCombosAfterApply: [],
      targets: [tgt(PREV, 'O1', 10, 'P500'), tgt(PREV, 'O2', 5, 'R'), tgt(CUR, 'O1', 10, 'P500'), tgt(CUR, 'O2', 5, 'R')],
    });
    const p = await services(db).preview.preview('t1', 'imp1');
    expect(p.months.map((m) => m.canApply)).toEqual([true, true]);
    db.$queryRaw.mockClear();
    const r = await services(db).apply.apply(user, 'imp1', applyBody(p, { months: [PREV, CUR] }));
    expect(r.results.map((x) => x.ok)).toEqual([true, true]);
    // loaded exactly once for the whole request (pre-check + both months' under-lock re-checks)
    const texts = db.$queryRaw.mock.calls.map((c) => (c[0] as unknown as Prisma.Sql).strings.join('?'));
    expect(texts.filter((t) => t.includes('FROM "sales_month_history_combos"'))).toHaveLength(1);
    const importSql = texts.filter((t) => t.includes('FROM "sales_import_aggregates"'));
    expect(importSql).toHaveLength(1);
    // cheap distinct: DISTINCT ON dimKey, no per-row jsonb → text cast, still tenant-checked
    expect(importSql[0]).toMatch(/SELECT DISTINCT ON \(a\."dimKey"\) a\."dims"/);
    expect(importSql[0]).not.toMatch(/::text/);
    expect(importSql[0]).toMatch(/"sales_imports"[\s\S]*"clientId"/);
  });

  it('audit follow-up: a TARGET_NAMES-only tenant never INSERTs an empty record; an existing record still loses its owned key', async () => {
    const db = fdb({
      defs: [FOCUS_DEF],
      targets: [tgt(PREV, 'O1', 10, 'P500')], // O2 / O3: no name, no target → FOCUS omitted → no value at all
      existing: [{ outletCode: 'O2', kpiValues: { FOCUS: 5, MANUAL: 1 }, batch: { status: 'SALES_IMPORT', createdAt: AT } }],
    });
    const p = await services(db).preview.preview('t1', 'imp1');
    const r = await services(db).apply.apply(user, 'imp1', applyBody(p));
    expect(r.results[0]).toEqual(expect.objectContaining({ ok: true, outletsWritten: 1, outletsZeroFilled: 0 }));
    expect(writtenValues(db)).toEqual({ O1: { FOCUS: 100 } }); // no {} rows for O2 / O3
    const strip = sqlCalls(db).find((q) => q.text.includes('NOT ("outletCode" = ANY'))!;
    expect(strip.values).toContainEqual(['O1']); // O2 is not "written" → its FOCUS key is stripped (MANUAL kept by the SQL)
    expect(db.salesUploadBatch.create.mock.calls[0][0].data).toEqual(expect.objectContaining({ totalRows: 1, acceptedCount: 1 }));
  });

  const hist = (id: number, code: string, dims: Record<string, string>, paise: bigint) => ({
    id: BigInt(id), month: PREV, customerCode: code, dims, dimKey: stableStringify(dims), amountPaise: paise, qtyPico: 0n, lines: 1,
  });
  const HIST = [hist(1, 'O1', { dimA: 'P', dimB: '500' }, 10000n), hist(2, 'O2', { dimA: 'Q', dimB: '50' }, 400n)];
  // recalculate reads stored months only: the month's own stored lines are in the stored product lists
  const HIST_COMBOS = HIST.map((h) => h.dims);

  it('sales BEFORE targets: applied with no targets → FILTER KPIs written, FOCUS omitted, no blocker; targets later → flag → recalculate writes focus', async () => {
    // 1. no targets yet: no blocker, focus omitted everywhere, the reconciliation says no targets
    const db = fdb({ targets: [], targetBatches: [] });
    const p = await services(db).preview.preview('t1', 'imp1');
    expect(p.months[0].canApply).toBe(true);
    expect(p.months[0].reconciliation.targets.targetUploadedAt).toBeNull();
    expect((await services(db).apply.apply(user, 'imp1', applyBody(p))).results[0].ok).toBe(true);
    expect(writtenValues(db)).toEqual({ O1: { OWN_AMT: 100, OWN_QTY: 2 }, O2: { OWN_AMT: -25 }, O3: { OWN_AMT: 0 } });

    // 2. targets uploaded after that apply → recalculate preview flags it and computes the focus values from history
    const later = fdb({ history: HIST, historyCombos: HIST_COMBOS, lastApply: { lastDate: `${PREV}-28` }, targetBatches: [{ id: 'tb1', createdAt: LATER }] });
    const rp = await services(later).apply.recalcPreview('t1', PREV);
    expect(rp.reconciliation.targets.newerThanLastApply).toBe(true);
    expect(rp.canApply).toBe(true);
    expect(rp.kpis.find((k) => k.kpiCode === 'FOCUS')!.newTotal).toBe(104); // O1 P500 ₹100 + O2 brand Q ₹4
    const ok = { expectedDefinitionsHash: rp.definitionsHash, expectedHistoryAppliedAt: rp.historyAppliedAt };
    await expect(services(later).apply.recalculate(user, PREV, ok)).rejects.toThrow(/changed since the preview/);
    await expect(services(later).apply.recalculate(user, PREV, { ...ok, expectedFocusFingerprint: 'x' })).rejects.toBeInstanceOf(ConflictException);
    const r = await services(later).apply.recalculate(user, PREV, { ...ok, expectedFocusFingerprint: rp.reconciliation.focusFingerprint });
    expect(r.ok).toBe(true);
    expect(writtenValues(later)).toEqual({ O1: { OWN_AMT: 100, OWN_QTY: 0, FOCUS: 100 }, O2: { OWN_AMT: 0, FOCUS: 4 }, O3: { OWN_AMT: 0 } });
  });

  it('recalculate refuses a month with a focus blocker (409), even with the matching fingerprint', async () => {
    const db = fdb({ history: HIST, historyCombos: HIST_COMBOS, targets: [tgt(PREV, 'O1', 10, 'P500'), tgt(PREV, 'O2', 5, 'ZZZ')] });
    const rp = await services(db).apply.recalcPreview('t1', PREV);
    expect(rp.canApply).toBe(false);
    expect(rp.blockedReason).toMatch(/1 problem with the focus products/);
    await expect(
      services(db).apply.recalculate(user, PREV, {
        expectedDefinitionsHash: rp.definitionsHash, expectedHistoryAppliedAt: rp.historyAppliedAt, expectedFocusFingerprint: rp.reconciliation.focusFingerprint,
      }),
    ).rejects.toThrow(/1 problem with the focus products/);
    expect(db.salesUploadBatch.create).not.toHaveBeenCalled();
  });
});

// ─── FOCUS-FROM-TARGETS: the November 2026 Bajaj fixture end-to-end (REAL focus-products) ─────────────────────────

describe('FOCUS-FROM-TARGETS: November fixture (retailers "CNO & ADHO500", wholesalers ADHO50 / ADHO500)', () => {
  const NOV_MAPPING: SalesColumnMapping = {
    ...MAPPING, dimensions: [{ key: 'brand', label: 'Brand', header: 'BRAND' }, { key: 'skuGroup', label: 'SKU Group', header: 'SKU' }],
  };
  const roster = [
    { id: 'id-R1', outletCode: 'R1', name: 'Retail 1', programName: null, outletType: { code: 'SSS' } },
    { id: 'id-R2', outletCode: 'R2', name: 'Retail 2', programName: null, outletType: { code: 'SSS' } },
    { id: 'id-W1', outletCode: 'W1', name: 'Whole 1', programName: null, outletType: { code: 'WHOLESALER' } },
    { id: 'id-W2', outletCode: 'W2', name: 'Whole 2', programName: null, outletType: { code: 'WHOLESALER' } },
  ];
  const a = (id: number, code: string, brand: string, skuGroup: string, rupees: bigint) => agg(id, PREV, code, { brand, skuGroup }, rupees * 100n, 0n);
  const aggs = [
    a(1, 'R1', 'CNO', '200', 100n),
    a(2, 'R1', 'CNO ENRICH', '200', 50n), // NOT "CNO" (owner confirmation)
    a(3, 'R1', 'ADHO', '500', 30n),
    a(4, 'R1', 'ADHO', '50', 7n), // ADHO50 is not a retailer focus product
    a(5, 'R2', 'CNO GREEN', '100', 40n),
    a(6, 'W1', 'ADHO', '50', 200n),
    a(7, 'W1', 'ADHO', '500', 300n),
    a(8, 'W2', 'ADHO', '500', 10n),
  ];
  const def = (id: string, kpiCode: string, order: number, over: Record<string, unknown> = {}) => ({
    id, clientId: 't1', kpiCode, measure: 'AMOUNT', filter: {}, outletTypes: [] as string[], programs: [] as string[], enabled: true, order, ...over,
  });
  const defs = [
    def('n1', 'TOTAL', 0),
    def('n2', 'FB1', 1, { productSource: 'TARGET_NAMES' }),
    def('n3', 'FB2', 2, { productSource: 'TARGET_NAMES', outletTypes: ['WHOLESALER'] }),
  ];
  const t = (code: string, values: Record<string, number>, names: Record<string, string>) => ({
    outletCode: code, month: PREV, batchId: 'tb', targetValues: { ...values, __names: names },
  });
  const targets = [
    t('R1', { FB1: 1000 }, { FB1: 'CNO & ADHO500' }),
    t('R2', { FB1: 1000 }, { FB1: 'CNO & ADHO500' }),
    t('W1', { FB1: 500, FB2: 600 }, { FB1: 'ADHO50', FB2: 'ADHO500' }),
    t('W2', { FB1: 500, FB2: 600 }, { FB1: 'ADHO50', FB2: 'ADHO500' }),
  ];

  it('preview resolves every name, blocks nothing, and apply writes the per-outlet focus values', async () => {
    const db = makeDb({
      months: [PREV], mapping: NOV_MAPPING, aggs, roster, defs, targets, targetBatches: [{ id: 'tb', createdAt: AT }],
      extraKpis: [{ code: 'TOTAL', label: 'Total' }, { code: 'FB1', label: 'Focus Brand 1' }, { code: 'FB2', label: 'Focus Brand 2' }],
    });
    const p = await services(db).preview.preview('t1', 'imp1');
    const m = p.months[0];
    expect(m.reconciliation.blockers).toEqual([]);
    expect(m.canApply).toBe(true);
    const fb1 = m.reconciliation.focus.find((f) => f.kpiCode === 'FB1')!;
    const retail = fb1.names.find((n) => n.name === 'CNO & ADHO500')!;
    expect(retail).toEqual(expect.objectContaining({ outlets: 2, outletsByType: { SSS: 2 }, achieved: { total: 130, outletsZero: 1 } }));
    expect(retail.tokens.map((x) => [x.key, x.status, x.product])).toEqual([
      ['CNO', 'MATCHED', { brand: 'CNO' }],
      ['ADHO500', 'MATCHED', { brand: 'ADHO', skuGroup: '500' }],
    ]);
    expect(fb1.names.find((n) => n.name === 'ADHO50')!.achieved).toEqual({ total: 200, outletsZero: 1 });
    expect(m.kpis.map((k) => [k.kpiCode, k.newTotal])).toEqual([['TOTAL', 737], ['FB1', 330], ['FB2', 310]]);

    const r = await services(db).apply.apply(user, 'imp1', {
      months: [PREV], expectedDefinitionsHash: p.definitionsHash, processingVersion: VERSION,
      expectedFocusFingerprints: { [PREV]: m.reconciliation.focusFingerprint },
    });
    expect(r.results[0]).toEqual(expect.objectContaining({ ok: true, outletsWritten: 4 }));
    const ins = sqlCalls(db).find((q) => q.text.includes('INSERT INTO "outlet_sales_records"'))!;
    expect(ins.values).toContainEqual(['R1', 'R2', 'W1', 'W2']);
    const vals = (ins.values.find((v) => Array.isArray(v) && String(v[0]).startsWith('{')) as string[]).map((j) => JSON.parse(j));
    expect(vals).toEqual([
      { TOTAL: 187, FB1: 130 }, // CNO 100 + ADHO 500 30 (not CNO ENRICH, not ADHO 50); FB2 out of scope → omitted
      { TOTAL: 40, FB1: 0 },
      { TOTAL: 500, FB1: 200, FB2: 300 },
      { TOTAL: 10, FB1: 0, FB2: 10 },
    ]);
  });
});

// ─── sales-day-level (owner decision 2026-11-18): day data written with every month write ─────────────────────────

describe('day-level data (OutletSalesDay / SalesDaySet)', () => {
  const body = (months: string[]) => ({ months, expectedDefinitionsHash: HASH, processingVersion: VERSION });
  const P = (micro: bigint) => String(micro * 1_000_000n);
  // O1 (wholesaler): product P/500 bought on day 2 (₹60, 1 case) and day 9 (₹40, 0.5 case); product Q/500 on day 9.
  // O2 (retail): P/50 return on day 5. GONE / O4: not on the roster → never stored. O3: no lines → no day rows.
  const DAY_AGGS = [
    { ...agg(1, PREV, 'O1', { dimA: 'P', dimB: '500' }, 10000n, 1_500000n, [[2, '6000', P(1_000000n), 1], [9, '4000', P(500000n), 1]]), lines: 2 },
    agg(2, PREV, 'O1', { dimA: 'Q', dimB: '500' }, 5000n, 500000n, [[9, '5000', P(500000n), 1]]),
    agg(3, PREV, 'O2', { dimA: 'P', dimB: '50' }, -2500n, 0n, [[5, '-2500', '0', 1]]),
    agg(4, PREV, 'GONE', { dimA: 'P', dimB: '50' }, 99999n, 0n, [[1, '99999', '0', 1]]),
    agg(5, PREV, 'O4', { dimA: 'P', dimB: '50' }, 700n, 0n, [[1, '700', '0', 1]]),
  ];
  const dayInsert = (db: ReturnType<typeof makeDb>) => sqlCalls(db).find((q) => q.text.includes('INSERT INTO "outlet_sales_days"'));

  it('apply writes CUMULATIVE month-to-date values per programme outlet × billing day, replacing the month in the same tx', async () => {
    const db = makeDb({ months: [PREV], aggs: DAY_AGGS });
    const r = await services(db).apply.apply(user, 'imp1', body([PREV]));
    const lastDay = Number(lastDayOfMonth(PREV).slice(8));
    expect(r.results[0]).toEqual(expect.objectContaining({ ok: true, dayData: { written: true, outlets: 2, rows: 3, lastDay } }));
    const sql = sqlCalls(db);
    const del = sql.find((q) => q.text.includes('DELETE FROM "outlet_sales_days"'))!;
    expect(del.values).toEqual(['t1', PREV]);
    const ins = dayInsert(db)!;
    expect(ins.values).toEqual([
      't1', PREV, 'imp1',
      ['id-O1', 'id-O1', 'id-O2'], ['O1', 'O1', 'O2'], [2, 9, 5],
      [
        JSON.stringify({ OWN_AMT: 60, OWN_QTY: 1 }),
        JSON.stringify({ OWN_AMT: 100, OWN_QTY: 2 }), // cumulative: day 2 + day 9 (OWN_AMT counts P only)
        JSON.stringify({ OWN_AMT: -25 }), // retail: OWN_QTY out of scope → omitted, exactly like the monthly row
      ],
    ]);
    // INVARIANT: each outlet's last day equals the monthly value written by the SAME apply
    const monthly = sql.find((q) => q.text.includes('INSERT INTO "outlet_sales_records"'))!;
    expect(monthly.values).toContainEqual([JSON.stringify({ OWN_AMT: 100, OWN_QTY: 2 }), JSON.stringify({ OWN_AMT: -25 }), JSON.stringify({ OWN_AMT: 0 })]);
    const set = (db.salesDaySet.upsert.mock.calls[0] as unknown as [{ where: unknown; create: Record<string, unknown> }])[0];
    expect(set.where).toEqual({ clientId_month: { clientId: 't1', month: PREV } });
    expect(set.create).toEqual(expect.objectContaining({ clientId: 't1', month: PREV, lastDay, sourceImportId: 'imp1', appliedAt: expect.any(Date) }));
    // the day split is read where it is needed (apply)
    const selects = db.salesImportAggregate.findMany.mock.calls.map((c) => (c[0] as unknown as { select: Record<string, boolean> }).select);
    expect(selects.some((s) => s.days === true)).toBe(true);
    const audit = (db.auditLog.create.mock.calls[0] as unknown as [{ data: { newValues: Record<string, unknown> } }])[0].data;
    expect(audit.newValues.dayData).toEqual({ written: true, outlets: 2, rows: 3, lastDay });
  });

  it('the preview never reads the day split', async () => {
    const db = makeDb({ months: [PREV], aggs: DAY_AGGS });
    await services(db).preview.preview('t1', 'imp1');
    const selects = db.salesImportAggregate.findMany.mock.calls.map((c) => (c[0] as unknown as { select: Record<string, boolean> }).select);
    expect(selects.every((s) => s.days === undefined)).toBe(true);
  });

  it('re-apply REPLACES the day data; a file processed before day-level storage removes the old day data + set and SAYS so', async () => {
    const db = makeDb({ months: [PREV], aggs: DAY_AGGS });
    await services(db).apply.apply(user, 'imp1', body([PREV]));
    await services(db).apply.apply(user, 'imp1', body([PREV]));
    expect(db.log.filter((l) => l === 'days.delete')).toHaveLength(2); // every apply deletes the month's rows first
    expect(db.log.indexOf('days.delete')).toBeLessThan(db.log.indexOf('days.insert'));

    const old = makeDb({ months: [PREV], aggs: DAY_AGGS.map((a) => ({ ...a, days: null })) });
    const r = await services(old).apply.apply(user, 'imp1', body([PREV]));
    expect(r.results[0].ok).toBe(true); // the monthly figures are still written
    expect(r.results[0].dayData).toEqual({
      written: false, outlets: 0, rows: 0, lastDay: null, reason: expect.stringMatching(/processed before day-by-day sales were stored.*Reprocess/),
    });
    expect(old.log).toEqual(expect.arrayContaining(['days.delete', 'dayset.delete']));
    expect(old.log).not.toContain('days.insert');
    expect(old.salesDaySet.upsert).not.toHaveBeenCalled();
    const audit = (old.auditLog.create.mock.calls[0] as unknown as [{ data: { newValues: Record<string, unknown> } }])[0].data;
    expect(audit.newValues.dayData).toEqual(expect.objectContaining({ written: false }));
  });

  it('a day split that does not add up to its line is never used (no day data, reason given)', async () => {
    const broken = DAY_AGGS.map((a, i) => (i === 0 ? { ...a, days: [[2, '6000', P(1_000000n), 1]] as Array<[number, string, string, number]> } : a));
    const db = makeDb({ months: [PREV], aggs: broken });
    const r = await services(db).apply.apply(user, 'imp1', body([PREV]));
    expect(r.results[0].dayData?.written).toBe(false);
    expect(dayInsert(db)).toBeUndefined();
  });

  const histDay = (id: number, code: string, dims: Record<string, string>, paise: bigint, micro: bigint, days: Array<[number, string, string, number]> | null) => ({
    id: BigInt(id), month: PREV, customerCode: code, dims, dimKey: stableStringify(dims), amountPaise: paise, qtyPico: micro * 1_000_000n,
    lines: days ? days.reduce((s, d) => s + d[3], 0) : 1, days,
  });
  const DAY_HISTORY = [
    histDay(1, 'O1', { dimA: 'P', dimB: '500' }, 10000n, 1_500000n, [[2, '6000', P(1_000000n), 1], [9, '4000', P(500000n), 1]]),
    histDay(2, 'O2', { dimA: 'P', dimB: '50' }, -2500n, 0n, [[5, '-2500', '0', 1]]),
  ];

  it("recalculate rebuilds the day data from the stored lines (lastDay = the applied file's last invoice day); the preview says whether it can", async () => {
    const db = makeDb({ history: DAY_HISTORY });
    const p = await services(db).apply.recalcPreview('t1', PREV);
    expect(p.dayData).toEqual({ available: true });
    const r = await services(db).apply.recalculate(user, PREV, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() });
    expect(r.dayData).toEqual({ written: true, outlets: 2, rows: 3, lastDay: 28 }); // imp0's summary: last invoice on the 28th
    expect(dayInsert(db)!.values).toContainEqual([JSON.stringify({ OWN_AMT: 60, OWN_QTY: 1 }), JSON.stringify({ OWN_AMT: 100, OWN_QTY: 1.5 }), JSON.stringify({ OWN_AMT: -25 })]);
    const set = (db.salesDaySet.upsert.mock.calls[0] as unknown as [{ create: Record<string, unknown> }])[0];
    expect(set.create).toEqual(expect.objectContaining({ sourceImportId: 'imp0', lastDay: 28 }));

    const old = makeDb({ history: DAY_HISTORY.map((h) => ({ ...h, days: null })) });
    const q = await services(old).apply.recalcPreview('t1', PREV);
    expect(q.dayData).toEqual({ available: false, reason: expect.stringMatching(/applied before day-by-day sales were stored/) });
  });

  it('S1 switch ON — purged history (outside current + 3 previous months) is reported honestly: 404 with the retention reason, even while rows remain', () => withRetentionV2('on', async () => {
    const OUT = shiftMonthKey(CUR, -4);
    const db = makeDb({ history: DAY_HISTORY.map((h) => ({ ...h, month: OUT })) });
    await expect(services(db).apply.recalcPreview('t1', OUT)).rejects.toThrow(/kept only for the current month and the 3 months before it/);
    await expect(services(db).apply.recalculate(user, OUT, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(db.salesMonthHistorySet.findUnique).not.toHaveBeenCalled(); // never reads a half-deleted month
    // the oldest month INSIDE the window still works
    const IN = shiftMonthKey(CUR, -3);
    const ok = makeDb({ history: DAY_HISTORY.map((h) => ({ ...h, month: IN })) });
    await expect(services(ok).apply.recalcPreview('t1', IN)).resolves.toEqual(expect.objectContaining({ month: IN }));
  }));

  it('S1 switch OFF (default): a month 4 back still recalculates from its history (10-year retention); its day data is NOT stored (outside the day window) and the result says so', () => withRetentionV2(undefined, async () => {
    const OUT = shiftMonthKey(CUR, -4);
    // reopened by Gifsy (an OLDER month is CLOSED by default)
    const db = makeDb({ history: DAY_HISTORY.map((h) => ({ ...h, month: OUT })), statuses: [{ month: OUT, state: 'OPEN', reopenedAt: AT, closedAt: null, lastAppliedImportId: null }] });
    const p = await services(db).apply.recalcPreview('t1', OUT);
    expect(p.dayData).toEqual({ available: false, reason: expect.stringMatching(/Day-by-day figures are kept only for the current month and the 3 months before it/) });
    const r = await services(db).apply.recalculate(user, OUT, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() });
    expect(r.dayData).toEqual(expect.objectContaining({ written: false, reason: expect.stringMatching(/kept only for the current month/) }));
    expect(dayInsert(db)).toBeUndefined();
    // the day split is not even read for such a month
    const selects = db.salesMonthHistory.findMany.mock.calls.map((c) => (c[0] as unknown as { select: Record<string, boolean> }).select);
    expect(selects.every((x) => x.days === undefined)).toBe(true);
  }));

  it('S5: above SALES_DAY_BUILD_MAX_ROWS matched rows the day build is SKIPPED with a loud reason (monthly figures still written)', async () => {
    const prev = process.env.SALES_DAY_BUILD_MAX_ROWS;
    process.env.SALES_DAY_BUILD_MAX_ROWS = '2';
    try {
      const db = makeDb({ months: [PREV], aggs: DAY_AGGS }); // 3 matched rows (O1 ×2, O2; GONE / O4 are off-roster)
      const r = await services(db).apply.apply(user, 'imp1', body([PREV]));
      expect(r.results[0].ok).toBe(true);
      expect(r.results[0].dayData).toEqual({
        written: false, outlets: 0, rows: 0, lastDay: null, reason: expect.stringMatching(/too many sales lines for programme outlets \(3; the limit is 2\)/),
      });
      expect(dayInsert(db)).toBeUndefined();
      const pdb = makeDb({ history: DAY_HISTORY });
      process.env.SALES_DAY_BUILD_MAX_ROWS = '1';
      const p = await services(pdb).apply.recalcPreview('t1', PREV);
      expect(p.dayData).toEqual({ available: false, reason: expect.stringMatching(/too many sales lines/) });
    } finally {
      if (prev === undefined) delete process.env.SALES_DAY_BUILD_MAX_ROWS;
      else process.env.SALES_DAY_BUILD_MAX_ROWS = prev;
    }
  });
});

// ─── Background job hooks (owner 2026-11-18: apply / recalculate run in the sales-import worker) ──────────────────
describe('background-job hooks + prechecks', () => {
  const body = (months: string[], over: Record<string, unknown> = {}) => ({ months, expectedDefinitionsHash: HASH, processingVersion: VERSION, ...over });

  it('precheckApply: the same 4xx as apply before any transaction, and returns the sorted months', async () => {
    const db = makeDb();
    await expect(services(db).apply.precheckApply(user, 'imp1', body([PREV], { expectedDefinitionsHash: 'x' }))).rejects.toBeInstanceOf(ConflictException);
    await expect(services(db).apply.precheckApply(user, 'imp1', body([]))).rejects.toBeInstanceOf(BadRequestException);
    await expect(services(db).apply.precheckApply(user, 'nope', body([PREV]))).rejects.toBeInstanceOf(NotFoundException);
    expect(await services(db).apply.precheckApply(user, 'imp1', body([CUR, PREV]))).toEqual([PREV, CUR]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('apply: beforeMonth runs before each month, inTx runs INSIDE the month transaction after the write (with the result)', async () => {
    const db = makeDb();
    const seen: string[] = [];
    const r = await services(db).apply.apply(user, 'imp1', body([PREV, CUR]), {
      beforeMonth: async (m) => { seen.push(`before:${m}:${db.$transaction.mock.calls.length}`); },
      inTx: async (tx, res) => { seen.push(`inTx:${res.month}:${res.ok}:${tx === (db as unknown)}:${db.log.at(-1)}`); },
    });
    expect(r.results.map((x) => x.ok)).toEqual([true, true]);
    expect(seen).toEqual([`before:${PREV}:0`, `inTx:${PREV}:true:true:audit`, `before:${CUR}:1`, `inTx:${CUR}:true:true:audit`]);
  });

  it('apply: an inTx throw fails THAT month (its transaction rolls back) and the next month still runs', async () => {
    const db = makeDb();
    const r = await services(db).apply.apply(user, 'imp1', body([PREV, CUR]), {
      inTx: async (_tx, res) => { if (res.month === PREV) throw new Error('claim lost'); },
    });
    expect(r.results).toEqual([
      expect.objectContaining({ month: PREV, ok: false, error: 'Apply failed for this month. Nothing was changed for it.' }),
      expect.objectContaining({ month: CUR, ok: true }),
    ]);
  });

  it('apply: an ApplyStopError from beforeMonth stops the run (propagates; later months are not written)', async () => {
    const { ApplyStopError } = await import('./sales-apply.service');
    const db = makeDb();
    await expect(services(db).apply.apply(user, 'imp1', body([PREV, CUR]), {
      beforeMonth: async (m) => { if (m === CUR) throw new ApplyStopError('stopping'); },
    })).rejects.toBeInstanceOf(ApplyStopError);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  const HISTORY = [
    { id: 1n, month: PREV, customerCode: 'O1', dims: { dimA: 'P', dimB: '500' }, dimKey: stableStringify({ dimA: 'P', dimB: '500' }), amountPaise: 10000n, qtyPico: 1_500000n * 1_000_000n, lines: 1 },
  ];

  it('A-L1: precheckApply refuses a CLOSED (or not started) month at once with its reason (409); the worker re-checks anyway', async () => {
    const db = makeDb({ statuses: [{ month: PREV, state: 'CLOSED', closedAt: AT }] });
    await expect(services(db).apply.precheckApply(user, 'imp1', body([PREV, CUR]))).rejects.toThrow(ConflictException);
    await expect(services(db).apply.precheckApply(user, 'imp1', body([PREV]))).rejects.toThrow(/CLOSED/);
    await expect(services(makeDb()).apply.precheckApply(user, 'imp1', body([FUT]))).rejects.toBeInstanceOf(BadRequestException); // not in the file
    expect(await services(makeDb()).apply.precheckApply(user, 'imp1', body([PREV]))).toEqual([PREV]);
  });

  it('A-L1: precheckRecalculate refuses a CLOSED month at once (409)', async () => {
    const db = makeDb({ history: HISTORY, statuses: [{ month: PREV, state: 'CLOSED', closedAt: AT }] });
    await expect(services(db).apply.precheckRecalculate(user, PREV, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() }))
      .rejects.toThrow(/CLOSED/);
  });

  it('A-L2: in a background job a TRANSIENT DB error (deadlock / connection) propagates as TransientApplyError (retry); a direct call still reports it per month', async () => {
    const { TransientApplyError, isTransientDbError } = await import('./sales-apply.service');
    const db = makeDb();
    db.salesUploadBatch.create.mockRejectedValue(new Error('deadlock detected'));
    await expect(services(db).apply.apply(user, 'imp1', body([PREV]), {})).rejects.toBeInstanceOf(TransientApplyError);
    const direct = await services(db).apply.apply(user, 'imp1', body([PREV]));
    expect(direct.results[0]).toEqual(expect.objectContaining({ ok: false, error: 'Apply failed for this month. Nothing was changed for it.' }));
    for (const e of [{ code: 'P1001' }, { code: 'P2034' }, { code: 'P2028' }, { code: 'P2010', meta: { code: '40001' } }, new Error('Connection terminated unexpectedly')]) {
      expect(isTransientDbError(e)).toBe(true);
    }
    for (const e of [new Error('null value in column'), { code: 'P2002' }, new ConflictException('closed')]) expect(isTransientDbError(e)).toBe(false);
  });

  it('precheckRecalculate: 400 bad body, 404 no history, 409 stale history / definitions — no transaction', async () => {
    const none = makeDb();
    await expect(services(none).apply.precheckRecalculate(user, PREV, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() })).rejects.toBeInstanceOf(NotFoundException);
    const db = makeDb({ history: HISTORY });
    await expect(services(db).apply.precheckRecalculate(user, 'bad', { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() })).rejects.toBeInstanceOf(BadRequestException);
    await expect(services(db).apply.precheckRecalculate(user, PREV, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: new Date(0).toISOString() })).rejects.toBeInstanceOf(ConflictException);
    await expect(services(db).apply.precheckRecalculate(user, PREV, { expectedDefinitionsHash: 'x', expectedHistoryAppliedAt: AT.toISOString() })).rejects.toBeInstanceOf(ConflictException);
    await expect(services(db).apply.precheckRecalculate(user, PREV, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() })).resolves.toBeUndefined();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('recalculate: inTx runs inside the transaction after the write', async () => {
    const db = makeDb({ history: HISTORY });
    const seen: string[] = [];
    await services(db).apply.recalculate(user, PREV, { expectedDefinitionsHash: HASH, expectedHistoryAppliedAt: AT.toISOString() }, {
      inTx: async (_tx, res) => { seen.push(`${res.month}:${res.ok}:${db.log.at(-1)}`); },
    });
    expect(seen).toEqual([`${PREV}:true:audit`]);
  });
});

describe('preview × background jobs', () => {
  it('a month with an Apply / Recalculate queued or running cannot be ticked: activeJob + "being applied by X since HH:MM"', async () => {
    const db = makeDb({
      activeJobs: [{ month: PREV, jobId: 'j1', kind: 'APPLY', status: 'RUNNING', importId: 'imp1', requestedByName: 'Ravi', createdAt: new Date('2026-11-18T05:02:00.000Z') }],
    });
    const p = await services(db).preview.preview('t1', 'imp1');
    const prev = p.months.find((m) => m.month === PREV)!;
    expect(prev.activeJob).toEqual({ jobId: 'j1', kind: 'APPLY', status: 'RUNNING', importId: 'imp1', requestedBy: 'Ravi', createdAt: '2026-11-18T05:02:00.000Z' });
    expect(prev.canApply).toBe(false);
    expect(prev.blockedReason).toMatch(new RegExp(`^${monthLabelOf(PREV)} is being applied by Ravi since (\d+ \w+, )?10:32\. Wait for it to finish\.$`));
    const cur = p.months.find((m) => m.month === CUR)!;
    expect(cur.activeJob).toBeNull();
    expect(cur.canApply).toBe(true);
    expect(cur.lastJob).toBeNull();
  });

  it('B-H1: the preview carries each month latest FINISHED job so its result is shown when coming back', async () => {
    const fin = { month: PREV, jobId: 'j0', kind: 'APPLY', status: 'DONE', importId: 'imp1', requestedByName: 'Asha',
      createdAt: new Date('2026-11-18T05:02:00.000Z'), finishedAt: new Date('2026-11-18T05:04:00.000Z'), result: { month: PREV, ok: true, outletsWritten: 3 } };
    const p = await services(makeDb({ lastJobs: [fin] })).preview.preview('t1', 'imp1');
    expect(p.months.find((m) => m.month === PREV)!.lastJob).toEqual(expect.objectContaining({ jobId: 'j0', status: 'DONE', requestedBy: 'Asha',
      finishedAt: '2026-11-18T05:04:00.000Z', result: { month: PREV, ok: true, outletsWritten: 3 } }));
  });
});
