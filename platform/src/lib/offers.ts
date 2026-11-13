/* ─── Offer tiles ("This month's offers") — FE types, formatters, fetchers ─────
   Display-only, admin-authored tiles shown on the PARTNER dashboard. Nothing here
   credits, computes or promises points. Types mirror the backend contract in
   platform/docs/plans/OFFER-TILES-PLAN.md §3 (BE: api/src/offers/offers.types.ts).

   HYDRATION: every formatter here is pure string math on server-sent 'YYYY-MM-DD'
   keys — no Date / timezone reads — so it is safe to call during render.
─────────────────────────────────────────────────────────────────────────────── */

import { api, type ApiResponse } from '@/lib/api-client';
import type { AppliesTo } from '@/lib/applies-to';
import { kpiScopeOf, type KpiScopeFieldsLike } from '@/lib/kpi-scope-core';

// ── §3.1 shared types (verbatim from the contract) ────────────────────────────

export type OfferValueType = 'POINTS' | 'PERCENT' | 'RUPEES' | 'TEXT';
export type OfferGroup = 'TARGET_REWARD' | 'EXTRA_SCHEME';

/** Admin view of a tile (dates are IST calendar days 'YYYY-MM-DD'). */
export interface OfferTileAdmin {
  id: string;
  group: OfferGroup;
  valueType: OfferValueType;
  valueNumber: number | null;
  valueText: string | null;
  unitLabel: string | null;
  product: string | null;
  label: string;
  details: string | null;
  validFrom: string;
  validTo: string;
  sortOrder: number;
  isActive: boolean;
  programNames: string[];
  outletTypeCodes: string[];
  zones: string[];
  states: string[];
  kpiCode: string | null;
  copiedFromId: string | null;
  /** 'YYYY-MM' the tile was copied into (copy-month idempotency key with copiedFromId); null if not a copy. */
  copiedToMonth: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OfferProgress {
  kpiCode: string;
  kpiName: string;
  unit: string;
  /** null ⇒ this outlet has no target for the KPI this month. */
  target: number | null;
  achieved: number;
  /** floor(achieved/target*100), clamped 0–100 and capped at 99 unless unlocked (100 ONLY when
   *  unlocked, i.e. achieved ≥ target); null when target null/0. */
  pct: number | null;
  unlocked: boolean;
}

/** Partner view — no targeting/audit fields. */
export interface OfferTilePartner {
  id: string;
  group: OfferGroup;
  valueType: OfferValueType;
  valueNumber: number | null;
  valueText: string | null;
  unitLabel: string | null;
  product: string | null;
  label: string;
  details: string | null;
  validTo: string;
  progress: OfferProgress | null;
}

/** POST /admin/offers body (§3.3). PATCH takes a Partial of it. */
export interface OfferTileInput {
  group: OfferGroup;
  valueType: OfferValueType;
  valueNumber: number | null;
  valueText: string | null;
  unitLabel: string | null;
  product: string | null;
  label: string;
  details: string | null;
  validFrom: string;
  validTo: string;
  sortOrder: number;
  isActive: boolean;
  programNames: string[];
  outletTypeCodes: string[];
  zones: string[];
  states: string[];
  kpiCode: string | null;
}

export interface OfferSegmentOptions {
  programNames: string[];
  zones: string[];
  states: string[];
}

// ── Labels + formatters ────────────────────────────────────────────────────────

export const OFFER_GROUP_LABEL = {
  TARGET_REWARD: 'Earn on your targets',
  EXTRA_SCHEME: 'Extra schemes this month',
} as const;

/** Fixed display order of the groups (TARGET_REWARD first). */
export const OFFER_GROUP_ORDER: readonly OfferGroup[] = ['TARGET_REWARD', 'EXTRA_SCHEME'];

export const OFFER_VALUE_TYPE_LABEL: Record<OfferValueType, string> = {
  POINTS: 'Points',
  PERCENT: 'Percent',
  RUPEES: 'Rupees (₹)',
  TEXT: 'Text',
};

/* Field limits — MIRROR the backend validator (api/src/offers/offers.helpers.ts validateTileInput).
   TEXT values are capped at 12 so they fit a 2-column tile at 320px (they may wrap, never ellipsis). */
export const OFFER_LIMITS = {
  valueText: 12,
  unitLabel: 20,
  product: 40,
  label: 60,
  details: 1000,
  valueMax: 9_999_999,
  percentMax: 100,
  sortOrderMin: 0,
  sortOrderMax: 1_000_000,
} as const;

/** Shown instead of a value when a numeric tile has no number yet (admin live preview). */
export const OFFER_VALUE_PLACEHOLDER = '—';

const num = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
/** Rupees: whole numbers stay whole ('₹1,500'); anything fractional shows 2 decimals ('₹1,500.50'). */
const rupees = (n: number) =>
  Number.isInteger(n)
    ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
    : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The big value shown first on a tile: '+35 pts', '+1 pt', '+2.5%', '₹1,500', '₹1,500.50', or
 * the text. A numeric tile with no number (only possible in the admin preview while the field is
 * empty) renders the placeholder — never a misleading '+0 pts'.
 */
export function formatOfferValue(
  t: Pick<OfferTilePartner, 'valueType' | 'valueNumber' | 'valueText'>,
): string {
  if (t.valueType === 'TEXT') return t.valueText ?? '';
  const n = t.valueNumber;
  if (n === null || n === undefined || !Number.isFinite(n)) return OFFER_VALUE_PLACEHOLDER;
  switch (t.valueType) {
    case 'POINTS':  return `+${num(n)} ${n === 1 ? 'pt' : 'pts'}`;
    case 'PERCENT': return `+${num(n)}%`;
    default:        return `₹${rupees(n)}`;
  }
}

/** Progress shown on a tile/sheet, clamped so the bar is NEVER full unless the API says unlocked. */
export function offerProgressView(p: OfferProgress | null): {
  showBar: boolean;
  /** 0–100, safe for width + aria-valuenow. < 100 whenever !unlocked. */
  pct: number;
  unlocked: boolean;
} {
  const unlocked = !!p?.unlocked;
  const showBar = !!p && p.target !== null && p.target > 0 && p.pct !== null;
  if (!showBar) return { showBar: false, pct: 0, unlocked };
  const raw = Math.max(0, Math.min(100, Math.round(p!.pct as number)));
  return { showBar, pct: unlocked ? 100 : Math.min(raw, 99), unlocked };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function splitDay(day: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return [Number(m[1]), mo, Number(m[3])];
}

/** 'YYYY-MM-DD' → '30 Nov 2026'. Pure string math — no Date/TZ, so it is hydration-safe. */
export function formatOfferDay(day: string): string {
  const p = splitDay(day);
  if (!p) return day ?? '';
  return `${p[2]} ${MONTHS[p[1] - 1]} ${p[0]}`;
}

/** 'YYYY-MM-DD' → '15 Nov' (compact per-tile "till" label). */
export function formatOfferDayShort(day: string): string {
  const p = splitDay(day);
  if (!p) return day ?? '';
  return `${p[2]} ${MONTHS[p[1] - 1]}`;
}

/** 'YYYY-MM' → 'November 2026'. */
export function formatMonthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return month ?? '';
  return `${MONTHS_LONG[Number(m[2]) - 1]} ${m[1]}`;
}

/** First/last calendar day of a 'YYYY-MM' month (pure; leap-year aware). */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, '0')}` };
}

/** The month before a 'YYYY-MM' key ('2026-01' → '2025-12'). */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Admin month picker years: two back, one ahead of the current IST year (+ the selected one). */
export function offerPickerYears(currentYear: number, selectedYear: number): number[] {
  const ys = new Set<number>();
  if (Number.isFinite(currentYear) && currentYear > 0) {
    for (let y = currentYear - 2; y <= currentYear + 1; y++) ys.add(y);
  }
  if (Number.isFinite(selectedYear)) ys.add(selectedYear);
  return [...ys].sort((a, b) => a - b);
}

/** Group tiles in the fixed order, dropping empty groups. Keeps the server's in-group order. */
export function groupOffers<T extends { group: OfferGroup }>(
  tiles: T[],
): Array<{ group: OfferGroup; tiles: T[] }> {
  return OFFER_GROUP_ORDER
    .map((group) => ({ group, tiles: tiles.filter((t) => t.group === group) }))
    .filter((g) => g.tiles.length > 0);
}

/** Section-level "Valid till" — only when every tile shares the same validTo. */
export function sectionValidTill(tiles: Array<Pick<OfferTilePartner, 'validTo'>>): string | null {
  if (tiles.length === 0) return null;
  const first = tiles[0].validTo;
  return tiles.every((t) => t.validTo === first) ? formatOfferDay(first) : null;
}

// ── Partner fetcher ────────────────────────────────────────────────────────────

/** GET /api/partner/offers → tiles. A bad shape / error resolves to [] (section self-hides). */
export async function fetchPartnerOffers(): Promise<OfferTilePartner[]> {
  const r = await api.get<{ tiles: OfferTilePartner[] }>('/api/partner/offers');
  return r.success && Array.isArray(r.data?.tiles) ? r.data.tiles : [];
}

// ── Admin fetchers (tenant is JWT-scoped by the BE — NEVER send a clientId) ────

export function listOffers(month: string): Promise<ApiResponse<{ month: string; tiles: OfferTileAdmin[] }>> {
  return api.get(`/api/admin/offers?month=${encodeURIComponent(month)}`);
}

export function getOfferSegmentOptions(): Promise<ApiResponse<OfferSegmentOptions>> {
  return api.get('/api/admin/offers/segment-options');
}

export function createOffer(input: OfferTileInput): Promise<ApiResponse<{ tile: OfferTileAdmin }>> {
  return api.post('/api/admin/offers', input);
}

export function updateOffer(
  id: string,
  patch: Partial<OfferTileInput>,
): Promise<ApiResponse<{ tile: OfferTileAdmin }>> {
  return api.patch(`/api/admin/offers/${encodeURIComponent(id)}`, patch);
}

export function deleteOffer(id: string): Promise<ApiResponse<{ id: string }>> {
  return api.del(`/api/admin/offers/${encodeURIComponent(id)}`);
}

/** POST /admin/offers/copy-month result. `kpiCleared` / `unknownOutletTypes` are ids of the NEW
 *  draft copies: KPI link removed (KPI deleted/disabled) / outlet types that no longer exist
 *  (publishing those is refused until fixed). */
export interface CopyMonthResult {
  created: number;
  skipped: number;
  kpiCleared: string[];
  unknownOutletTypes: string[];
  tiles: OfferTileAdmin[];
}

export function copyOffersMonth(
  fromMonth: string,
  toMonth: string,
): Promise<ApiResponse<CopyMonthResult>> {
  return api.post('/api/admin/offers/copy-month', { fromMonth, toMonth });
}

/** Tenant outlet types for the targeting picker (existing GET /settings/outlet-types). */
export interface OfferOutletTypeOption { code: string; label: string }
export async function getOfferOutletTypes(): Promise<OfferOutletTypeOption[]> {
  const r = await api.get<Array<{ code: string; label?: string; name?: string; displayName?: string | null }>>(
    '/api/settings/outlet-types',
  );
  if (!r.success || !Array.isArray(r.data)) return [];
  return r.data.map((t) => ({ code: t.code, label: t.displayName ?? t.label ?? t.name ?? t.code }));
}

/** Tenant's enabled KPIs for the "show progress on" select (existing GET /admin/kpis). */
export interface OfferKpiOption {
  code: string; label: string; unit: string;
  /** APPLIES-TO scope of the KPI (only for the form's overlap warning); absent = every outlet. */
  scope?: AppliesTo;
}
export async function getOfferKpis(): Promise<OfferKpiOption[]> {
  const r = await api.get<Array<{ code: string; label: string; unit: string; enabled?: boolean } & KpiScopeFieldsLike>>(
    '/api/admin/kpis?enabledOnly=true',
  );
  if (!r.success || !Array.isArray(r.data)) return [];
  return r.data
    .filter((k) => k.enabled !== false)
    .map((k) => {
      const scope = kpiScopeOf(k);
      const scoped = scope.outletTypes.length + scope.programs.length + scope.subPrograms.length > 0;
      return { code: k.code, label: k.label || k.code, unit: k.unit ?? '', ...(scoped ? { scope } : {}) };
    });
}
