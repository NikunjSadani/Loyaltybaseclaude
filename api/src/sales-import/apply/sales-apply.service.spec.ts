import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentMonthKey } from '../../targets/targets.helpers';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { SalesKpiDefService } from '../kpi/sales-kpi-def.service';
import { definitionsHash, stableStringify } from '../kpi/sales-kpi.helper';
import { mappingFingerprint } from '../ingest/mapping-fingerprint';
import type { SalesColumnMapping } from '../sales-import.contract';
import { lastDayOfMonth, shiftMonthKey } from '../months/month-state';
import { SalesPreviewService } from './sales-preview.service';
import { SalesApplyService, outletsAffected } from './sales-apply.service';

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
const agg = (id: number, month: string, outletCode: string, dims: Record<string, string>, amountPaise: bigint, qtyMicro: bigint) => ({
  id: BigInt(id), importId: 'imp1', month, outletCode, dims, dimKey: stableStringify(dims), amountPaise, qtyPico: qtyMicro * 1_000_000n, lines: 1,
});

function makeDb(opts: {
  months?: string[];
  statuses?: Array<Record<string, unknown>>;
  existing?: Array<Record<string, unknown>>;
  defs?: typeof DEF_ROWS;
  /** The newest SalesImportApply of the month (another import `imp0` whose latest invoice in the month is `lastDate`). */
  lastApply?: { lastDate: string } | null;
  roster?: Array<Record<string, unknown>>;
  /** Stored month history (SalesMonthHistory rows, aggregate-shaped with customerCode). */
  history?: Array<Record<string, unknown>>;
  historyAppliedAt?: Date;
  profile?: SalesColumnMapping;
  rosterAdded?: number;
} = {}) {
  const months = opts.months ?? [PREV, CUR];
  const log: string[] = [];
  const aggs = months.flatMap((m, i) => [
    agg(i * 10 + 1, m, 'O1', { dimA: 'P', dimB: '500' }, 10000n, 1_500000n),
    agg(i * 10 + 2, m, 'O1', { dimA: 'Q', dimB: '500' }, 5000n, 500000n),
    agg(i * 10 + 3, m, 'O2', { dimA: 'P', dimB: '50' }, -2500n, 0n),
    agg(i * 10 + 4, m, 'GONE', { dimA: 'P', dimB: '50' }, 99999n, 0n), // not on the CURRENT roster → never written
    agg(i * 10 + 5, m, 'O4', { dimA: 'P', dimB: '50' }, 700n, 0n), // only written if O4 is on the roster at apply time
  ]);
  const imp: Record<string, unknown> & { monthSummaries: unknown; processingVersion: number } = {
    id: 'imp1', clientId: 't1', status: 'READY', createdAt: AT, finishedAt: AT, purgedAt: null,
    processingVersion: VERSION, mappingFingerprint: mappingFingerprint(MAPPING),
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
    salesImportProfile: { findUnique: jest.fn(async () => ({ columnMapping: opts.profile ?? MAPPING })) },
    salesMonthHistory: {
      findFirst: jest.fn(async () => (opts.history ? { sourceImportId: 'imp0', appliedAt: opts.historyAppliedAt ?? AT } : null)),
      findMany: jest.fn(async ({ where, take }: { where: { month: string; id?: { gt: bigint } }; take: number }) =>
        (opts.history ?? []).filter((h) => h.month === where.month && (!where.id || (h.id as bigint) > where.id.gt)).slice(0, take)),
    },
    // lockImportRow(…, 'SHARE') — H1: the apply holds the import row FOR SHARE
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      log.push(`import.${/FOR (\w+)/.exec(q.strings.join('?'))?.[1]?.toLowerCase()}`);
      return q.values[0] === 'imp1' && q.values[1] === 't1' ? [{ ...imp }] : [];
    }),
    salesKpiDefinition: { findMany: jest.fn(async () => opts.defs ?? DEF_ROWS) },
    outlet: { findMany: jest.fn(async () => opts.roster ?? ROSTER), count: jest.fn(async () => opts.rosterAdded ?? 0) },
    kpiDef: { findMany: jest.fn(async () => [{ code: 'OWN_AMT', label: 'Owned ₹' }, { code: 'OWN_QTY', label: 'Owned cases' }]) },
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
    user: { findUnique: jest.fn(async () => ({ name: 'Applier' })) },
    $executeRaw: jest.fn(async (q: Prisma.Sql | TemplateStringsArray) => {
      const text = 'strings' in (q as Prisma.Sql) ? (q as Prisma.Sql).strings.join('?') : (q as TemplateStringsArray).join('?');
      log.push(
        text.includes('pg_advisory_xact_lock') ? 'lock'
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
    expect(r.results).toEqual([{ month: PREV, ok: true, applyId: 'apply1', outletsWritten: 3, outletsZeroFilled: 1 }]);
    expect(db.log).toEqual(['lock', 'import.share', 'batch.create', 'insert', 'strip', 'history.delete', 'history.insert', 'apply.create', 'status.upsert', 'audit']);

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

  it('apply REPLACES the month history with this import’s lines (every customer code; outletId from the roster now) inside the same tx', async () => {
    const db = makeDb();
    await services(db).apply.apply(user, 'imp1', body([PREV]));
    const sql = sqlCalls(db);
    const del = sql.find((q) => q.text.includes('DELETE FROM "sales_month_histories"'))!;
    expect(del.values).toEqual(['t1', PREV]);
    const ins = sql.find((q) => q.text.includes('INSERT INTO "sales_month_histories"'))!;
    expect(ins.text).toContain('FROM "sales_import_aggregates" a');
    expect(ins.text).toContain('LEFT JOIN unnest('); // unmatched codes kept, outletId null
    expect(ins.values).toEqual(expect.arrayContaining(['t1', 'imp1', 'u1', ['O1', 'O2', 'O3'], ['id-O1', 'id-O2', 'id-O3'], PREV]));
    expect(db.log.indexOf('history.delete')).toBeLessThan(db.log.indexOf('history.insert'));
    expect(db.log.indexOf('history.insert')).toBeLessThan(db.log.indexOf('apply.create'));
    expect((db.salesImportApply.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data.source).toBe('IMPORT');
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
    expect(db.log).toEqual(['lock', 'batch.create', 'insert', 'strip', 'apply.create', 'status.upsert', 'audit']);
    const apply = (db.salesImportApply.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(apply).toEqual(expect.objectContaining({ source: 'HISTORY', importId: 'imp0' }));
    const audit = (db.auditLog.create.mock.calls[0] as unknown as [{ data: { newValues: Record<string, unknown> } }])[0].data;
    expect(audit.newValues).toEqual(expect.objectContaining({ source: 'HISTORY', importId: 'imp0' }));
    expect(sqlCalls(db)[1].values).toContainEqual(['O1', 'O2', 'O3']);
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
});
