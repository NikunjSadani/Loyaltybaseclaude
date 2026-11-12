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

/**
 * Per-tile KPI progress. pct null when there is no positive target. A negative achieved (returns
 * netting below zero) reads as 0. `unlocked` <=> achieved >= target, and pct is FLOORED + clamped to
 * [0, 100] so the bar can never show 100% while the reward is still locked (199/200 -> 99, not 100).
 */
export function computeProgress(target: number | null, achievedRaw: number) {
  const achieved = Number.isFinite(achievedRaw) && achievedRaw > 0 ? achievedRaw : 0;
  const hasTarget = target !== null && target > 0;
  const unlocked = hasTarget && achieved >= (target as number);
  const pct = !hasTarget
    ? null
    : unlocked
      ? 100
      : Math.max(0, Math.min(99, Math.floor((achieved / (target as number)) * 100)));
  return { target, achieved, pct, unlocked };
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
  if (typeof v !== 'string') bad(`${field} must be text`);
  const s = (v as string).trim();
  if (s === '') return null;
  if (s.length > max) bad(`${field} must be at most ${max} characters`);
  return s;
}

function normList(v: unknown, field: string): string[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) bad(`${field} must be a list`);
  const out: string[] = [];
  for (const raw of v as unknown[]) {
    if (typeof raw !== 'string') bad(`${field} entries must be text`);
    const s = (raw as string).trim();
    if (s === '') continue;
    if (s.length > 80) bad(`Each ${field} entry must be at most 80 characters`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 50) bad(`${field} can have at most 50 entries`);
  return out;
}

const MAX_VALUE = 9_999_999;
const MAX_SORT = 1_000_000;
const MIN_YEAR = 2020;
const MAX_YEAR = 2100;
/** Inclusive day-count cap for a validity window (one leap year). */
export const MAX_WINDOW_DAYS = 366;

/** Inclusive number of calendar days from..to (both real 'YYYY-MM-DD'). */
export function windowDays(from: string, to: string): number {
  return Math.round((istDayToDate(to).getTime() - istDayToDate(from).getTime()) / 86_400_000) + 1;
}

const LIST_KEYS = new Set<keyof OfferTileInput>(['programNames', 'outletTypeCodes', 'zones', 'states']);

/** Fields that are NOT NULL in the table — an explicit `null` for any of them is a 400 (never "default"). */
const NON_NULLABLE: { key: keyof OfferTileInput; label: string }[] = [
  { key: 'group', label: 'Group' },
  { key: 'valueType', label: 'Value type' },
  { key: 'label', label: 'Headline' },
  { key: 'validFrom', label: 'Valid from' },
  { key: 'validTo', label: 'Valid to' },
  { key: 'sortOrder', label: 'Sort order' },
  { key: 'isActive', label: 'Published' },
  { key: 'programNames', label: 'Programs' },
  { key: 'outletTypeCodes', label: 'Outlet types' },
  { key: 'zones', label: 'Zones' },
  { key: 'states', label: 'States' },
];

/**
 * Refuse an explicit `null` on a non-nullable field (POST or PATCH). Without this, `?? default`
 * silently turned `isActive: null` into a PUBLISH and `sortOrder: null` into 0. To target
 * everyone, send an EMPTY list `[]`, not null.
 */
export function assertNoNulls(body: unknown): void {
  if (body === null || typeof body !== 'object') return;
  const b = body as Record<string, unknown>;
  for (const { key, label } of NON_NULLABLE) {
    if (key in b && b[key] === null) {
      bad(
        LIST_KEYS.has(key)
          ? `${label} can't be null — send an empty list to target everyone`
          : `${label} can't be empty`,
      );
    }
  }
}

/**
 * Validate + normalize a FULL tile input (for PATCH, pass the merged existing+patch row).
 * Throws BadRequestException with a human message (the admin form shows it verbatim).
 */
export function validateTileInput(input: OfferTileInput): NormalizedOfferTileInput {
  if (!OFFER_GROUPS.includes(input.group)) bad('Group must be Target reward or Extra scheme');
  if (!OFFER_VALUE_TYPES.includes(input.valueType)) bad('Value type must be Points, Percent, Rupees or Text');

  const label = optText(input.label, 'Headline', 60);
  if (label === null) bad('Headline is required');

  let valueNumber: number | null = null;
  let valueText: string | null = null;
  if (input.valueType === 'TEXT') {
    valueText = optText(input.valueText, 'Value text', 12);
    if (valueText === null) bad('Value text is required (1–12 characters)');
  } else {
    const n = input.valueNumber;
    if (typeof n !== 'number' || !Number.isFinite(n)) bad('Value is required');
    const num = n as number;
    if (num <= 0) bad('Value must be greater than 0');
    if (input.valueType === 'PERCENT' && num > 100) bad("Percent can't exceed 100");
    if (num > MAX_VALUE) bad(`Value can't exceed ${MAX_VALUE.toLocaleString('en-IN')}`);
    if (Math.abs(num * 100 - Math.round(num * 100)) > 1e-6) bad('Value can have at most 2 decimal places');
    valueNumber = Math.round(num * 100) / 100;
  }

  if (!isRealDay(input.validFrom)) bad('Valid from must be a real date');
  if (!isRealDay(input.validTo)) bad('Valid to must be a real date');
  const fromYear = Number(input.validFrom.slice(0, 4));
  const toYear = Number(input.validTo.slice(0, 4));
  if (fromYear < MIN_YEAR || fromYear > MAX_YEAR) bad(`Valid from must be between ${MIN_YEAR} and ${MAX_YEAR}`);
  if (toYear < MIN_YEAR || toYear > MAX_YEAR) bad(`Valid to must be between ${MIN_YEAR} and ${MAX_YEAR}`);
  if (input.validTo < input.validFrom) bad('Valid to must be on or after Valid from');
  if (windowDays(input.validFrom, input.validTo) > MAX_WINDOW_DAYS) {
    bad(`An offer can run for at most ${MAX_WINDOW_DAYS} days`);
  }

  // undefined -> default (POST may omit it); an explicit null is refused upstream by assertNoNulls.
  const sortOrder = input.sortOrder ?? 0;
  if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > MAX_SORT) {
    bad('Sort order must be a whole number between 0 and 1,000,000');
  }

  const isActive = input.isActive ?? true;
  if (typeof isActive !== 'boolean') bad('Published must be true or false');

  const kpiCode = optText(input.kpiCode, 'KPI', 80);

  return {
    group: input.group,
    valueType: input.valueType,
    valueNumber,
    valueText,
    unitLabel: optText(input.unitLabel, 'Unit label', 20),
    product: optText(input.product, 'Product', 40),
    label: label as string,
    details: optText(input.details, 'Details', 1000),
    validFrom: input.validFrom,
    validTo: input.validTo,
    sortOrder,
    isActive,
    programNames: normList(input.programNames, 'Programs'),
    outletTypeCodes: normList(input.outletTypeCodes, 'Outlet types'),
    zones: normList(input.zones, 'Zones'),
    states: normList(input.states, 'States'),
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
