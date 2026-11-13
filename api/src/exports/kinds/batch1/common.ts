/**
 * Lane B shared bits for the batch-1 export kinds (Outlet master, visibility, KYC).
 */
import { BadRequestException } from '@nestjs/common';

/** Rows read from the database per page (export-kinds.ts: ≤ 2,000, keyset). */
export const BATCH1_PAGE_SIZE = 2000;

/** Raw params (query or body) as a plain object; anything else → {}. */
export function rawObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * An optional string query param, mirroring the endpoints' `@IsOptional() @IsString()` DTO fields: absent/null → undefined,
 * a string → itself, anything else → 400 (what the ValidationPipe answered for a non-string).
 */
export function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new BadRequestException(`${key} must be a string`);
  return v;
}

/** `YYYY-MM-DD` of an instant in UTC — the date the old endpoints stamped on file names (`toISOString()`). */
export function utcDateKey(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Most days a date range may span and still stream instantly (one calendar month). */
export const LIGHT_RANGE_MAX_DAYS = 31;

/**
 * true when both bounds are valid dates and the range spans at most one month (≤ 31 days, inclusive of both days).
 * Anything open-ended / unparseable / longer → false (heavy).
 */
export function isBoundedRange(from?: string, to?: string): boolean {
  if (!from || !to) return false;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (b < a) return true; // an inverted range matches nothing — trivially small
  return b - a <= (LIGHT_RANGE_MAX_DAYS - 1) * 86_400_000 + 86_399_999;
}

/** Plain summary of an optional range: "All dates", "2026-11-01 to 2026-11-30", "From …", "Up to …". */
export function describeRange(from?: string, to?: string): string {
  if (!from && !to) return 'All dates';
  if (from && to) return `${from} to ${to}`;
  return from ? `From ${from}` : `Up to ${to}`;
}
