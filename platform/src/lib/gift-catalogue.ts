/* ─── Gift CATALOGUE (Wave-1) — shared types + pure helpers ───────────────────
   The platform Gift MASTER catalogue that Gifsy operators (GIFSY_ADMIN) curate:
   platform-source master items, the shared category taxonomy, per-tenant publish
   + pricing, and the (Wave-2-filling) vendor-item moderation queue.

   This is DISTINCT from the legacy /admin/gifts page (a localStorage demo of the
   per-tenant reward catalog). Everything here is real, API-backed, and Gifsy-only.

   Design source of truth: platform/docs/plans/GIFT-CATALOGUE-AND-DISPATCH-DESIGN.md
   (§2 personas/scoping, §3 data model, §4 catalogue flows).

   Kept as a lib (not inline in the page) so the derivation + validation are unit-
   testable without rendering, mirroring src/lib/whatsapp-broadcasts.ts.
────────────────────────────────────────────────────────────────────────────── */

import { paiseToRupees, rupeesToPaise } from '@/lib/money';

// ── Enums (mirror the additive Prisma enums in §3) ─────────────────────────────

/** How a member redeems the gift. NOTE: the design doc labels this `PayoutMode`,
 *  but the live gift admin (/admin/gifts) uses these four string literals; we mirror
 *  that convention. Flagged for BE reconciliation — confirm the wire enum values. */
export type GiftRedemptionMode = 'GIFT_CARD' | 'PHYSICAL_GIFT' | 'UPI' | 'BANK_TRANSFER';

/** The default fulfilment channel a redemption order inherits (§1 decision 10). */
export type GiftFulfilmentChannel =
  | 'FULFILLED_BY_AMAZON'
  | 'GIFSY_WAREHOUSE'
  | 'BRAND'
  | 'DIGITAL_VOUCHER';

export type GiftMasterStatus = 'ACTIVE' | 'ARCHIVED';

/** Moderation state of a per-tenant catalogue row (§3 RewardCatalog extension). */
export type GiftModerationStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';

export const REDEMPTION_MODE_OPTIONS: { value: GiftRedemptionMode; label: string }[] = [
  { value: 'GIFT_CARD', label: 'Gift Card / Voucher' },
  { value: 'PHYSICAL_GIFT', label: 'Physical Gift' },
  { value: 'UPI', label: 'UPI (points → INR)' },
  { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
];

export const FULFILMENT_CHANNEL_OPTIONS: { value: GiftFulfilmentChannel; label: string }[] = [
  { value: 'FULFILLED_BY_AMAZON', label: 'Fulfilled by Amazon' },
  { value: 'GIFSY_WAREHOUSE', label: 'Gifsy Warehouse' },
  { value: 'BRAND', label: 'Brand-shipped' },
  { value: 'DIGITAL_VOUCHER', label: 'Digital Voucher' },
];

export const MODERATION_STATUS_LABEL: Record<GiftModerationStatus, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

// ── Wire contracts (mirror the API in §4; flag any BE mismatch, do not guess) ──

/** GET /api/admin/gift-masters → { items: GiftMasterSummary[] } */
export interface GiftMasterSummary {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  categoryName?: string | null;
  mrpPaise: number;
  redemptionMode: GiftRedemptionMode;
  /** The DEFAULT fulfilment channel (§3 `fulfilmentSource`). */
  fulfilmentChannel: GiftFulfilmentChannel;
  status: GiftMasterStatus;
  /** null = unlimited stock. */
  stockQuantity: number | null;
  imageUrls: string[];
  /** How many tenants this master is currently published to (for the list badge). */
  publishedTenantCount?: number;
  updatedAt?: string;
}

/** GET /api/admin/gift-masters/:id → flat GiftMasterDetail (detail = flat, per contract). */
export interface GiftMasterDetail extends GiftMasterSummary {
  description: string;
  termsAndConditions: string;
}

/** The editable form shape (rupees at the human edge; converted to paise on POST/PUT). */
export interface GiftMasterFormState {
  code: string;
  name: string;
  description: string;
  categoryId: string;
  /** ₹ rupees as typed (converted to mrpPaise before submit). */
  mrpRupees: string;
  redemptionMode: GiftRedemptionMode;
  fulfilmentChannel: GiftFulfilmentChannel;
  termsAndConditions: string;
  /** blank = unlimited; a number string otherwise. */
  stockQuantity: string;
  /** newline- or comma-separated image URLs in the form; serialised to string[]. */
  imageUrls: string;
  status: GiftMasterStatus;
}

export const EMPTY_MASTER_FORM: GiftMasterFormState = {
  code: '',
  name: '',
  description: '',
  categoryId: '',
  mrpRupees: '',
  redemptionMode: 'PHYSICAL_GIFT',
  fulfilmentChannel: 'GIFSY_WAREHOUSE',
  termsAndConditions: '',
  stockQuantity: '',
  imageUrls: '',
  status: 'ACTIVE',
};

/** GET /api/admin/gift-categories → { items: GiftCategory[] } (flat list; tree built client-side). */
export interface GiftCategory {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface GiftCategoryFormState {
  code: string;
  name: string;
  parentId: string; // '' = top-level
  imageUrl: string;
  sortOrder: string;
  isActive: boolean;
}

export const EMPTY_CATEGORY_FORM: GiftCategoryFormState = {
  code: '',
  name: '',
  parentId: '',
  imageUrl: '',
  sortOrder: '0',
  isActive: true,
};

/** One row of the per-tenant publish + pricing matrix.
 *  GET /api/admin/gift-masters/:id/publish → { items: TenantPublishRow[] }
 *  (ASSUMPTION — flagged: the BE must return each candidate tenant with its
 *   conversionRate so the ₹→points derivation can be shown; if not, we need a
 *   separate tenants+rate endpoint). */
export interface TenantPublishRow {
  clientId: string;
  clientName: string;
  /** points per ₹ (same unit as the redemption math). */
  conversionRate: number;
  published: boolean;
  /** current ₹ price (paise) if published, else null. */
  sellingValuePaise: number | null;
  /** current stored points cost if published (may be a manual override), else null. */
  pointsCost: number | null;
}

/** GET /api/admin/gift-catalogue/moderation → { items: ModerationItem[] } */
export interface ModerationItem {
  id: string;
  name: string;
  vendorName: string | null;
  clientName: string | null;
  sellingValuePaise: number;
  mrpPaise: number | null;
  imageUrl: string | null;
  categoryName: string | null;
  moderationStatus: GiftModerationStatus;
  submittedAt: string | null;
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────────

/**
 * Derive the points cost from a ₹ selling price and a tenant conversion rate.
 * conversionRate is points-per-₹ (§7 "rate = points-per-₹"), so
 *   pointsCost = round( sellingValueRupees × conversionRate ).
 * Returns null when the rate is missing/invalid (never divide-by-zero, never NaN).
 */
export function derivePointsCost(
  sellingValuePaise: number | null | undefined,
  conversionRate: number | null | undefined,
): number | null {
  if (sellingValuePaise == null || !Number.isFinite(sellingValuePaise)) return null;
  if (conversionRate == null || !Number.isFinite(conversionRate) || conversionRate <= 0) return null;
  return Math.round(paiseToRupees(sellingValuePaise) * conversionRate);
}

/** Parse a rupee string ("1,499.50" / "1499") to integer paise, or null if invalid/blank. */
export function parseRupeesToPaise(raw: string): number | null {
  const cleaned = raw.replace(/[,\s₹]/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return rupeesToPaise(n);
}

/** Split the textarea image-URL blob into a clean string[] (newline or comma separated). */
export function parseImageUrls(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s);
}

/**
 * Validate the gift-master editor form. Returns an array of human-readable errors
 * (empty = valid). Kept pure so the editor test can assert each rule directly.
 */
export function validateGiftMasterForm(form: GiftMasterFormState): string[] {
  const errors: string[] = [];
  if (!form.name.trim()) errors.push('Name is required.');
  if (!form.code.trim()) errors.push('Code is required.');
  if (!form.categoryId.trim()) errors.push('Category is required.');

  const mrp = parseRupeesToPaise(form.mrpRupees);
  if (mrp == null) errors.push('MRP must be a valid amount in ₹.');
  else if (mrp <= 0) errors.push('MRP must be greater than ₹0.');

  if (form.stockQuantity.trim() !== '') {
    const q = Number(form.stockQuantity.trim());
    if (!Number.isInteger(q) || q < 0) errors.push('Stock quantity must be a whole number (0 or more), or blank for unlimited.');
  }

  for (const url of parseImageUrls(form.imageUrls)) {
    if (!looksLikeUrl(url)) {
      errors.push(`Image URL is not valid: ${url}`);
      break; // one message is enough
    }
  }
  return errors;
}

/** Build the JSON body for create/update from the validated form. */
export function giftMasterFormToPayload(form: GiftMasterFormState): Record<string, unknown> {
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    categoryId: form.categoryId.trim(),
    mrpPaise: parseRupeesToPaise(form.mrpRupees),
    redemptionMode: form.redemptionMode,
    fulfilmentChannel: form.fulfilmentChannel,
    termsAndConditions: form.termsAndConditions.trim(),
    stockQuantity: form.stockQuantity.trim() === '' ? null : Number(form.stockQuantity.trim()),
    imageUrls: parseImageUrls(form.imageUrls),
    status: form.status,
  };
}

/** Hydrate the editor form from a detail record (paise → rupee string, array → textarea). */
export function giftMasterDetailToForm(d: GiftMasterDetail): GiftMasterFormState {
  return {
    code: d.code ?? '',
    name: d.name ?? '',
    description: d.description ?? '',
    categoryId: d.categoryId ?? '',
    mrpRupees: d.mrpPaise != null ? String(paiseToRupees(d.mrpPaise)) : '',
    redemptionMode: d.redemptionMode ?? 'PHYSICAL_GIFT',
    fulfilmentChannel: d.fulfilmentChannel ?? 'GIFSY_WAREHOUSE',
    termsAndConditions: d.termsAndConditions ?? '',
    stockQuantity: d.stockQuantity == null ? '' : String(d.stockQuantity),
    imageUrls: (d.imageUrls ?? []).join('\n'),
    status: d.status ?? 'ACTIVE',
  };
}

/** Validate the category editor form. */
export function validateCategoryForm(form: GiftCategoryFormState): string[] {
  const errors: string[] = [];
  if (!form.name.trim()) errors.push('Name is required.');
  if (!form.code.trim()) errors.push('Code is required.');
  if (form.sortOrder.trim() !== '') {
    const n = Number(form.sortOrder.trim());
    if (!Number.isInteger(n) || n < 0) errors.push('Sort order must be a whole number (0 or more).');
  }
  if (form.imageUrl.trim() !== '' && !looksLikeUrl(form.imageUrl.trim())) {
    errors.push('Image URL is not valid.');
  }
  return errors;
}

export function categoryFormToPayload(form: GiftCategoryFormState): Record<string, unknown> {
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    parentId: form.parentId.trim() === '' ? null : form.parentId.trim(),
    imageUrl: form.imageUrl.trim() === '' ? null : form.imageUrl.trim(),
    sortOrder: form.sortOrder.trim() === '' ? 0 : Number(form.sortOrder.trim()),
    isActive: form.isActive,
  };
}

/** A node in the category tree, built client-side from the flat list. */
export interface GiftCategoryNode extends GiftCategory {
  depth: number;
  children: GiftCategoryNode[];
}

/**
 * Build an ordered category tree from the flat list. Roots = parentId null OR a
 * parentId that isn't present in the set (defensive against orphans → surfaced at
 * the top rather than silently dropped). Sorted by sortOrder then name at each level.
 */
export function buildCategoryTree(list: GiftCategory[]): GiftCategoryNode[] {
  const byId = new Map<string, GiftCategoryNode>();
  for (const c of list) byId.set(c.id, { ...c, depth: 0, children: [] });

  const roots: GiftCategoryNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortLevel = (nodes: GiftCategoryNode[], depth: number) => {
    nodes.sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
    for (const n of nodes) {
      n.depth = depth;
      sortLevel(n.children, depth + 1);
    }
  };
  sortLevel(roots, 0);
  return roots;
}

/** Flatten a tree into a depth-ordered list (for rendering rows with indentation). */
export function flattenCategoryTree(nodes: GiftCategoryNode[]): GiftCategoryNode[] {
  const out: GiftCategoryNode[] = [];
  const walk = (ns: GiftCategoryNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Would setting `candidateParentId` as the parent of `nodeId` create a cycle? */
export function wouldCreateCycle(
  list: GiftCategory[],
  nodeId: string,
  candidateParentId: string,
): boolean {
  if (nodeId === candidateParentId) return true;
  const byId = new Map(list.map((c) => [c.id, c]));
  let cur: string | null = candidateParentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) break; // pre-existing cycle guard
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}
