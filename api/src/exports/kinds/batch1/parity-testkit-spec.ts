/**
 * Test kit for the batch-1 export-kind specs (not a spec itself; `*spec.ts` keeps it out of the build, and jest only
 * runs `*.spec.ts`). Runs a kind into the real streaming writer and reads workbooks back with SheetJS so a spec can
 * assert the new file is cell-for-cell the old builder's file.
 */
import { PassThrough } from 'node:stream';
import type { ModuleRef } from '@nestjs/core';
import * as XLSX from 'xlsx';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { createXlsxStreamWriter } from '../../../common/xlsx-stream';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AnyExportKind, ExportRunContext } from '../../export-kinds';

/** A ModuleRef stand-in: `get(Token)` → the instance registered for that class. */
export function fakeModuleRef(entries: Array<[unknown, unknown]>): ModuleRef {
  const map = new Map(entries);
  return {
    get: (token: unknown) => {
      if (!map.has(token)) throw new Error(`fakeModuleRef: no provider for ${String((token as { name?: string })?.name ?? token)}`);
      return map.get(token);
    },
  } as unknown as ModuleRef;
}

/** Run a kind exactly as the engine does (parseParams → run → finish) and return the file bytes. */
export async function runKindToBuffer(
  def: AnyExportKind,
  rawParams: unknown,
  ctx: { prisma: unknown; moduleRef: ModuleRef; user: JwtPayload; clientId?: string; now?: Date },
): Promise<{ buffer: Buffer; rowCount: number; fileName: string; heavy: boolean }> {
  const params = def.parseParams(rawParams, ctx.user);
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    sink.on('end', () => resolve());
    sink.on('error', reject);
  });
  const out = createXlsxStreamWriter(sink);
  const now = ctx.now ?? new Date('2026-11-13T06:00:00Z');
  const runCtx: ExportRunContext = {
    prisma: ctx.prisma as PrismaService,
    moduleRef: ctx.moduleRef,
    clientId: ctx.clientId ?? ctx.user.clientId,
    user: ctx.user,
    now,
  };
  const { rowCount } = await def.run(runCtx, params, out);
  await out.finish();
  await done;
  return { buffer: Buffer.concat(chunks), rowCount, fileName: def.fileName(params, now), heavy: def.isHeavy(params) };
}

export interface ReadBack {
  names: string[];
  /** Per sheet: rows as arrays (raw values — a '12' string and a 12 number differ), blanks as ''. */
  rows: Record<string, unknown[][]>;
  /** Per sheet: cell address → hyperlink target. */
  links: Record<string, Record<string, string>>;
}

export function readBack(buf: Buffer): ReadBack {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows: ReadBack['rows'] = {};
  const links: ReadBack['links'] = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    rows[name] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true }) as unknown[][];
    const l: Record<string, string> = {};
    for (const [addr, cell] of Object.entries(ws)) {
      if (addr.startsWith('!')) continue;
      const target = (cell as XLSX.CellObject).l?.Target;
      if (target) l[addr] = target;
    }
    links[name] = l;
  }
  return { names: wb.SheetNames, rows, links };
}

/** Assert two workbooks are equal: sheet names, every row/cell (header included), every hyperlink target. */
export function expectSameWorkbook(actual: Buffer, expected: Buffer): ReadBack {
  const a = readBack(actual);
  const e = readBack(expected);
  expect(a.names).toEqual(e.names);
  for (const name of e.names) {
    expect(a.rows[name].length).toBe(e.rows[name].length);
    // Row by row so a failure names the first differing row instead of dumping thousands.
    for (let r = 0; r < e.rows[name].length; r++) {
      if (JSON.stringify(a.rows[name][r]) !== JSON.stringify(e.rows[name][r])) {
        expect({ sheet: name, row: r, cells: a.rows[name][r] }).toEqual({ sheet: name, row: r, cells: e.rows[name][r] });
      }
    }
    expect(a.links[name]).toEqual(e.links[name]);
  }
  return a;
}

/** Deterministic pseudo-random generator for fixtures (no Math.random in tests). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
