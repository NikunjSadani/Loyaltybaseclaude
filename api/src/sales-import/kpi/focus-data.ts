/**
 * FOCUS-FROM-TARGETS (platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md) — the DB loaders the month reconciliation
 * needs (lane B2). Every reader is keyed by clientId (tenant isolation). The pure logic lives in focus-products.ts.
 *
 *  - loadMonthTargets: the month's OutletTarget rows mapped onto the CURRENT roster (same normalized index as the
 *    aggregates) + when the month's target rows were last written (MAX updatedAt).
 *  - latestTargetWriteByMonth: the same "last written" for many months in one GROUP BY (months list).
 *  - loadFocusCatalogue: the profile's dimension keys (in profile order) over the DISTINCT product combos of every stored
 *    month (sales_month_history_combos) plus, for an import, the import's own aggregates — SQL DISTINCT ON, never Prisma
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
  /** When the month's target ROWS were last written (MAX(updatedAt)); null = no targets for the month. */
  uploadedAt: Date | null;
}

/**
 * The month's targets. "Last written" = MAX(outlet_targets."updatedAt") over the month's rows — NOT the upload batch's
 * createdAt: the upload creates the batch row BEFORE its chunks commit, so an apply in between would read only part of
 * the targets yet look newer than the batch (audit follow-up). A multi-month upload is covered too (per-row stamp).
 */
export async function loadMonthTargets(
  db: Db,
  clientId: string,
  month: string,
  roster: Map<string, RosterOutlet>,
): Promise<MonthTargetsLoad> {
  const rows = await db.outletTarget.findMany({
    where: { clientId, month },
    select: { outletCode: true, targetValues: true, updatedAt: true },
  });
  let uploadedAt: Date | null = null;
  for (const r of rows) if (r.updatedAt && (!uploadedAt || r.updatedAt > uploadedAt)) uploadedAt = r.updatedAt;
  return { targets: mapTargetsOntoRoster(rows, roster), uploadedAt };
}

/** month → when the month's target rows were last written (see loadMonthTargets), for many months in ONE GROUP BY. */
export async function latestTargetWriteByMonth(
  db: Pick<Prisma.TransactionClient, 'outletTarget'>,
  clientId: string,
  months: readonly string[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (months.length === 0) return out;
  const groups = await db.outletTarget.groupBy({
    by: ['month'],
    where: { clientId, month: { in: [...months] } },
    _max: { updatedAt: true },
  });
  for (const g of groups) if (g._max?.updatedAt) out.set(g.month, g._max.updatedAt);
  return out;
}

/** Does the tenant have an ENABLED TARGET_NAMES definition (one count query)? */
export async function tenantHasTargetNamesDef(db: Pick<Prisma.TransactionClient, 'salesKpiDefinition'>, clientId: string): Promise<boolean> {
  const n = await db.salesKpiDefinition.count({ where: { clientId, enabled: true, productSource: 'TARGET_NAMES' } });
  return n > 0;
}

/**
 * "Targets changed since the last apply": the month was applied, its target rows were written after that apply, AND the
 * tenant has an enabled TARGET_NAMES definition — without one, targets change no applied figure (B-M1), so never flag.
 */
export function targetsNewerThanApply(
  targetWrittenAt: Date | null | undefined,
  lastAppliedAt: Date | null | undefined,
  focusOn: boolean,
): boolean {
  return focusOn && !!targetWrittenAt && !!lastAppliedAt && targetWrittenAt.getTime() > lastAppliedAt.getTime();
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
 * apply, the import's distinct aggregate combos. dimKey is the stable 1:1 key of dims, so one row per dimKey = distinct.
 * `DISTINCT ON ("dimKey")` keeps one row per key without casting every row's jsonb to text (the old MIN(dims::text)
 * did, for every aggregate of the import); the import read uses the aggregates' (importId, …) index for the WHERE and
 * one sort on dimKey. Never Prisma `distinct` (that loads every row into Node).
 */
/**
 * The stored product lists (every month's history combos) as raw `dims` rows — the part of the catalogue that APPLYING a
 * month changes. A background apply job snapshots it on its first run (SalesApplyJob.focusBasis) so a retried job
 * resolves its remaining months against the SAME lists, not ones its own earlier months rewrote (audit A-M1).
 */
export async function loadHistoryCombos(db: Db, clientId: string): Promise<Array<{ dims: unknown }>> {
  return db.$queryRaw<Array<{ dims: unknown }>>(Prisma.sql`
    SELECT DISTINCT ON ("dimKey") "dims" FROM "sales_month_history_combos" WHERE "clientId" = ${clientId} ORDER BY "dimKey"`);
}

export async function loadFocusCatalogue(
  db: Db,
  clientId: string,
  opts: { importId?: string; history?: Array<{ dims: unknown }> } = {},
): Promise<FocusCatalogue> {
  const dimensionKeys = await profileDimensionKeys(db, clientId);
  const history = opts.history ?? (await loadHistoryCombos(db, clientId));
  const fromImport = opts.importId
    ? await db.$queryRaw<Array<{ dims: unknown }>>(Prisma.sql`
        SELECT DISTINCT ON (a."dimKey") a."dims" FROM "sales_import_aggregates" a
         WHERE a."importId" = ${opts.importId}
           AND EXISTS (SELECT 1 FROM "sales_imports" i WHERE i."id" = ${opts.importId} AND i."clientId" = ${clientId})
         ORDER BY a."dimKey"`)
    : [];
  // Roster-only aggregates (2026-11-23): a roster-only import's aggregates hold only programme outlets' products, so
  // also take the file's frozen product combos (SalesImport.dimensionCombos: every valid line, top
  // SALES_IMPORT_MAX_DIMENSION_COMBOS by |₹|). The catalogue is then the same as when every customer was aggregated
  // whenever the file has ≤ that many distinct combos. A legacy import (processedRosterCodes NULL) is unchanged.
  const frozen = opts.importId ? await frozenImportCombos(db, clientId, opts.importId) : [];
  const combos: Record<string, string>[] = [];
  for (const r of [...history, ...fromImport, ...frozen]) {
    const d = parseDims(r.dims);
    if (d) combos.push(d);
  }
  return buildFocusCatalogue(dimensionKeys, combos);
}

/** A ROSTER-ONLY import's frozen product combos as `dims` rows ([] for a legacy import or none). Tenant-checked. */
export async function frozenImportCombos(db: Db, clientId: string, importId: string): Promise<Array<{ dims: unknown }>> {
  const imp = await db.salesImport.findFirst({
    where: { id: importId, clientId },
    select: { dimensionCombos: true, processedRosterCodes: true },
  });
  if (!imp || imp.processedRosterCodes === null || imp.processedRosterCodes === undefined) return [];
  const list = Array.isArray(imp.dimensionCombos) ? (imp.dimensionCombos as Array<{ dims?: unknown } | null>) : [];
  return list.filter((c) => c && c.dims && typeof c.dims === 'object').map((c) => ({ dims: c!.dims }));
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
