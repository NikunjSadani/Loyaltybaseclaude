/* ─── Offer tiles ("This month's offers") — FE types, formatters, fetchers ─────
   Display-only, admin-authored tiles shown on the PARTNER dashboard. Nothing here
   credits, computes or promises points. Types mirror the backend contract in
   platform/docs/plans/OFFER-TILES-PLAN.md §3 (BE: api/src/offers/offers.types.ts).

   HYDRATION: every formatter here is pure string math on server-sent 'YYYY-MM-DD'
   keys — no Date / timezone reads — so it is safe to call during render.
─────────────────────────────────────────────────────────────────────────────── */

import { api, type ApiResponse } from '@/lib/api-client';

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
  /** round(achieved/target*100); null when target null/0. */
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

const num = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** The big value shown first on a tile: '+35 pts', '+1 pt', '+2.5%', '₹1,500', or the text. */
export function formatOfferValue(
  t: Pick<OfferTilePartner, 'valueType' | 'valueNumber' | 'valueText'>,
): string {
  switch (t.valueType) {
    case 'POINTS':  return `+${num(t.valueNumber ?? 0)} ${t.valueNumber === 1 ? 'pt' : 'pts'}`;
    case 'PERCENT': return `+${num(t.valueNumber ?? 0)}%`;
    case 'RUPEES':  return `₹${num(t.valueNumber ?? 0)}`;
    default:        return t.valueText ?? '';
  }
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

export function copyOffersMonth(
  fromMonth: string,
  toMonth: string,
): Promise<ApiResponse<{ created: number; skipped: number; tiles: OfferTileAdmin[] }>> {
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
export interface OfferKpiOption { code: string; label: string; unit: string }
export async function getOfferKpis(): Promise<OfferKpiOption[]> {
  const r = await api.get<Array<{ code: string; label: string; unit: string; enabled?: boolean }>>(
    '/api/admin/kpis?enabledOnly=true',
  );
  if (!r.success || !Array.isArray(r.data)) return [];
  return r.data
    .filter((k) => k.enabled !== false)
    .map((k) => ({ code: k.code, label: k.label || k.code, unit: k.unit ?? '' }));
}
