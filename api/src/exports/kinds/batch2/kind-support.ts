/**
 * Shared plumbing for the lane-C export kinds (kinds/batch2.ts). Pure helpers — no HTTP objects.
 */
import { BadRequestException, type Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import type { ExportRunContext } from '../../export-kinds';
import type { XlsxCell, XlsxStreamSheet, XlsxStreamWriter } from '../../../common/xlsx-stream';

/** Rows read per database page (export-kinds rule: ≤ 2,000, keyset). */
export const EXPORT_PAGE_SIZE = 2000;

/** Server-set keys merged into every request's params (ExportsService) — never part of a report's own query. */
const SERVER_PARAM_KEYS = ['requestOrigin'];

function flatten(errors: ValidationError[]): string[] {
  const out: string[] = [];
  for (const e of errors) {
    if (e.constraints) out.push(...Object.values(e.constraints));
    if (e.children?.length) out.push(...flatten(e.children));
  }
  return out;
}

/**
 * Validate raw params EXACTLY as the global ValidationPipe validates the report's query today
 * (whitelist + forbidNonWhitelisted + transform + implicit conversion), so a kind's parseParams 400s on the same input
 * the endpoint 400s on, with the same messages. Returns a PLAIN object of the declared fields (JSON-storable).
 */
export function parseQueryDto<T extends object>(dto: Type<T>, raw: unknown): T {
  const src: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!SERVER_PARAM_KEYS.includes(k) && v !== undefined) src[k] = v;
    }
  }
  const inst = plainToInstance(dto, src, { enableImplicitConversion: true });
  const errors = validateSync(inst as object, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length) throw new BadRequestException(flatten(errors));
  const plain: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inst as Record<string, unknown>)) if (v !== undefined) plain[k] = v;
  return plain as T;
}

/** A Nest provider for a kind's run (API: the app's instance; worker: EXPORT_WORKER_FEATURE_MODULES). */
export function serviceOf<T>(ctx: ExportRunContext, cls: Type<T>): T {
  return ctx.moduleRef.get(cls, { strict: false });
}

/**
 * Keyset pages over a Prisma findMany ordered by a deterministic order ending in `id`: each page starts after the
 * previous page's last row (Prisma `cursor` + `skip: 1`). Every order field used with this helper must be NOT NULL.
 */
export async function* keysetPages<T extends { id: string }>(
  fetch: (page: { take: number; cursor?: { id: string }; skip?: number }) => Promise<T[]>,
  size = EXPORT_PAGE_SIZE,
): AsyncGenerator<T[]> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await fetch(cursor ? { take: size, cursor: { id: cursor }, skip: 1 } : { take: size });
    if (rows.length) yield rows;
    if (rows.length < size) return;
    cursor = rows[rows.length - 1].id;
  }
}

/**
 * The streaming twin of `buildXlsx`'s json_to_sheet behaviour for one sheet: the header row is the FIRST row's keys
 * (in order) and every row is written in that column order; a sheet with no rows is written header-less (exactly
 * like json_to_sheet([])). Rows must all carry the same keys (true for every report here).
 */
export class JsonSheet {
  private sheet: XlsxStreamSheet | null = null;
  private keys: string[] = [];

  constructor(
    private readonly out: XlsxStreamWriter,
    private readonly name: string,
  ) {}

  async add(row: Record<string, XlsxCell>): Promise<void> {
    if (!this.sheet) {
      this.keys = Object.keys(row);
      this.sheet = await this.out.addSheet(this.name, this.keys);
    }
    await this.sheet.addRow(this.keys.map((k) => row[k]));
  }

  /** Close the sheet (writes the header-less empty sheet when nothing was added). Returns the data-row count. */
  async end(): Promise<number> {
    if (!this.sheet) {
      await this.out.addSheet(this.name, []);
      return 0;
    }
    return this.sheet.rowCount;
  }
}

/** Number of whole months from `from` to `to` inclusive (YYYY-MM strings). */
export function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return ty * 12 + tm - (fy * 12 + fm) + 1;
}

/** "2026-07" → "Jul 2026" (for Downloads-page summaries). */
export function monthWords(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[m - 1] ? `${names[m - 1]} ${y}` : ym;
}
