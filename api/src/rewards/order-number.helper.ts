/**
 * Tenant-stamped redemption order numbers — `TENANT-YY-######`.
 *
 * Gift Catalogue & Dispatch (Wave 1, decision §5 / review §12). NEW orders get a
 * per-tenant, per-year, monotonic number; existing `RDM-<ts>-<rand>` numbers are
 * untouched and every filter/lookup keys off the exact `orderNumber` string, so
 * both formats coexist during the mixed period.
 *
 * CONCURRENCY: `generateTenantOrderNumber` MUST run inside a `$transaction`. It
 * takes a Postgres advisory *xact* lock keyed on (tenant, year) — released
 * automatically at commit/rollback — so two concurrent redeems for the same
 * tenant+year can never read the same max and mint a duplicate. No dedicated
 * counter table is needed (none was added in Wave 0); the lock serialises the
 * "scan max → +1" so it is collision-free. The scan uses same-width zero-padded
 * suffixes, so lexicographic max == numeric max below 1,000,000 orders / year.
 */

import { Prisma } from '@prisma/client';

/** Zero-pad width of the running sequence (######). */
export const ORDER_SEQ_WIDTH = 6;

/** IST is a fixed UTC+5:30 offset (India observes no DST). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/**
 * Stable, human tenant code for the order-number prefix, derived from the
 * clientId slug (e.g. "deoleo" → "DEOLEO"). Uppercased, non-alphanumerics
 * stripped; empty → "TENANT" (defensive — a real tenant slug is never empty).
 */
export function deriveTenantCode(clientId: string): string {
  const cleaned = (clientId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned || 'TENANT';
}

/**
 * Two-digit IST year (YY) for the order number. IST is authoritative for "which
 * year" so a late-night Dec-31 IST order stamps the Indian wall-clock year, not
 * the UTC one (prod runs UTC — see common/ist-date.ts).
 */
export function orderYearYY(now: Date = new Date()): string {
  const y = new Date(now.getTime() + IST_OFFSET_MS).getUTCFullYear();
  return String(y % 100).padStart(2, '0');
}

/** Format a full order number: `TENANT-YY-######`. */
export function formatOrderNumber(code: string, yy: string, seq: number): string {
  return `${code}-${yy}-${String(seq).padStart(ORDER_SEQ_WIDTH, '0')}`;
}

/**
 * Concurrency-safe next order number for a tenant+year. Run INSIDE a $transaction
 * (the advisory xact lock is scoped to that transaction). Returns e.g.
 * `DEOLEO-26-000042`.
 */
export async function generateTenantOrderNumber(
  tx: Prisma.TransactionClient,
  clientId: string,
  now: Date = new Date(),
): Promise<string> {
  const code = deriveTenantCode(clientId);
  const yy = orderYearYY(now);
  const prefix = `${code}-${yy}-`;

  // Serialise concurrent generators for this (tenant, year). hashtext(text)->int
  // is a stable Postgres hash; the lock releases at commit/rollback.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`;

  const rows = await tx.$queryRaw<Array<{ orderNumber: string }>>`
    SELECT "orderNumber" FROM redemption_orders
    WHERE "orderNumber" LIKE ${prefix + '%'}
    ORDER BY LENGTH("orderNumber") DESC, "orderNumber" DESC
    LIMIT 1
  `;

  let next = 1;
  if (rows.length > 0) {
    const suffix = rows[0].orderNumber.slice(prefix.length);
    const n = Number.parseInt(suffix, 10);
    if (Number.isFinite(n) && n >= 0) next = n + 1;
  }
  return formatOrderNumber(code, yy, next);
}
