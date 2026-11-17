import { Prisma } from '@prisma/client';
import { currentMonthKey } from '../../targets/targets.helpers';
import { shiftMonthKey } from '../months/month-state';
import { stableStringify, type KpiDefLite } from '../kpi/sales-kpi.helper';
import { applyTrim, assertDatabase, countTrim, formatCounts } from './sales-history-trim';
import { withRetentionV2 } from '../retention-env.testspec';
import { parseArgs } from './sales-history-trim.main';
import { rebuildMonthDays, type RebuildDeps } from './sales-day-rebuild';

const CUR = currentMonthKey();
const PREV = shiftMonthKey(CUR, -1);
const OLD = shiftMonthKey(CUR, -5); // outside the window (current + 3 previous)
const sqlText = (q: unknown) => (q as Prisma.Sql).strings.join('?');

// ─── trim ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * In-memory history for the trim: `rows` = SalesMonthHistory lines (customerCode, outletId) of month PREV for tenant t1;
 * `roster` = t1's CURRENT roster outlet codes (S3: "programme" = on this roster now, NOT the apply-time outletId).
 */
function trimDb(state: {
  rows?: Array<{ customerCode: string; outletId: string | null }>;
  roster?: string[];
  beyond: number; expired: number; pending: number; header?: boolean;
  missingDayData?: Array<{ clientId: string; month: string; sourceImportId: string }>;
}) {
  const log: string[] = [];
  const rows = state.rows ?? [];
  const roster = state.roster ?? ['R1'];
  const onRoster = (codes: unknown) => (c: string) => (codes as string[]).includes(c);
  const db = {
    log,
    state,
    rows,
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      const t = sqlText(q);
      if (t.includes('current_database()')) return [{ db: 'gifsy_staging' }];
      if (t.includes('SELECT DISTINCT s."clientId"')) return rows.length > 0 ? [{ clientId: 't1' }] : [];
      if (t.includes('LEFT JOIN "sales_day_sets"')) return state.missingDayData ?? [];
      if (t.includes('GROUP BY 1, 2')) {
        if (t.includes('"sales_month_histories"') && t.includes('NOT (h."customerCode" = ANY(')) {
          const codes = q.values.find(Array.isArray)!;
          const n = rows.filter((r) => !onRoster(codes)(r.customerCode)).length;
          return n > 0 ? [{ clientId: 't1', month: PREV, n }] : [];
        }
        if (t.includes('"sales_month_histories"') && t.includes('"outletId" IS NULL')) {
          const codes = q.values.find(Array.isArray)!;
          const n = rows.filter((r) => r.outletId === null && onRoster(codes)(r.customerCode)).length;
          return n > 0 ? [{ clientId: 't1', month: PREV, n }] : [];
        }
        if (t.includes('"sales_month_histories"')) return state.beyond > 0 ? [{ clientId: 't1', month: OLD, n: state.beyond }] : [];
        return [];
      }
      if (t.includes('count(*)::int AS n FROM "sales_month_histories"')) return [{ n: rows.length }];
      throw new Error(`unexpected query ${t}`);
    }),
    $executeRaw: jest.fn(async (q: Prisma.Sql) => {
      const t = sqlText(q);
      if (t.includes('pg_advisory_xact_lock')) { log.push('lock'); return 0; }
      if (t.includes('DELETE FROM "sales_month_histories"')) {
        const codes = q.values.find(Array.isArray)!;
        const limit = q.values[q.values.length - 1] as number;
        let n = 0;
        for (let i = rows.length - 1; i >= 0 && n < limit; i--) {
          if (!onRoster(codes)(rows[i].customerCode)) { rows.splice(i, 1); n++; }
        }
        log.push(`delete-unmatched:${n}`);
        return n;
      }
      if (t.includes('UPDATE "sales_month_histories" h SET "outletId"')) {
        const [codes, ids] = q.values.filter(Array.isArray) as [string[], string[]];
        let n = 0;
        for (const r of rows) {
          const i = codes.indexOf(r.customerCode);
          if (r.outletId === null && i >= 0) { r.outletId = ids[i]; n++; }
        }
        log.push(`backfill:${n}`);
        return n;
      }
      if (t.includes('DELETE FROM "sales_month_history_combos"')) { log.push('combos.delete'); return 3; }
      if (t.includes('INSERT INTO "sales_month_history_combos"')) { log.push('combos.insert'); return 5; }
      throw new Error(`unexpected write ${t}`);
    }),
    $executeRawUnsafe: jest.fn(async () => 0),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    outlet: {
      findMany: jest.fn(async () => roster.map((c) => ({ id: `id-${c}`, outletCode: c, name: c, programName: null, programCategory: null, outletType: { code: 'RETAIL' } }))),
    },
    salesMonthHistorySet: {
      findUnique: jest.fn(async () => (state.header === false ? null : { sourceImportId: 'imp9', appliedAt: new Date('2026-01-01T00:00:00Z') })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    salesImport: {
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => ('filesPurgedAt' in where ? state.pending : state.expired)),
    },
  };
  const retention = {
    purgeOldHistory: jest.fn(async (_o?: unknown) => { const n = Math.min(3, state.beyond); state.beyond -= n; return n; }),
    sweep: jest.fn(async (_o?: unknown) => { const n = Math.min(2, state.expired); state.expired -= n; state.pending = 0; return { abandoned: 0, purged: n }; }),
  };
  return { db, retention };
}

/** 5 history rows of customers that are NOT on today's roster (X1..X5, outletId null as applied). */
const NOT_ON_ROSTER = (): Array<{ customerCode: string; outletId: string | null }> =>
  Array.from({ length: 5 }, (_, i) => ({ customerCode: `X${i + 1}`, outletId: null }));

describe('one-off sales-history-trim', () => {
  it('guards on current_database(): must EXACTLY equal TRIM_TARGET_DB (unset or different → refuse)', async () => {
    const { db } = trimDb({ beyond: 0, expired: 0, pending: 0 });
    await expect(assertDatabase(db, undefined)).rejects.toThrow(/Set TRIM_TARGET_DB/);
    await expect(assertDatabase(db, 'gifsy_prod')).rejects.toThrow(/Connected to "gifsy_staging" but TRIM_TARGET_DB is "gifsy_prod"/);
    await expect(assertDatabase(db, 'gifsy_staging')).resolves.toBe('gifsy_staging');
  });

  it('S1: DRY-RUN counts per tenant × month and writes NOTHING; applies the NEW windows explicitly even with SALES_RETENTION_V2 off', () => withRetentionV2(undefined, async () => {
    const { db, retention } = trimDb({ rows: NOT_ON_ROSTER(), beyond: 7, expired: 3, pending: 1 });
    const c = await countTrim(db as never, { database: 'gifsy_staging' });
    expect(c.keepFromMonth).toBe(shiftMonthKey(CUR, -3));
    expect(c.unmatchedHistory).toEqual([{ clientId: 't1', month: PREV, rows: 5 }]);
    expect(c.beyondWindow.historyLines).toEqual([{ clientId: 't1', month: OLD, rows: 7 }]);
    expect(c).toMatchObject({ expiredImports: 3, pendingFileDeletes: 1, importRetentionDays: 7 });
    expect(formatCounts(c).join('\n')).toMatch(new RegExp(`t1 ${PREV}: 5[\\s\\S]*historyLines: 7[\\s\\S]*t1 ${OLD}: 7[\\s\\S]*not yet purged: 3`));
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(retention.purgeOldHistory).not.toHaveBeenCalled();
    expect(retention.sweep).not.toHaveBeenCalled();
    // the not-on-roster count only looks INSIDE the window (older months go wholesale in step 2)
    const q = db.$queryRaw.mock.calls.map((x) => x[0] as Prisma.Sql).find((x) => sqlText(x).includes('NOT (h."customerCode" = ANY('))!;
    expect(sqlText(q)).toContain('h."month" >= ?');
    expect(q.values).toContain(shiftMonthKey(CUR, -3));
  }));

  it("S3: programme = on the CURRENT roster — a row with a null outletId whose customer is on today's roster is KEPT (and back-filled); a row with an outletId whose customer left the roster is deleted", async () => {
    const rows = [
      { customerCode: 'R1', outletId: null as string | null }, // joined the roster after the apply → kept, back-filled
      { customerCode: 'R2', outletId: 'id-R2' }, // programme outlet → kept
      { customerCode: 'GONE', outletId: 'id-GONE' }, // on the roster at apply time, removed since → deleted
      { customerCode: 'X1', outletId: null }, // never on the roster → deleted
    ];
    const { db, retention } = trimDb({ rows, roster: ['R1', 'R2'], beyond: 0, expired: 0, pending: 0 });
    const before = await countTrim(db as never, { database: 'gifsy_staging' });
    expect(before.unmatchedHistory).toEqual([{ clientId: 't1', month: PREV, rows: 2 }]);
    expect(before.nullOutletOnRoster).toEqual([{ clientId: 't1', month: PREV, rows: 1 }]);
    const r = await applyTrim({ db: db as never, retention, log: () => undefined }, before);
    expect(db.rows).toEqual([{ customerCode: 'R1', outletId: 'id-R1' }, { customerCode: 'R2', outletId: 'id-R2' }]);
    expect(r).toMatchObject({ unmatchedDeleted: 2, outletIdsBackfilled: 1 });
    // the delete never keys on the apply-time outletId
    const del = db.$executeRaw.mock.calls.map((x) => x[0] as Prisma.Sql).find((x) => sqlText(x).includes('DELETE FROM "sales_month_histories"'))!;
    expect(sqlText(del)).not.toContain('outletId');
    expect(sqlText(del)).toContain('NOT (h."customerCode" = ANY(');
  });

  it('S3: a tenant whose roster is EMPTY today is skipped and reported — never "delete everything"', async () => {
    const { db, retention } = trimDb({ rows: NOT_ON_ROSTER(), roster: [], beyond: 0, expired: 0, pending: 0 });
    const before = await countTrim(db as never, { database: 'gifsy_staging' });
    expect(before.unmatchedHistory).toEqual([]);
    expect(before.skippedTenants).toEqual([{ clientId: 't1', reason: expect.stringMatching(/roster is empty/) }]);
    expect(formatCounts(before).join('\n')).toMatch(/SKIPPED tenant t1/);
    const lines: string[] = [];
    await applyTrim({ db: db as never, retention, log: (l) => lines.push(l) }, before);
    expect(db.rows).toHaveLength(5);
    expect(lines.join('\n')).toMatch(/SKIPPED tenant t1/);
  });

  it('--apply: batches the deletes under the month lock, rebuilds the product list, then drains old months + expired imports with the EXPLICIT new windows (S1)', () => withRetentionV2(undefined, async () => {
    const { db, retention } = trimDb({ rows: NOT_ON_ROSTER(), beyond: 7, expired: 3, pending: 0 });
    const before = await countTrim(db as never, { database: 'gifsy_staging' });
    const lines: string[] = [];
    const r = await applyTrim({ db: db as never, retention, log: (l) => lines.push(l) }, before, { batchRows: 2 });
    expect(db.log.filter((l) => l.startsWith('delete-unmatched'))).toEqual(['delete-unmatched:2', 'delete-unmatched:2', 'delete-unmatched:1']);
    // every batch is its own short transaction holding the month lock
    expect(db.log.slice(0, 2)).toEqual(['lock', 'delete-unmatched:2']);
    const del = db.$executeRaw.mock.calls.map((c) => c[0] as Prisma.Sql).find((x) => sqlText(x).includes('DELETE FROM "sales_month_histories"'))!;
    expect(sqlText(del)).toContain('LIMIT ?');
    expect(db.log).toEqual(expect.arrayContaining(['combos.delete', 'combos.insert']));
    expect(db.salesMonthHistorySet.updateMany).toHaveBeenCalledWith({
      where: { clientId: 't1', month: PREV },
      data: { lineRows: 0, combosSourceImportId: 'imp9', combosAppliedAt: new Date('2026-01-01T00:00:00Z') },
    });
    expect(retention.purgeOldHistory).toHaveBeenCalledTimes(3); // 7 rows, 3 per pass
    // the new windows are passed EXPLICITLY (the sweeps' own defaults stay the old ones while the switch is off)
    expect(retention.purgeOldHistory).toHaveBeenCalledWith({ clientId: undefined, historyCutoff: shiftMonthKey(CUR, -3) });
    expect(retention.sweep).toHaveBeenCalledWith({ clientId: undefined, limit: 50, history: false, retentionDays: 7 });
    expect(r).toMatchObject({ unmatchedDeleted: 5, beyondWindowPasses: 3, importsPurged: 3 });
    expect(r.monthsRebuilt).toEqual([{ clientId: 't1', month: PREV, lineRows: 0, productListRows: 5 }]);
    expect(r.after).toMatchObject({ unmatchedHistory: [], expiredImports: 0, pendingFileDeletes: 0 });
    expect(lines.join('\n')).toMatch(/deleted 5 history rows of customers not on the current roster; back-filled 0 outlet ids; product list rebuilt/);
  }));

  it('S2: --apply REFUSES (nothing touched) while a month in the window has no day data but its last-applied file still exists; --allow-no-day-data proceeds', async () => {
    const missing = [{ clientId: 't1', month: PREV, sourceImportId: 'imp9' }];
    const { db, retention } = trimDb({ rows: NOT_ON_ROSTER(), beyond: 2, expired: 2, pending: 0, missingDayData: missing });
    const before = await countTrim(db as never, { database: 'gifsy_staging' });
    expect(before.missingDayData).toEqual(missing);
    expect(formatCounts(before).join('\n')).toMatch(new RegExp(`months with NO day data[^\\n]*: 1[\\s\\S]*t1 ${PREV}: import imp9`));
    await expect(applyTrim({ db: db as never, retention, log: () => undefined }, before))
      .rejects.toThrow(new RegExp(`t1 ${PREV} \\(import imp9\\)[\\s\\S]*rebuild-days[\\s\\S]*--allow-no-day-data`));
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(retention.purgeOldHistory).not.toHaveBeenCalled();
    expect(retention.sweep).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(5);
    // the query: in-window history sets with no day set whose import's files are not purged
    const q = db.$queryRaw.mock.calls.map((x) => x[0] as Prisma.Sql).find((x) => sqlText(x).includes('LEFT JOIN "sales_day_sets"'))!;
    expect(sqlText(q)).toMatch(/d\."id" IS NULL AND i\."purgedAt" IS NULL AND i\."filesPurgedAt" IS NULL/);
    // the explicit override
    const lines: string[] = [];
    const r = await applyTrim({ db: db as never, retention, log: (l) => lines.push(l) }, before, { allowNoDayData: true });
    expect(r.importsPurged).toBe(2);
    expect(lines[0]).toMatch(/--allow-no-day-data: proceeding/);
  });

  it('a step that makes no progress STOPS the run loudly (never a silent partial)', async () => {
    const { db, retention } = trimDb({ beyond: 4, expired: 0, pending: 0 });
    retention.purgeOldHistory.mockResolvedValue(0); // e.g. statement timeouts
    const before = await countTrim(db as never, { database: 'gifsy_staging' });
    await expect(applyTrim({ db: db as never, retention, log: () => undefined }, before)).rejects.toThrow(/made no progress \(4 rows left\)/);
    const stuck = trimDb({ beyond: 0, expired: 2, pending: 0 });
    stuck.retention.sweep.mockResolvedValue({ abandoned: 0, purged: 0 });
    const b2 = await countTrim(stuck.db as never, { database: 'gifsy_staging' });
    await expect(applyTrim({ db: stuck.db as never, retention: stuck.retention, log: () => undefined }, b2)).rejects.toThrow(/purging imports made no progress/);
  });

  it('CLI arguments: dry-run unless --apply; rebuild-days needs --client and --month', () => {
    expect(parseArgs(['trim'])).toEqual({ command: 'trim', apply: false });
    expect(parseArgs(['trim', '--client', 'bajaj', '--apply'])).toEqual({ command: 'trim', apply: true, clientId: 'bajaj' });
    expect(parseArgs(['trim', '--apply', '--allow-no-day-data'])).toEqual({ command: 'trim', apply: true, allowNoDayData: true });
    expect(() => parseArgs(['rebuild-days', '--client', 'b', '--month', '2026-11', '--allow-no-day-data'])).toThrow(/Unknown argument/);
    expect(parseArgs(['rebuild-days', '--client', 'bajaj', '--month', '2026-11'])).toEqual({ command: 'rebuild-days', apply: false, clientId: 'bajaj', month: '2026-11' });
    expect(() => parseArgs(['rebuild-days', '--month', '2026-11'])).toThrow(/--client/);
    expect(() => parseArgs(['rebuild-days', '--client', 'b', '--month', '2026-13'])).toThrow(/--month/);
    expect(() => parseArgs(['nuke'])).toThrow(/Usage/);
    expect(() => parseArgs(['trim', '--force'])).toThrow(/Unknown argument/);
  });
});

// ─── rebuild-days ────────────────────────────────────────────────────────────────────────────────────────────────

const DEFS: KpiDefLite[] = [
  { kpiCode: 'AMT', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [] },
  { kpiCode: 'LINES', measure: 'PRODUCT_COUNT', filter: {}, outletTypes: [], programs: [] },
];
const DIMS_A = { b: 'A' };
const DIMS_B = { b: 'B' };
const HIST = [
  { id: 1n, customerCode: 'O1', dims: DIMS_A, dimKey: stableStringify(DIMS_A), amountPaise: 0n, qtyPico: 0n, lines: 2 },
  { id: 2n, customerCode: 'O1', dims: DIMS_B, dimKey: stableStringify(DIMS_B), amountPaise: 5000n, qtyPico: 0n, lines: 1 },
];
/** What re-reading the stored file gives (per code × product: totals + day split). */
const FILE = new Map<string, { amountPaise: bigint; qtyPico: bigint; lines: number; days: Array<{ day: number; amountPaise: bigint; qtyPico: bigint; lines: number }> }>([
  [`O1|${stableStringify(DIMS_A)}`, { amountPaise: 0n, qtyPico: 0n, lines: 2, days: [{ day: 4, amountPaise: 1000n, qtyPico: 0n, lines: 1 }, { day: 12, amountPaise: -1000n, qtyPico: 0n, lines: 1 }] }],
  [`O1|${stableStringify(DIMS_B)}`, { amountPaise: 5000n, qtyPico: 0n, lines: 1, days: [{ day: 9, amountPaise: 5000n, qtyPico: 0n, lines: 1 }] }],
]);

function rebuildDb(over: { imp?: Record<string, unknown>; existing?: Array<Record<string, unknown>>; headerAfter?: Record<string, unknown> } = {}) {
  const header = { sourceImportId: 'imp0', appliedAt: new Date('2026-01-01T00:00:00Z') };
  const log: string[] = [];
  let headerReads = 0;
  const db = {
    log,
    salesMonthHistorySet: {
      findUnique: jest.fn(async () => (headerReads++ > 0 && over.headerAfter ? over.headerAfter : header)),
    },
    salesImport: {
      findFirst: jest.fn(async () => ({
        id: 'imp0', gcsPrefix: 'sales-imports/t1/imp0/', sizeBytes: 10n, fileKind: 'CSV', purgedAt: null, filesPurgedAt: null,
        mappingSnapshot: { dimensions: [{ key: 'b' }] }, monthSummaries: [{ month: PREV, lastDate: `${PREV}-28` }], ...over.imp,
      })),
    },
    outlet: { findMany: jest.fn(async () => [{ id: 'id-O1', outletCode: 'O1', name: 'One', programName: null, programCategory: null, outletType: { code: 'RETAIL' } }]) },
    salesMonthHistory: {
      findMany: jest.fn(async () => HIST),
      count: jest.fn(async () => 0),
    },
    outletTarget: { findMany: jest.fn(async () => []) },
    kpiDef: { findMany: jest.fn(async () => []) },
    outletSalesRecord: { findMany: jest.fn(async () => over.existing ?? [{ outletCode: 'O1', kpiValues: { AMT: 50, LINES: 1, MANUAL: 3 } }]) },
    $executeRaw: jest.fn(async (q: Prisma.Sql) => {
      const t = sqlText(q);
      log.push(t.includes('pg_advisory_xact_lock') ? 'lock' : t.includes('UPDATE "sales_month_histories"') ? 'history.days' : t.includes('DELETE FROM "outlet_sales_days"') ? 'days.delete' : t.includes('INSERT INTO "outlet_sales_days"') ? 'days.insert' : t);
      return 1;
    }),
    salesDaySet: {
      upsert: jest.fn(async () => { log.push('dayset.upsert'); return {}; }),
      deleteMany: jest.fn(async () => { log.push('dayset.delete'); return { count: 0 }; }),
    },
    auditLog: { create: jest.fn(async () => { log.push('audit'); return {}; }) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  const parse = jest.fn(async () => ({
    ok: true as const,
    result: {
      get: (_m: string, code: string, dimKey: string) => {
        const f = FILE.get(`${code}|${dimKey}`);
        return f ? { amountPaise: f.amountPaise, qtyPico: f.qtyPico, lines: f.lines } : undefined;
      },
      getDays: (_m: string, code: string, dimKey: string) => FILE.get(`${code}|${dimKey}`)?.days,
    },
  }));
  const deps: RebuildDeps = {
    db: db as never,
    kpiDefs: { enabled: async () => ({ defs: DEFS }) },
    parse: parse as never,
    log: { log: () => undefined, warn: () => undefined, error: () => undefined },
  };
  return { db, deps, parse };
}

describe('one-off rebuild-days (November backfill from our own stored file)', () => {
  it('DRY-RUN: verifies the file reproduces every stored line and the stored figures, reports what it would write, writes nothing', async () => {
    const { db, deps } = rebuildDb();
    const r = await rebuildMonthDays(deps, { clientId: 't1', month: PREV, apply: false });
    expect(r).toEqual(expect.objectContaining({
      ok: true, applied: false, sourceImportId: 'imp0', historyLines: 2, historyLinesWithDays: 0, dayRows: 3, outlets: 1, lastDay: 28,
    }));
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('--apply: fills the history lines\' day split and writes the cumulative day rows + set, in ONE locked transaction; audited', async () => {
    const { db, deps } = rebuildDb();
    const r = await rebuildMonthDays(deps, { clientId: 't1', month: PREV, apply: true });
    expect(r).toEqual(expect.objectContaining({ ok: true, applied: true, dayRows: 3, outlets: 1, lastDay: 28 }));
    expect(db.log).toEqual(['lock', 'history.days', 'days.delete', 'days.insert', 'dayset.upsert', 'audit']);
    const upd = db.$executeRaw.mock.calls.map((c) => c[0] as Prisma.Sql).find((q) => sqlText(q).includes('UPDATE "sales_month_histories"'))!;
    expect(upd.values).toContainEqual(['1', '2']);
    expect(upd.values).toContainEqual([JSON.stringify([[4, '1000', '0', 1], [12, '-1000', '0', 1]]), JSON.stringify([[9, '5000', '0', 1]])]);
    const ins = db.$executeRaw.mock.calls.map((c) => c[0] as Prisma.Sql).find((q) => sqlText(q).includes('INSERT INTO "outlet_sales_days"'))!;
    // A bought day 4, B day 9, A fully returned day 12 → AMT 10, 60, 50; LINES 1, 2, 1 (= the stored monthly 50 / 1)
    expect(ins.values).toContainEqual([4, 9, 12]);
    expect(ins.values).toContainEqual([
      JSON.stringify({ AMT: 10, LINES: 1 }), JSON.stringify({ AMT: 60, LINES: 2 }), JSON.stringify({ AMT: 50, LINES: 1 }),
    ]);
  });

  it('refuses — and says why — when the stored file is gone, does not reproduce the lines, or the figures moved; nothing written', async () => {
    const purged = rebuildDb({ imp: { purgedAt: new Date(), filesPurgedAt: new Date() } });
    const a = await rebuildMonthDays(purged.deps, { clientId: 't1', month: PREV, apply: true });
    expect(a).toEqual(expect.objectContaining({ ok: false, applied: false, problem: expect.stringMatching(/deleted after the retention period/) }));
    expect(purged.parse).not.toHaveBeenCalled();

    const drift = rebuildDb();
    FILE.set(`O1|${stableStringify(DIMS_B)}`, { amountPaise: 5001n, qtyPico: 0n, lines: 1, days: [{ day: 9, amountPaise: 5001n, qtyPico: 0n, lines: 1 }] });
    try {
      const b = await rebuildMonthDays(drift.deps, { clientId: 't1', month: PREV, apply: true });
      expect(b).toEqual(expect.objectContaining({ ok: false, lineMismatches: 1, problem: expect.stringMatching(/does not reproduce 1 of the 2 stored lines/) }));
    } finally {
      FILE.set(`O1|${stableStringify(DIMS_B)}`, { amountPaise: 5000n, qtyPico: 0n, lines: 1, days: [{ day: 9, amountPaise: 5000n, qtyPico: 0n, lines: 1 }] });
    }

    const moved = rebuildDb({ existing: [{ outletCode: 'O1', kpiValues: { AMT: 49, LINES: 1 } }] });
    const c = await rebuildMonthDays(moved.deps, { clientId: 't1', month: PREV, apply: true });
    expect(c).toEqual(expect.objectContaining({ ok: false, figureMismatches: 1, figureMismatchSamples: ['O1 AMT: stored 49 vs now 50'] }));

    const old = rebuildDb();
    const d = await rebuildMonthDays(old.deps, { clientId: 't1', month: OLD, apply: true });
    expect(d.problem).toMatch(/Day-by-day figures are kept only for the current month/);
    for (const x of [purged, drift, moved, old]) expect(x.db.$transaction).not.toHaveBeenCalled();
  });

  it('--apply re-checks the month under the lock: applied / recalculated meanwhile → refused, rolled back', async () => {
    const { deps } = rebuildDb({ headerAfter: { sourceImportId: 'imp1', appliedAt: new Date() } });
    await expect(rebuildMonthDays(deps, { clientId: 't1', month: PREV, apply: true })).rejects.toThrow(/applied or recalculated while the rebuild ran/);
  });

  it('S6: under the lock it re-checks the definitions hash and the monthly figures (a recalculate does not move the history set) → refused, nothing written', async () => {
    // definitions changed between the dry part and the locked write
    const d1 = rebuildDb();
    let calls = 0;
    d1.deps.kpiDefs = { enabled: async () => ({ defs: calls++ === 0 ? DEFS : [DEFS[0]] }) };
    await expect(rebuildMonthDays(d1.deps, { clientId: 't1', month: PREV, apply: true })).rejects.toThrow(/KPI definitions changed while the rebuild/);
    expect(d1.db.log).not.toContain('days.insert');
    // a recalculate rewrote the monthly figures meanwhile (same history set, same definitions)
    const d2 = rebuildDb();
    let reads = 0;
    d2.db.outletSalesRecord.findMany.mockImplementation(async () =>
      reads++ === 0 ? [{ outletCode: 'O1', kpiValues: { AMT: 50, LINES: 1 } }] : [{ outletCode: 'O1', kpiValues: { AMT: 51, LINES: 1 } }]);
    await expect(rebuildMonthDays(d2.deps, { clientId: 't1', month: PREV, apply: true })).rejects.toThrow(/monthly figures changed while the rebuild ran \(e\.g\. O1 AMT: stored 51 vs now 50\)/);
    expect(d2.db.log).not.toContain('days.insert');
    expect(d2.db.log).not.toContain('history.days');
  });
});
