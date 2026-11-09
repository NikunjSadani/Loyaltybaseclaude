/**
 * Offer tiles — shared API contract (platform/docs/plans/OFFER-TILES-PLAN.md §3.1).
 * The FE mirrors these in platform/src/lib/offers.ts — change both together.
 *
 * DISPLAY-ONLY content: nothing here credits, computes or reserves points.
 */

export type OfferValueType = 'POINTS' | 'PERCENT' | 'RUPEES' | 'TEXT';
export type OfferGroup = 'TARGET_REWARD' | 'EXTRA_SCHEME';

export const OFFER_GROUPS: readonly OfferGroup[] = ['TARGET_REWARD', 'EXTRA_SCHEME'];
export const OFFER_VALUE_TYPES: readonly OfferValueType[] = ['POINTS', 'PERCENT', 'RUPEES', 'TEXT'];

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
  target: number | null;
  achieved: number;
  pct: number | null;
  unlocked: boolean;
}

/** Partner view — no targeting/audit fields leak to partners. */
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

/** Admin write payload (POST body; PATCH is a partial of this). */
export interface OfferTileInput {
  group: OfferGroup;
  valueType: OfferValueType;
  valueNumber?: number | null;
  valueText?: string | null;
  unitLabel?: string | null;
  product?: string | null;
  label: string;
  details?: string | null;
  validFrom: string;
  validTo: string;
  sortOrder?: number;
  isActive?: boolean;
  programNames?: string[];
  outletTypeCodes?: string[];
  zones?: string[];
  states?: string[];
  kpiCode?: string | null;
}

/** validateTileInput output — every field present and normalized. */
export interface NormalizedOfferTileInput {
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
