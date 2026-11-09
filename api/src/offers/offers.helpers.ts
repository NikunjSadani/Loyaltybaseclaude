import { BadRequestException } from '@nestjs/common';
import {
  NormalizedOfferTileInput,
  OFFER_GROUPS,
  OFFER_VALUE_TYPES,
  OfferGroup,
  OfferTileInput,
} from './offers.types';

/**
 * Pure offer-tile helpers (no Prisma, no Nest DI) — keep the services thin and the edge cases
 * testable. See platform/docs/plans/OFFER-TILES-PLAN.md §3.3 for the validation rules.
 */

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 'YYYY-MM-DD' (an IST calendar day) → Date at 00:00 UTC of that day, which is exactly how a
 * Prisma `@db.Date` column round-trips.
 */
export function istDayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * Inverse of istDayToDate. Uses toISOString() DELIBERATELY: a `@db.Date` value comes back from
 * Prisma as 00:00 UTC of the stored calendar day (the column is TZ-less), so the UTC date IS the
 * stored IST day. Do NOT "fix" this to istDateKey() — that shifts by +5:30 and only gives the same
 * answer by accident.
 */
export function dateToIstDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** True for a well-formed, real calendar day 'YYYY-MM-DD'. */
export function isRealDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const d = istDayToDate(day);
  return !Number.isNaN(d.getTime()) && dateToIstDay(d) === day;
}

export function isMonthKey(month: unknown): month is string {
  return typeof month === 'string' && MONTH_RE.test(month);
}

/** First/last IST calendar day of a 'YYYY-MM' month. */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, '0')}` };
}

export interface OutletSeg {
  programName: string | null;
  outletTypeCode: string | null;
  zone: string | null;
  state: string | null;
}

export interface TileSegment {
  programNames: string[];
  outletTypeCodes: string[];
  zones: string[];
  states: string[];
}

/** Does an outlet fall inside a tile's audience? EMPTY list = all; case/space-insensitive. */
export function outletMatches(t: TileSegment, o: OutletSeg): boolean {
  const ok = (list: string[], v: string | null) =>
    list.length === 0 || (norm(v) !== '' && list.some((x) => norm(x) === norm(v)));
  return (
    ok(t.programNames, o.programName) &&
    ok(t.outletTypeCodes, o.outletTypeCode) &&
    ok(t.zones, o.zone) &&
    ok(t.states, o.state)
  );
}

/** Per-tile KPI progress. pct null when there is no positive target; unlocked at ≥ 100%. */
export function computeProgress(target: number | null, achieved: number) {
  const pct = target !== null && target > 0 ? Math.round((achieved / target) * 100) : null;
  return { target, achieved, pct, unlocked: target !== null && target > 0 && achieved >= target };
}

const GROUP_RANK: Record<OfferGroup, number> = { TARGET_REWARD: 0, EXTRA_SCHEME: 1 };

/** Contract sort: group (TARGET_REWARD first) → sortOrder asc → createdAt asc. Non-mutating. */
export function sortTiles<T extends { group: OfferGroup; sortOrder: number; createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      GROUP_RANK[a.group] - GROUP_RANK[b.group] ||
      a.sortOrder - b.sortOrder ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

// ── Validation ────────────────────────────────────────────────────────────────

const bad = (msg: string): never => {
  throw new BadRequestException(msg);
};

/** Trim; empty → null; enforce a max length with a human message. */
function optText(v: unknown, field: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') bad(`${field} must be text.`);
  const s = (v as string).trim();
  if (s === '') return null;
  if (s.length > max) bad(`${field} must be at most ${max} characters.`);
  return s;
}

function normList(v: unknown, field: string): string[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) bad(`${field} must be a list.`);
  const out: string[] = [];
  for (const raw of v as unknown[]) {
    if (typeof raw !== 'string') bad(`${field} entries must be text.`);
    const s = (raw as string).trim();
    if (s === '') continue;
    if (s.length > 80) bad(`Each ${field} entry must be at most 80 characters.`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 50) bad(`${field} can have at most 50 entries.`);
  return out;
}

const MAX_VALUE = 9_999_999;

/**
 * Validate + normalize a FULL tile input (for PATCH, pass the merged existing+patch row).
 * Throws BadRequestException with a human message (the admin form shows it verbatim).
 */
export function validateTileInput(input: OfferTileInput): NormalizedOfferTileInput {
  if (!OFFER_GROUPS.includes(input.group)) bad('group must be TARGET_REWARD or EXTRA_SCHEME.');
  if (!OFFER_VALUE_TYPES.includes(input.valueType)) bad('valueType must be POINTS, PERCENT, RUPEES or TEXT.');

  const label = optText(input.label, 'label', 60);
  if (label === null) bad('label is required.');

  let valueNumber: number | null = null;
  let valueText: string | null = null;
  if (input.valueType === 'TEXT') {
    valueText = optText(input.valueText, 'valueText', 12);
    if (valueText === null) bad('valueText is required for a TEXT tile (1–12 characters).');
  } else {
    const n = input.valueNumber;
    if (typeof n !== 'number' || !Number.isFinite(n)) bad('valueNumber is required for this value type.');
    const num = n as number;
    if (num <= 0 || num > MAX_VALUE) bad(`valueNumber must be greater than 0 and at most ${MAX_VALUE.toLocaleString('en-IN')}.`);
    if (Math.abs(num * 100 - Math.round(num * 100)) > 1e-6) bad('valueNumber can have at most 2 decimal places.');
    if (input.valueType === 'PERCENT' && num > 100) bad('A PERCENT value must be at most 100.');
    valueNumber = Math.round(num * 100) / 100;
  }

  if (!isRealDay(input.validFrom)) bad('validFrom must be a real date in YYYY-MM-DD format.');
  if (!isRealDay(input.validTo)) bad('validTo must be a real date in YYYY-MM-DD format.');
  if (input.validTo < input.validFrom) bad('validTo must be on or after validFrom.');

  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isInteger(sortOrder) || Math.abs(sortOrder) > 1_000_000) bad('sortOrder must be a whole number.');

  const isActive = input.isActive ?? true;
  if (typeof isActive !== 'boolean') bad('isActive must be true or false.');

  const kpiCode = optText(input.kpiCode, 'kpiCode', 80);

  return {
    group: input.group,
    valueType: input.valueType,
    valueNumber,
    valueText,
    unitLabel: optText(input.unitLabel, 'unitLabel', 20),
    product: optText(input.product, 'product', 40),
    label: label as string,
    details: optText(input.details, 'details', 1000),
    validFrom: input.validFrom,
    validTo: input.validTo,
    sortOrder,
    isActive,
    programNames: normList(input.programNames, 'programNames'),
    outletTypeCodes: normList(input.outletTypeCodes, 'outletTypeCodes'),
    zones: normList(input.zones, 'zones'),
    states: normList(input.states, 'states'),
    kpiCode,
  };
}

/** Coerce a JSON KPI cell to a finite number, or null when absent/non-numeric. */
export function kpiNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
