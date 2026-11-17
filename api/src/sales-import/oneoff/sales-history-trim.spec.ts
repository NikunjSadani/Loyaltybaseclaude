import { Prisma } from '@prisma/client';
import { currentMonthKey } from '../../targets/targets.helpers';
import { shiftMonthKey } from '../months/month-state';
import { stableStringify, type KpiDefLite } from '../kpi/sales-kpi.helper';
import { applyTrim, assertDatabase, countTrim, formatCounts } from './sales-history-trim';
import { parseArgs } from './sales-history-trim.main';
import { rebuildMonthDays, type RebuildDeps } from './sales-day-rebuild';

const CUR = currentMonthKey();
const PREV = shiftMonthKey(CUR, -1);
const OLD = shiftMonthKey(CUR, -5); // outside the window (current + 3 previous)
const sqlText = (q: unknown) => (q as Prisma.Sql).strings.join('?');

// ─── trim ────────────────────────────────────────────────────────────────────────────────────────────────────────

function trimDb(state: { unmatched: number; beyond: number; expired: number; pending: number; header?: boolean }) {
  const log: string[] = [];
  const db = {
    log,
    state,
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      const t = sqlText(q);
      if (t.includes('current_database()')) return [{ db: 'gifsy_staging' }];
      if (t.includes('GROUP BY 1, 2')) {
        if (t.includes('"sales_month_histories"') && t.includes('IS NULL')) return state.unmatched > 0 ? [{ clientId: 't1', month: PREV, n: state.unmatched }] : [];
        if (t.includes('"sales_month_histories"')) return state.beyond > 0 ? [{ clientId: 't1', month: OLD, n: state.beyond }] : [];
        return [];
      }
      if (t.includes('count(*)::int AS n FROM "sales_month_histories"')) return [{ n: 40 }];
      throw new Error(`unexpected query ${t}`);
    }),
    $executeRaw: jest.fn(async (q: Prisma.Sql) => {
      const t = sqlText(q);
      if (t.includes('pg_advisory_xact_lock')) { log.push('lock'); return 0; }
      if (t.includes('DELETE FROM "sales_month_histories"')) {
        const limit = q.values[q.values.length - 1] as number;
        const n = Math.min(limit, state.unmatched);
        state.unmatched -= n;
        log.push(`delete-unmatched:${n}`);
        return n;
      }
      if (t.includes('DELETE FROM "sales_month_history_combos"')) { log.push('combos.delete'); return 3; }
      if (t.includes('INSERT INTO "sales_month_history_combos"')) { log.push('combos.insert'); return 5; }
      throw new Error(`unexpected write ${t}`);
    }),
    $executeRawUnsafe: jest.fn(async () => 0),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    salesMonthHistorySet: {
      findUnique: jest.fn(async () => (state.header === false ? null : { sourceImportId: 'imp9', appliedAt: new Date('2026-01-01T00:00:00Z') })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    salesImport: {
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => ('filesPurgedAt' in where ? state.pending : state.expired)),
    },
  };
  const retention = {
    purgeOldHistory: jest.fn(async () => { const n = Math.min(3, state.beyond); state.beyond -= n; return n; }),
    sweep: jest.fn(async () => { const n = Math.min(2, state.expired); state.expired -= n; state.pending = 0; return { abandoned: 0, purged: n }; }),
  };
  return { db, retention };
}

describe('one-off sales-history-trim', () => {
  it('guards on current_database(): must EXACTLY equal TRIM_TARGET_DB (unset or different → refuse)', async () => {
    const { db } = trimDb({ unmatched: 0, beyond: 0, expired: 0, pending: 0 });
    await expect(assertDatabase(db, undefined)).rejects.toThrow(/Set TRIM_TARGET_DB/);
    await expect(assertDatabase(db, 'gifsy_prod')).rejects.toThrow(/Connected to "gifsy_staging" but TRIM_TARGET_DB is "gifsy_prod"/);
    await expect(assertDatabase(db, 'gifsy_staging')).resolves.toBe('gifsy_staging');
  });

  it('DRY-RUN counts per tenant × month and writes NOTHING', async () => {
    const { db, retention } = trimDb({ unmatched: 5, beyond: 7, expired: 3, pending: 1 });
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
    // the unmatched count only looks INSIDE the window (older months go wholesale in step 2)
    const q = db.$queryRaw.mock.calls.map((c) => c[0] as Prisma.Sql).find((x) => sqlText(x).includes('IS NULL'))!;
    expect(sqlText(q)).toContain('h."month" >= ?');
    expect(q.values).toContain(shiftMonthKey(CUR, -3));
  });

  it('--apply: batches the non-programme deletes under the month lock, rebuilds the product list, then drains old months + expired imports via the retention code', async () => {
    const { db, retention } = trimDb({ unmatched: 5, beyond: 7, expired: 3, pending: 0 });
    const before = await countTrim(db as never, { database: 'gifsy_staging' });
    const lines: string[] = [];
    const r = await applyTrim({ db: db as never, retention, log: (l) => lines.push(l) }, before, { batchRows: 2 });
    expect(db.log.filter((l) => l.startsWith('delete-unmatched'))).toEqual(['delete-unmatched:2', 'delete-unmatched:2', 'delete-unmatched:1']);
    // every batch is its own short transaction holding the month lock
    expect(db.log.slice(0, 2)).toEqual(['lock', 'delete-unmatched:2']);
    const del = db.$executeRaw.mock.calls.map((c) => c[0] as Prisma.Sql).find((x) => sqlText(x).includes('DELETE FROM "sales_month_histories"'))!;
    expect(sqlText(del)).toContain('h."outletId" IS NULL');
    expect(sqlText(del)).toContain('LIMIT ?');
    expect(db.log).toEqual(expect.arrayContaining(['combos.delete', 'combos.insert']));
    expect(db.salesMonthHistorySet.updateMany).toHaveBeenCalledWith({
      where: { clientId: 't1', month: PREV },
      data: { lineRows: 40, combosSourceImportId: 'imp9', combosAppliedAt: new Date('2026-01-01T00:00:00Z') },
    });
    expect(retention.purgeOldHistory).toHaveBeenCalledTimes(3); // 7 rows, 3 per pass
    expect(retention.sweep).toHaveBeenCalledWith({ clientId: undefined, limit: 50, history: false });
    expect(r).toMatchObject({ unmatchedDeleted: 5, beyondWindowPasses: 3, importsPurged: 3 });
    expect(r.monthsRebuilt).toEqual([{ clientId: 't1', month: PREV, lineRows: 40, productListRows: 5 }]);
    expect(r.after).toMatchObject({ unmatchedHistory: [], expiredImports: 0, pendingFileDeletes: 0 });
    expect(lines.join('\n')).toMatch(/deleted 5 non-programme history rows; product list rebuilt/);
  });

  it('a step that makes no progress STOPS the run loudly (never a silent partial)', async () => {
    const { db, retention } = trimDb({ unmatched: 0, beyond: 4, expired: 0, pending: 0 });
    retention.purgeOldHistory.mockResolvedValue(0); // e.g. statement timeouts
    const before = await countTrim(db as never, { database: 'gifsy_staging' });
    await expect(applyTrim({ db: db as never, retention, log: () => undefined }, before)).rejects.toThrow(/made no progress \(4 rows left\)/);
    const stuck = trimDb({ unmatched: 0, beyond: 0, expired: 2, pending: 0 });
    stuck.retention.sweep.mockResolvedValue({ abandoned: 0, purged: 0 });
    const b2 = await countTrim(stuck.db as never, { database: 'gifsy_staging' });
    await expect(applyTrim({ db: stuck.db as never, retention: stuck.retention, log: () => undefined }, b2)).rejects.toThrow(/purging imports made no progress/);
  });

  it('CLI arguments: dry-run unless --apply; rebuild-days needs --client and --month', () => {
    expect(parseArgs(['trim'])).toEqual({ command: 'trim', apply: false });
    expect(parseArgs(['trim', '--client', 'bajaj', '--apply'])).toEqual({ command: 'trim', apply: true, clientId: 'bajaj' });
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
    expect(d.problem).toMatch(/kept only for the current month/);
    for (const x of [purged, drift, moved, old]) expect(x.db.$transaction).not.toHaveBeenCalled();
  });

  it('--apply re-checks the month under the lock: applied / recalculated meanwhile → refused, rolled back', async () => {
    const { deps } = rebuildDb({ headerAfter: { sourceImportId: 'imp1', appliedAt: new Date() } });
    await expect(rebuildMonthDays(deps, { clientId: 't1', month: PREV, apply: true })).rejects.toThrow(/applied or recalculated while the rebuild ran/);
  });
});
