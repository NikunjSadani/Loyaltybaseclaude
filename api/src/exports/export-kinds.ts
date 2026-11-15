/**
 * Export kinds — the plug-in shape every heavy report implements ONCE (Downloads page design,
 * platform/docs/plans/DOWNLOADS-PAGE.md). Lane A (engine) runs kinds; lanes B/C (reports) write kinds.
 *
 * Rules for a kind's `run`:
 *  - read the database in pages (≤ 2,000 rows, keyset) and write each page to `out` before reading the next —
 *    NEVER load every row first;
 *  - output (sheet names, headers, column order, values, formats) must be IDENTICAL to today's download;
 *  - scope every query to `ctx.clientId` (and to the user exactly as today's endpoint does);
 *  - no HTTP objects: the same `run` executes inside the API (instant stream) and inside the worker job.
 */
import type { ModuleRef } from '@nestjs/core';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import type { PrismaService } from '../prisma/prisma.service';
import type { XlsxStreamWriter } from '../common/xlsx-stream';

export interface ExportRunContext {
  prisma: PrismaService;
  /** Resolve any Nest provider the report needs (StorageService, TenantSettingsService, …): ctx.moduleRef.get(X, { strict: false }). */
  moduleRef: ModuleRef;
  /** The tenant the request was made in (the assumed tenant for a Gifsy operator). */
  clientId: string;
  /** The requester as they were when the request was made (role, permissions, assumed tenant). */
  user: JwtPayload;
  /** Request time — use it instead of `new Date()` so the file reflects when it was asked for. */
  now: Date;
}

export interface ExportAccess {
  /** Same roles as today's endpoint's @Roles. */
  roles: readonly string[];
  /** Same RBAC permission as today's endpoint's @RequirePermission, if any. */
  permission?: string;
}

export interface ExportKindDef<P = Record<string, unknown>> {
  /** Stable id stored on ExportRequest.kind, e.g. 'outlet-master'. */
  kind: string;
  /** Report name for people, e.g. 'Outlet master'. */
  label: string;
  /** Checked when the request is made AND when the file is downloaded. */
  access: ExportAccess;
  /** Validate + normalise raw params (query or body). Throw BadRequestException with a plain message. Pure. */
  parseParams(raw: unknown, user: JwtPayload): P;
  /** true → must go through the Downloads page (202); false → may stream instantly. */
  isHeavy(params: P): boolean;
  /** Plain-English filter summary for the Downloads page. */
  describeParams(params: P): string;
  /** e.g. `outlet-master-2026-11-13.xlsx`. */
  fileName(params: P, now: Date): string;
  /** Write the workbook to `out` (paged reads). Returns the number of data rows written (all sheets). */
  run(ctx: ExportRunContext, params: P, out: XlsxStreamWriter): Promise<{ rowCount: number }>;
}

// ─── Registry ────────────────────────────────────────────────────────────────────────────────────────────────
// Each report lane owns ONE list file (kinds/batch1.ts — lane B, kinds/batch2.ts — lane C); kinds/index.ts
// concatenates them. Duplicate `kind` ids throw at start-up.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyExportKind = ExportKindDef<any>;

export function buildExportKindRegistry(lists: ReadonlyArray<readonly AnyExportKind[]>): ReadonlyMap<string, AnyExportKind> {
  const map = new Map<string, AnyExportKind>();
  for (const list of lists) {
    for (const def of list) {
      if (map.has(def.kind)) throw new Error(`Duplicate export kind "${def.kind}"`);
      map.set(def.kind, def);
    }
  }
  return map;
}
