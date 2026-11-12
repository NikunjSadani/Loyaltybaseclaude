import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import type { PrismaService } from '../prisma/prisma.service';

/** SalesUploadBatch.status of batches written by a Sales Import apply (mirrors the contract constant). */
export { SALES_IMPORT_BATCH_STATUS } from '../sales-import/sales-import.contract';

/**
 * Sales Import source ownership (plan §1 G4, §7.4).
 *
 * A KPI is IMPORTER-OWNED iff an ENABLED SalesKpiDefinition exists for (clientId, kpiCode). Owned keys are written
 * ONLY by the Sales Import apply; the manual achievement upload skips them and preserves them. A tenant with no
 * definitions (every tenant today, incl. Deoleo) gets `[]` and every caller's existing code path runs unchanged.
 */
export async function importerOwnedKpiCodes(
  prisma: Pick<PrismaService, 'salesKpiDefinition'> | Pick<Prisma.TransactionClient, 'salesKpiDefinition'>,
  clientId: string,
): Promise<string[]> {
  const rows = await (prisma as Pick<PrismaService, 'salesKpiDefinition'>).salesKpiDefinition.findMany({
    where: { clientId, enabled: true },
    select: { kpiCode: true },
  });
  return rows.map((r) => r.kpiCode).sort();
}

/**
 * Take the per-(tenant, month) transaction-scoped advisory lock that serialises EVERY writer of importer-owned
 * values for a month: Sales Import apply, month close / reopen, and the owned-tenant manual batch delete.
 */
export async function lockSalesMonth(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  clientId: string,
  month: string,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sales-month:${clientId}:${month}`}, 0))`);
}

/**
 * Lower-cased, trimmed labels of the template's header row 2 (the KPI column labels), read with `sheetRows: 2` so
 * only the two header rows are parsed. Any read error → empty set (the full parse reports the real error).
 */
export function achievementHeaderLabels(buffer: Buffer | ArrayBuffer): Set<string> {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: 2 });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return new Set();
    const aoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, defval: null });
    const row2 = (aoa[1] ?? []) as (string | number | null)[];
    return new Set(row2.map((c) => String(c ?? '').toLowerCase().trim()).filter((s) => s !== ''));
  } catch {
    return new Set();
  }
}

/**
 * SQL expression: only the OWNED keys of an existing row's kpiValues (`{}` when none). Used by the manual upload's
 * owned-tenant branch so the carry-over of importer values happens ATOMICALLY inside the upsert (no read-then-write
 * window in which a concurrent Sales Import apply could be reverted).
 */
export function ownedSubsetSql(column: Prisma.Sql, owned: readonly string[]): Prisma.Sql {
  return Prisma.sql`COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(${column}) AS e WHERE e.key = ANY(${[...owned]}::text[])), '{}'::jsonb)`;
}

/** The subset of `values` whose keys are in `owned` (used to carry owned keys across a manual rewrite). */
export function pickOwnedKpiValues(values: unknown, owned: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return out;
  const v = values as Record<string, unknown>;
  for (const k of owned) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k];
  return out;
}
