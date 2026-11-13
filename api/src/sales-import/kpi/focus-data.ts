/**
 * FOCUS-FROM-TARGETS (platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md) — the DB loaders the month reconciliation
 * needs (lane B2). Every reader is keyed by clientId (tenant isolation). The pure logic lives in focus-products.ts.
 *
 *  - loadMonthTargets: the month's OutletTarget rows mapped onto the CURRENT roster (same normalized index as the
 *    aggregates) + the latest target upload time for the month.
 *  - latestTargetUploadByMonth: the same "latest target upload" for many months in two grouped queries (months list).
 *  - loadFocusCatalogue: the profile's dimension keys (in profile order) over the DISTINCT product combos of every stored
 *    month (sales_month_history_combos) plus, for an import, the import's own aggregates — SQL GROUP BY, never Prisma
 *    `distinct` (which loads every row into Node).
 *  - loadFocusAcceptances: the month's "accepted — not sold yet" tokens with the acceptor's name.
 */
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SalesColumnMapping } from '../sales-import.contract';
import { normalizeOutletCode } from '../ingest/normalize';
import { buildFocusCatalogue, type FocusAcceptanceInfo, type FocusCatalogue, type MonthTargetRow } from './focus-products';
import { rosterIndexOf, type RosterOutlet } from './sales-import-data';
import type { KpiDefLite } from './sales-kpi.helper';

type Db = PrismaService | Prisma.TransactionClient;

/** Reserved key of OutletTarget.targetValues holding the per-outlet names (targets.helpers NAMES_KEY). */
const NAMES_KEY = '__names';

/** At least one enabled definition takes its products from the target file. */
export function hasTargetNamesDef(defs: readonly Pick<KpiDefLite, 'productSource'>[]): boolean {
  return defs.some((d) => d.productSource === 'TARGET_NAMES');
}

function numeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** One OutletTarget.targetValues JSON → numeric KPI cells (excluding `__names`) + the names as strings. */
export function targetRowOf(targetValues: unknown): MonthTargetRow {
  const values: Record<string, number> = {};
  const names: Record<string, string> = {};
  if (!targetValues || typeof targetValues !== 'object' || Array.isArray(targetValues)) return { values, names };
  for (const [k, v] of Object.entries(targetValues as Record<string, unknown>)) {
    if (k === NAMES_KEY) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [code, name] of Object.entries(v as Record<string, unknown>)) {
          const s = typeof name === 'string' ? name.trim() : typeof name === 'number' && Number.isFinite(name) ? String(name) : '';
          if (s !== '') names[code] = s;
        }
      }
      continue;
    }
    const n = numeric(v);
    if (n !== null) values[k] = n;
  }
  return { values, names };
}

/**
 * Raw target rows (outlet code as stored on the target) → ROSTER outlet code → row, through the normalized roster
 * index (the aggregates are mapped the same way). Rows of outlets not on the current roster are dropped. When two
 * target codes normalize to the same roster outlet, the first in ascending code order wins (deterministic).
 */
export function mapTargetsOntoRoster(
  rows: ReadonlyArray<{ outletCode: string; targetValues: unknown }>,
  roster: Map<string, RosterOutlet>,
): Map<string, MonthTargetRow> {
  const index = rosterIndexOf(roster);
  const out = new Map<string, MonthTargetRow>();
  for (const r of [...rows].sort((a, b) => (a.outletCode < b.outletCode ? -1 : a.outletCode > b.outletCode ? 1 : 0))) {
    const code = index.get(normalizeOutletCode(r.outletCode));
    if (code === undefined || out.has(code)) continue;
    out.set(code, targetRowOf(r.targetValues));
  }
  return out;
}

export interface MonthTargetsLoad {
  /** ROSTER outlet code → the month's target row. */
  targets: Map<string, MonthTargetRow>;
  /** Latest target upload batch that wrote a row of this month (null = no targets for the month). */
  uploadedAt: Date | null;
}

/**
 * The month's targets. "Latest upload" = the newest TargetUploadBatch referenced by the month's OutletTarget rows (a
 * multi-month upload's batch row is labelled with its EARLIEST month only, so the batch's own `month` is not enough).
 */
export async function loadMonthTargets(
  db: Db,
  clientId: string,
  month: string,
  roster: Map<string, RosterOutlet>,
): Promise<MonthTargetsLoad> {
  const rows = await db.outletTarget.findMany({
    where: { clientId, month },
    select: { outletCode: true, targetValues: true, batchId: true },
  });
  const batchIds = [...new Set(rows.map((r) => r.batchId))];
  let uploadedAt: Date | null = null;
  if (batchIds.length > 0) {
    const agg = await db.targetUploadBatch.aggregate({ where: { clientId, id: { in: batchIds } }, _max: { createdAt: true } });
    uploadedAt = agg._max.createdAt ?? null;
  }
  return { targets: mapTargetsOntoRoster(rows, roster), uploadedAt };
}

/** month → latest target upload (see loadMonthTargets) for many months: one GROUP BY + one batch read. */
export async function latestTargetUploadByMonth(
  db: Pick<Prisma.TransactionClient, 'outletTarget' | 'targetUploadBatch'>,
  clientId: string,
  months: readonly string[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (months.length === 0) return out;
  const pairs = await db.outletTarget.groupBy({ by: ['month', 'batchId'], where: { clientId, month: { in: [...months] } } });
  const ids = [...new Set(pairs.map((p) => p.batchId))];
  if (ids.length === 0) return out;
  const batches = await db.targetUploadBatch.findMany({ where: { clientId, id: { in: ids } }, select: { id: true, createdAt: true } });
  const at = new Map(batches.map((b) => [b.id, b.createdAt]));
  for (const p of pairs) {
    const t = at.get(p.batchId);
    if (!t) continue;
    const cur = out.get(p.month);
    if (!cur || t > cur) out.set(p.month, t);
  }
  return out;
}

/** "Targets changed since the last apply": the month was applied and a target upload is newer than that apply. */
export function targetsNewerThanApply(targetUploadedAt: Date | null | undefined, lastAppliedAt: Date | null | undefined): boolean {
  return !!targetUploadedAt && !!lastAppliedAt && targetUploadedAt.getTime() > lastAppliedAt.getTime();
}

function parseDims(text: unknown): Record<string, string> | null {
  try {
    const v: unknown = typeof text === 'string' ? JSON.parse(text) : text;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = x === null || x === undefined ? '' : String(x);
    return out;
  } catch {
    return null;
  }
}

/** The profile's dimension keys in profile order ([] without a profile). */
export async function profileDimensionKeys(db: Db, clientId: string): Promise<string[]> {
  const p = await db.salesImportProfile.findUnique({ where: { clientId }, select: { columnMapping: true } });
  const m = (p?.columnMapping ?? null) as SalesColumnMapping | null;
  return Array.isArray(m?.dimensions) ? m.dimensions.map((d) => d.key) : [];
}

/**
 * design §3 catalogue: every stored month's distinct product combos (ALL months of the tenant) + for an import preview /
 * apply, the import's distinct aggregate combos. dimKey is the stable 1:1 key of dims, so GROUP BY dimKey = distinct.
 */
export async function loadFocusCatalogue(db: Db, clientId: string, opts: { importId?: string } = {}): Promise<FocusCatalogue> {
  const dimensionKeys = await profileDimensionKeys(db, clientId);
  const history = await db.$queryRaw<Array<{ dims: unknown }>>(Prisma.sql`
    SELECT MIN("dims"::text) AS "dims" FROM "sales_month_history_combos" WHERE "clientId" = ${clientId} GROUP BY "dimKey"`);
  const fromImport = opts.importId
    ? await db.$queryRaw<Array<{ dims: unknown }>>(Prisma.sql`
        SELECT MIN(a."dims"::text) AS "dims" FROM "sales_import_aggregates" a
          JOIN "sales_imports" i ON i."id" = a."importId" AND i."clientId" = ${clientId}
         WHERE a."importId" = ${opts.importId} GROUP BY a."dimKey"`)
    : [];
  const combos: Record<string, string>[] = [];
  for (const r of [...history, ...fromImport]) {
    const d = parseDims(r.dims);
    if (d) combos.push(d);
  }
  return buildFocusCatalogue(dimensionKeys, combos);
}

/** `${kpiCode}|${key}` → who accepted it (for MonthFocusInput.acceptances). */
export async function loadFocusAcceptances(db: Db, clientId: string, month: string): Promise<Map<string, FocusAcceptanceInfo>> {
  const list = await listFocusAcceptances(db, clientId, month);
  return new Map(list.map((a) => [`${a.kpiCode}|${a.key}`, { byName: a.byName, at: a.at }]));
}

/** The month's acceptances (sorted by kpiCode, key) with the acceptor's display name. */
export async function listFocusAcceptances(
  db: Db,
  clientId: string,
  month: string,
): Promise<Array<{ kpiCode: string; key: string; byName: string; at: string }>> {
  const rows = await db.salesFocusAcceptance.findMany({
    where: { clientId, month },
    orderBy: [{ kpiCode: 'asc' }, { key: 'asc' }],
    select: { kpiCode: true, key: true, acceptedById: true, acceptedAt: true },
  });
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.acceptedById))];
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    kpiCode: r.kpiCode,
    key: r.key,
    byName: nameOf.get(r.acceptedById) ?? 'Unknown',
    at: r.acceptedAt.toISOString(),
  }));
}

/** kpiCode → KpiDef label for the given codes. */
export async function kpiLabelsOf(db: Db, clientId: string, codes: readonly string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows = await db.kpiDef.findMany({ where: { clientId, code: { in: [...codes] } }, select: { code: true, label: true } });
  return new Map(rows.map((k) => [k.code, k.label]));
}
