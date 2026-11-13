/**
 * TEST SUPPORT for the lane-C export-kind specs (file name ends in `spec.ts` so the build excludes it; it is not a
 * `.spec.ts`, so jest does not run it on its own).
 *  - renderKind: run a kind into createXlsxStreamWriter and return the .xlsx bytes;
 *  - readBook / expectSameWorkbook: read both files back with SheetJS and compare sheet names, every cell and merges;
 *  - fakeModel: a tiny in-memory Prisma delegate (where / orderBy / take / skip / cursor / groupBy) so paging across
 *    > 2,000 rows and tenant isolation are exercised against real query semantics, not call counts.
 */
import { PassThrough } from 'node:stream';
import * as XLSX from 'xlsx';
import { createXlsxStreamWriter } from '../../../common/xlsx-stream';
import { aoaToSheetSafe } from '../../../common/xlsx';
import type { MonthBlockSheetLayout } from '../../../targets/targets.helpers';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import type { AnyExportKind, ExportRunContext } from '../../export-kinds';

export async function collectXlsx(build: (w: ReturnType<typeof createXlsxStreamWriter>) => Promise<void>): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => sink.on('end', () => r()));
  const w = createXlsxStreamWriter(sink);
  await build(w);
  await w.finish();
  await done;
  return Buffer.concat(chunks);
}

export async function renderKind(
  def: AnyExportKind,
  ctx: ExportRunContext,
  params: unknown,
): Promise<{ buffer: Buffer; rowCount: number }> {
  let rowCount = 0;
  const buffer = await collectXlsx(async (w) => {
    rowCount = (await def.run(ctx, params, w)).rowCount;
  });
  return { buffer, rowCount };
}

export interface ReadSheet {
  aoa: unknown[][];
  merges: XLSX.Range[];
}

export function readBook(buf: Buffer): { names: string[]; sheets: Record<string, ReadSheet> } {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheets: Record<string, ReadSheet> = {};
  for (const n of wb.SheetNames) {
    const ws = wb.Sheets[n];
    const aoa = (XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: true }) as unknown[][]).map(
      // An empty-string cell and an absent cell look the same in Excel; normalise both to null so the comparison is
      // about what a person sees, then drop trailing nulls (row width differs only by trailing blanks).
      (r) => {
        const row = r.map((c) => (c === '' ? null : c));
        while (row.length && row[row.length - 1] === null) row.pop();
        return row;
      },
    );
    while (aoa.length && aoa[aoa.length - 1].length === 0) aoa.pop();
    const merges = [...((ws['!merges'] as XLSX.Range[] | undefined) ?? [])].sort((a, b) => a.s.r - b.s.r || a.s.c - b.s.c);
    sheets[n] = { aoa, merges };
  }
  return { names: wb.SheetNames, sheets };
}

/** Same sheet names (in order), same cells (value AND type: number vs string), same merges. */
export function expectSameWorkbook(actual: Buffer, expected: Buffer): void {
  const a = readBook(actual);
  const e = readBook(expected);
  expect(a.names).toEqual(e.names);
  for (const n of e.names) {
    expect({ sheet: n, ...a.sheets[n] }).toEqual({ sheet: n, ...e.sheets[n] });
  }
}

export function ctxFor(user: JwtPayload, prisma: unknown, services: Array<[unknown, unknown]> = [], now = new Date()): ExportRunContext {
  const map = new Map(services);
  return {
    prisma: prisma as ExportRunContext['prisma'],
    moduleRef: {
      get: (token: unknown) => {
        if (!map.has(token)) throw new Error(`test moduleRef: no provider for ${String((token as { name?: string })?.name)}`);
        return map.get(token);
      },
    } as unknown as ExportRunContext['moduleRef'],
    clientId: user.clientId,
    user,
    now,
  };
}

/**
 * Render a targets.helpers month-block layout the way the OLD in-memory builders did (aoaToSheetSafe + `!cols` +
 * `!merges` + XLSX.write) — synchronous, so layout-level unit tests keep their shape; the streamed output is compared
 * with the old builders cell-for-cell in targets.kinds.spec.ts.
 */
export function renderLayoutSync<R>(layout: MonthBlockSheetLayout<R>, records: R[]): Buffer {
  const ws = aoaToSheetSafe([layout.monthRow, layout.headerRow, ...records.map((r) => layout.row(r))]);
  ws['!cols'] = layout.widths.map((wch) => ({ wch }));
  if (layout.merges.length) ws['!merges'] = layout.merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, layout.sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── In-memory Prisma delegate ──────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function cmpVal(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0; // byte order, like a "C" collation
}

function matchField(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond !== 'object') return v === cond;
  const c = cond as Record<string, unknown>;
  if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
  if ('not' in c) {
    if (c.not === null) {
      if (v === null || v === undefined) return false;
    } else if (v === c.not) return false;
  }
  if ('gte' in c && (v == null || cmpVal(v, c.gte) < 0)) return false;
  if ('gt' in c && (v == null || cmpVal(v, c.gt) <= 0)) return false;
  if ('lte' in c && (v == null || cmpVal(v, c.lte) > 0)) return false;
  if ('lt' in c && (v == null || cmpVal(v, c.lt) >= 0)) return false;
  return true;
}

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (!matchField(row[k], cond)) return false;
  }
  return true;
}

type OrderSpec = Record<string, 'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls?: 'first' | 'last' }>;

function sorter(orderBy?: OrderSpec | OrderSpec[]) {
  const specs = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return (a: Row, b: Row) => {
    for (const s of specs) {
      const [k, raw] = Object.entries(s)[0];
      const dir = typeof raw === 'string' ? raw : raw.sort;
      // Postgres defaults: ASC → NULLS LAST, DESC → NULLS FIRST.
      const nulls = typeof raw === 'string' ? (dir === 'asc' ? 'last' : 'first') : (raw.nulls ?? (dir === 'asc' ? 'last' : 'first'));
      const av = a[k];
      const bv = b[k];
      const an = av === null || av === undefined;
      const bn = bv === null || bv === undefined;
      if (an || bn) {
        if (an && bn) continue;
        return (an ? 1 : -1) * (nulls === 'last' ? 1 : -1);
      }
      const c = cmpVal(av, bv);
      if (c !== 0) return dir === 'asc' ? c : -c;
    }
    return 0;
  };
}

export interface FakeModel {
  rows: Row[];
  findMany: jest.Mock;
  findFirst: jest.Mock;
  groupBy: jest.Mock;
  count: jest.Mock;
}

/** Rows are returned whole (select is ignored) — store nested relations already shaped as the code selects them. */
export function fakeModel(rows: Row[]): FakeModel {
  const query = (args: { where?: Row; orderBy?: OrderSpec | OrderSpec[]; take?: number; skip?: number; cursor?: { id: string } } = {}) => {
    let list = rows.filter((r) => matches(r, args.where));
    if (args.orderBy) list = [...list].sort(sorter(args.orderBy));
    let start = 0;
    if (args.cursor) {
      const i = list.findIndex((r) => r.id === args.cursor!.id);
      start = i < 0 ? list.length : i;
    }
    start += args.skip ?? 0;
    return list.slice(start, args.take === undefined ? undefined : start + args.take);
  };
  return {
    rows,
    findMany: jest.fn(async (args?: Parameters<typeof query>[0]) => query(args)),
    findFirst: jest.fn(async (args?: Parameters<typeof query>[0]) => query({ ...args, take: 1 })[0] ?? null),
    count: jest.fn(async (args?: { where?: Row }) => rows.filter((r) => matches(r, args?.where)).length),
    groupBy: jest.fn(async (args: { by: string[]; where?: Row }) => {
      const seen = new Map<string, Row>();
      for (const r of rows.filter((x) => matches(x, args.where))) {
        const key = JSON.stringify(args.by.map((b) => r[b]));
        if (!seen.has(key)) seen.set(key, Object.fromEntries(args.by.map((b) => [b, r[b]])));
      }
      return [...seen.values()];
    }),
  };
}

/** Largest number of rows any single findMany call returned (paging assertions). */
export async function maxPage(m: FakeModel): Promise<number> {
  const lens = await Promise.all(m.findMany.mock.results.map(async (r) => ((await r.value) as unknown[]).length));
  return Math.max(0, ...lens);
}
