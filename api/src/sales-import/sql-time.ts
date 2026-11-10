/**
 * Timezone-independent "now" for RAW SQL (real-DB finding 3). Every Prisma `DateTime` column here is
 * `TIMESTAMP(3)` WITHOUT time zone holding UTC wall-clock time (that is what the Prisma client writes). A bare `now()`
 * (timestamptz) compared with or stored into such a column is converted using the DB SESSION time zone — on a session
 * set to Asia/Kolkata a live worker's heartbeat looked 5.5 h stale and was claimed twice. Raw SQL in the Sales Import
 * module therefore uses ONLY these fragments (pinned by sql-time.spec.ts, which fails on any bare now()).
 */
import { Prisma } from '@prisma/client';

/** The current instant as a UTC `timestamp without time zone` — comparable with / storable into Prisma DateTime columns. */
export const SQL_NOW_UTC = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** A JS Date as the same UTC `timestamp without time zone` (sent as ISO text, parsed with its 'Z', converted to UTC). */
export function sqlUtc(d: Date): Prisma.Sql {
  return Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}
