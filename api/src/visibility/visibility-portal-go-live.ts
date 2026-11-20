/**
 * When did a tenant start capturing Visibility in THIS portal? — shared by the Visibility Excel report (Not-captured
 * sheet) and the dashboards.
 *
 * Imported old-app history is recognised by its photo storage path: the import re-hosted every old-app photo under a
 * `/vendor-import/` key segment (BAJAJ-PROD-OUTLET-IMPORT §8). Whether a rep is recorded says nothing (an import may
 * fill reps). The go-live instant = the earliest server receive time of a capture with NO imported photo.
 */
import { Prisma } from '@prisma/client';
import { readMediaValue } from './visibility-types';

/** Key segment of every re-hosted old-app photo. */
export const VISIBILITY_IMPORTED_KEY_MARKER = '/vendor-import/';

/** True when any stored media value of the capture points at a re-hosted old-app photo. */
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

/**
 * The tenant's portal go-live instant: MIN(receivedAt) over captures whose stored values reference no imported photo.
 * null when every capture is imported (or there are none). One indexed-by-tenant aggregate.
 */
export async function visibilityPortalGoLive(prisma: VisibilityGoLiveReader, clientId: string): Promise<Date | null> {
  const rows = await prisma.$queryRaw<Array<{ goLive: Date | null }>>(Prisma.sql`
    SELECT MIN("receivedAt") AS "goLive"
    FROM "visibility_captures"
    WHERE "clientId" = ${clientId}
      AND ("formValues" IS NULL OR "formValues"::text NOT LIKE ${`%${VISIBILITY_IMPORTED_KEY_MARKER}%`})
  `);
  const v = Array.isArray(rows) ? rows[0]?.goLive : null;
  return v ? new Date(v) : null;
}
