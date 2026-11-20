/**
 * Imported (old-app) Visibility history — THE one module for every question about it (Excel report, report screen,
 * dashboards, digest, review history / capture dialog). Do not re-derive these rules anywhere else.
 *
 *   1. Is this CAPTURE imported?  → one of its photos is stored under a `/vendor-import/` key segment: the import
 *      re-hosted every old-app photo to `visibility-media/<tenant>/vendor-import/...` (BAJAJ-PROD-OUTLET-IMPORT §8) and a
 *      portal capture never writes there. Whether a rep is recorded says nothing (an import may fill reps; a deleted rep
 *      is SetNull). The review-events migration 20261120140000_visibility_review_events uses the SAME string in SQL
 *      (`formValues::text LIKE '%/vendor-import/%'`).
 *   2. When did the PORTAL go live?  → the earliest server receive time of a capture with NO imported photo
 *      (`visibilityPortalGoLive`, instant-level). The go-live MONTH is that instant's IST month.
 *   3. Per WINDOW (`classifyWindowAgainstGoLive`): 'old' = it ended before go-live (with no portal capture yet: the
 *      scope holds imported captures) → not tracked; 'part-old' = it holds imported captures or began before go-live →
 *      a closed window with no capture is "No approved record — part of this window was on the old app", never
 *      "Missed"; else 'portal' (normal rules).
 *   4. Per MONTH (`isVisibilityImportedMonth`): a month before the go-live month (no go-live yet: a month holding
 *      captures — all of them imported). The old app only kept APPROVED visits, so an imported month shows the visits
 *      it kept and never coverage / "Missed" against today's outlets (IMPORTED_MONTH_NOTE).
 */
import { Prisma } from '@prisma/client';
import { istMonthKey } from '../common/ist-date';
import { readMediaValue } from './visibility-types';

/** Key segment of every re-hosted old-app photo (the SQL backfill uses the same string). */
export const VISIBILITY_IMPORTED_KEY_MARKER = '/vendor-import/';

/** The plain one-line explanation shown wherever an imported month's / window's coverage or Missed would appear. */
export const IMPORTED_MONTH_NOTE =
  "Not tracked for imported months — the old app's records only include approved visits, so coverage and Missed cannot be worked out.";

/** True when any stored media value of the capture points at a re-hosted old-app photo. Pure. */
export function isImportedVisibilityCapture(formValues: unknown): boolean {
  if (!formValues || typeof formValues !== 'object' || Array.isArray(formValues)) return false;
  for (const v of Object.values(formValues as Record<string, unknown>)) {
    const { key } = readMediaValue(v);
    if (key && key.includes(VISIBILITY_IMPORTED_KEY_MARKER)) return true;
  }
  return false;
}

/** Anything with a `$queryRaw` (PrismaService, a transaction client). */
export type VisibilityGoLiveReader = { $queryRaw: <T = unknown>(query: Prisma.Sql) => Promise<T> };

/** Per-tenant in-memory cache of the go-live instant (the aggregate casts every capture's formValues to text). */
const GO_LIVE_TTL_MS = 5 * 60_000;
const goLiveCache = new Map<string, { at: number; value: Date | null }>();

/**
 * Drop the cached go-live of one tenant (or all). Called when a capture is CREATED in the portal (a first portal
 * capture moves go-live), and by tests. Cheap — no query.
 */
export function clearVisibilityGoLiveCache(clientId?: string): void {
  if (clientId === undefined) goLiveCache.clear();
  else goLiveCache.delete(clientId);
}

/**
 * A portal capture was just created. It can only move go-live when the tenant had NO portal capture yet (cached null)
 * — any later capture is after an existing go-live — so only that entry is dropped. No query.
 */
export function noteVisibilityPortalCapture(clientId: string): void {
  const hit = goLiveCache.get(clientId);
  if (hit && hit.value === null) goLiveCache.delete(clientId);
}

/**
 * The tenant's portal go-live instant: MIN(receivedAt) over captures whose stored values reference no imported photo.
 * null when every capture is imported (or there are none). One tenant-scoped aggregate, CACHED per tenant for 5 minutes
 * (cleared when a portal capture is created) — callers run it once per report / dashboard load, never per window or
 * outlet. `now` is injectable for tests.
 */
export async function visibilityPortalGoLive(
  prisma: VisibilityGoLiveReader,
  clientId: string,
  now: number = Date.now(),
): Promise<Date | null> {
  const hit = goLiveCache.get(clientId);
  if (hit && now - hit.at < GO_LIVE_TTL_MS) return hit.value;
  const rows = await prisma.$queryRaw<Array<{ goLive: Date | null }>>(Prisma.sql`
    SELECT MIN("receivedAt") AS "goLive"
    FROM "visibility_captures"
    WHERE "clientId" = ${clientId}
      AND ("formValues" IS NULL OR "formValues"::text NOT LIKE ${`%${VISIBILITY_IMPORTED_KEY_MARKER}%`})
  `);
  const v = Array.isArray(rows) ? rows[0]?.goLive : null;
  const value = v ? new Date(v) : null;
  goLiveCache.set(clientId, { at: now, value });
  return value;
}

/** The go-live instant's IST month `YYYY-MM` (null = no portal capture yet). */
export function goLiveMonthOf(goLive: Date | null): string | null {
  return goLive ? istMonthKey(goLive) : null;
}

/**
 * The imported-month rule. Pure.
 *   goLiveMonth set  → month < goLiveMonth (every window of it ended before the go-live instant).
 *   goLiveMonth null → the month holds captures (all imported, since no portal capture exists anywhere).
 */
export function isImportedMonthRule(month: string, goLiveMonth: string | null, monthHasCaptures: boolean): boolean {
  if (goLiveMonth) return month < goLiveMonth;
  return monthHasCaptures;
}

/** Loader form of {@link isImportedMonthRule}: one go-live aggregate (+ one count only when there is no go-live). */
export async function isVisibilityImportedMonth(
  prisma: VisibilityGoLiveReader & { visibilityCapture: Pick<Prisma.TransactionClient['visibilityCapture'], 'count'> },
  clientId: string,
  month: string,
  goLive?: Date | null,
): Promise<boolean> {
  const live = goLive === undefined ? await visibilityPortalGoLive(prisma, clientId) : goLive;
  const goLiveMonth = goLiveMonthOf(live);
  if (goLiveMonth) return isImportedMonthRule(month, goLiveMonth, false);
  const n = await prisma.visibilityCapture.count({ where: { clientId, windowKey: { startsWith: `${month}-P` } } });
  return isImportedMonthRule(month, null, n > 0);
}

export type GoLiveWindowClass = 'old' | 'part-old' | 'portal';

/**
 * A window against the go-live instant. Pure.
 *   - 'old'      : it ended at/before go-live; with no go-live, the scope being reported holds imported captures.
 *   - 'part-old' : not old, and it holds imported captures or began before go-live.
 *   - 'portal'   : everything after go-live — the normal Missed / Not captured yet rules apply.
 */
export function classifyWindowAgainstGoLive(
  range: { start: Date; end: Date },
  goLive: Date | null,
  opts: { windowHoldsImported: boolean; scopeHoldsImported: boolean },
): GoLiveWindowClass {
  const old = goLive ? range.end.getTime() <= goLive.getTime() : opts.scopeHoldsImported;
  if (old) return 'old';
  if (opts.windowHoldsImported || (goLive !== null && range.start.getTime() < goLive.getTime())) return 'part-old';
  return 'portal';
}

/** The window keys (of `windowKeys`) holding at least one imported capture — one tenant-scoped query. */
export async function importedWindowKeys(
  prisma: VisibilityGoLiveReader,
  clientId: string,
  windowKeys: string[],
): Promise<Set<string>> {
  if (windowKeys.length === 0) return new Set();
  const rows = await prisma.$queryRaw<Array<{ windowKey: string }>>(Prisma.sql`
    SELECT DISTINCT "windowKey"
    FROM "visibility_captures"
    WHERE "clientId" = ${clientId}
      AND "windowKey" IN (${Prisma.join(windowKeys)})
      AND "formValues"::text LIKE ${`%${VISIBILITY_IMPORTED_KEY_MARKER}%`}
  `);
  return new Set((Array.isArray(rows) ? rows : []).map((r) => r.windowKey));
}
