import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentMonthKey } from '../../targets/targets.helpers';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { SalesKpiDefService } from '../kpi/sales-kpi-def.service';
import { definitionsHash, rosterHashOf, stableStringify } from '../kpi/sales-kpi.helper';
import { lastDayOfMonth, shiftMonthKey } from '../months/month-state';
import { SalesPreviewService } from './sales-preview.service';
import { SalesApplyService } from './sales-apply.service';

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

const ROSTER = [
  { outletCode: 'O1', name: 'One', programName: null, outletType: { code: 'WHOLESALER' } },
  { outletCode: 'O2', name: 'Two', programName: null, outletType: { code: 'RETAIL' } },
  { outletCode: 'O3', name: 'Three', programName: null, outletType: { code: 'RETAIL' } }, // no lines → zero-fill
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
  id: BigInt(id), importId: 'imp1', month, outletCode, dims, dimKey: stableStringify(dims), amountPaise, qtyMicro, lines: 1,
});

function makeDb(opts: {
  months?: string[];
  statuses?: Array<Record<string, unknown>>;
  rosterHash?: string | null;
  existing?: Array<Record<string, unknown>>;
  defs?: typeof DEF_ROWS;
  importCreatedAt?: Date;
} = {}) {
  const months = opts.months ?? [PREV, CUR];
  const log: string[] = [];
  const aggs = months.flatMap((m, i) => [
    agg(i * 10 + 1, m, 'O1', { dimA: 'P', dimB: '500' }, 10000n, 1_500000n),
    agg(i * 10 + 2, m, 'O1', { dimA: 'Q', dimB: '500' }, 5000n, 500000n),
    agg(i * 10 + 3, m, 'O2', { dimA: 'P', dimB: '50' }, -2500n, 0n),
    agg(i * 10 + 4, m, 'GONE', { dimA: 'P', dimB: '50' }, 99999n, 0n), // dropped from the roster since processing
  ]);
  const imp = {
    id: 'imp1', clientId: 't1', status: 'READY', createdAt: opts.importCreatedAt ?? AT,
    rosterHash: opts.rosterHash === undefined ? rosterHashOf(ROSTER.map((o) => o.outletCode)) : opts.rosterHash,
    monthSummaries: months.map((m) => summary(m)),
  };
  const statuses = opts.statuses ?? [];
  const db = {
    log,
    imp,
    salesImport: {
      findFirst: jest.fn(async ({ where }: { where: { id?: string; clientId: string } }) =>
        where.clientId === 't1' && (!where.id || where.id === 'imp1') ? imp : null),
      findMany: jest.fn(async () => [{ id: 'imp0', createdAt: new Date(AT.getTime() + 60_000) }]),
    },
    salesKpiDefinition: { findMany: jest.fn(async () => opts.defs ?? DEF_ROWS) },
    outlet: { findMany: jest.fn(async () => ROSTER) },
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
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => { log.push('apply.create'); return { id: 'apply1' }; }),
    },
    salesUploadBatch: { create: jest.fn(async (a: { data: Record<string, unknown> }) => { log.push('batch.create'); return { id: 'batch1', ...a.data }; }) },
    auditLog: { create: jest.fn(async () => { log.push('audit'); return {}; }) },
    user: { findUnique: jest.fn(async () => ({ name: 'Applier' })) },
    $executeRaw: jest.fn(async (q: Prisma.Sql | TemplateStringsArray) => {
      const text = 'strings' in (q as Prisma.Sql) ? (q as Prisma.Sql).strings.join('?') : (q as TemplateStringsArray).join('?');
      log.push(text.includes('pg_advisory_xact_lock') ? 'lock' : text.includes('INSERT') ? 'insert' : 'strip');
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
    expect(p.rosterHashMatches).toBe(true);
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
  });

  it('partial months warn; the CURRENT month never gets ENDS_BEFORE_MONTH_END', async () => {
    const db = makeDb();
    db.imp.monthSummaries = [summary(PREV, { firstDate: `${PREV}-05`, lastDate: `${PREV}-20` }), summary(CUR)];
    const p = await services(db).preview.preview('t1', 'imp1');
    expect(p.months[0].warnings).toEqual(expect.arrayContaining(['STARTS_AFTER_FIRST', 'ENDS_BEFORE_MONTH_END']));
    expect(p.months[1].warnings).not.toContain('ENDS_BEFORE_MONTH_END');
  });

  it('ROSTER_CHANGED blocks apply', async () => {
    const p = await services(makeDb({ rosterHash: 'stale' })).preview.preview('t1', 'imp1');
    expect(p.rosterHashMatches).toBe(false);
    for (const m of p.months) {
      expect(m.warnings).toContain('ROSTER_CHANGED');
      expect(m.canApply).toBe(false);
      expect(m.blockedReason).toMatch(/Reprocess/);
    }
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

  it('OLDER_THAN_LAST_APPLIED when a newer import was last applied', async () => {
    const db = makeDb({ statuses: [{ month: PREV, state: 'OPEN', lastAppliedImportId: 'imp0' }] });
    const p = await services(db).preview.preview('t1', 'imp1');
    expect(p.months.find((m) => m.month === PREV)!.warnings).toContain('OLDER_THAN_LAST_APPLIED');
  });

  it('no owned KPI → every month blocked with a clear reason', async () => {
    const p = await services(makeDb({ defs: [] })).preview.preview('t1', 'imp1');
    expect(p.months.every((m) => !m.canApply && /No importer-owned KPIs/.test(m.blockedReason ?? ''))).toBe(true);
  });
});

// ─── APPLY ───────────────────────────────────────────────────────────────────

describe('SalesApplyService', () => {
  const body = (months: string[], over: Record<string, unknown> = {}) => ({ months, expectedDefinitionsHash: HASH, ...over });

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

  it('older-than-last-applied needs its own ack', async () => {
    const db = makeDb({ statuses: [{ month: PREV, state: 'OPEN', lastAppliedImportId: 'imp0' }] });
    await expect(services(db).apply.apply(user, 'imp1', body([PREV]))).rejects.toThrow(/older/);
    const r = await services(db).apply.apply(user, 'imp1', body([PREV], { acknowledgeOlderThanLastApplied: true }));
    expect(r.results[0].ok).toBe(true);
  });

  it('happy path: lock FIRST, SALES_IMPORT batch, owned-only merge SQL, strip of other rows, history, pointer, audit', async () => {
    const db = makeDb();
    const r = await services(db).apply.apply(user, 'imp1', body([PREV]));
    expect(r.results).toEqual([{ month: PREV, ok: true, applyId: 'apply1', outletsWritten: 3, outletsZeroFilled: 1 }]);
    expect(db.log).toEqual(['lock', 'batch.create', 'insert', 'strip', 'apply.create', 'status.upsert', 'audit']);

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

  it('a month not in the file → ok:false; roster changed under the lock → ok:false', async () => {
    const r1 = await services(makeDb()).apply.apply(user, 'imp1', body([OLD]));
    expect(r1.results[0]).toEqual(expect.objectContaining({ ok: false }));
    expect(r1.results[0].error).toMatch(/not in this file/);
    const r2 = await services(makeDb({ rosterHash: 'stale' })).apply.apply(user, 'imp1', body([PREV]));
    expect(r2.results[0].error).toMatch(/Reprocess/);
  });

  it('body validation', async () => {
    const s = services(makeDb()).apply;
    await expect(s.apply(user, 'imp1', { months: [], expectedDefinitionsHash: HASH })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.apply(user, 'imp1', { months: ['2026-13'], expectedDefinitionsHash: HASH })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.apply(user, 'imp1', { months: [PREV, PREV], expectedDefinitionsHash: HASH })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.apply(user, 'imp1', { months: [PREV] } as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cross-tenant import id → 404', async () => {
    await expect(services(makeDb()).apply.apply({ ...user, clientId: 't2' }, 'imp1', body([PREV]))).rejects.toBeInstanceOf(NotFoundException);
  });
});
