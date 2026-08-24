/* ─── VENDOR portal — shared types + PURE helpers ─────────────────────────────
 * The hard-scoped VENDOR persona (design §2). A vendor sees ONLY its own data:
 * its catalogue items (with moderation state) and the redemption orders for those
 * items (shipping-only PII). It can price + submit items, and advance its orders
 * through PROCESSING → DISPATCHED → DELIVERED. It can NEVER cancel / return /
 * refund — every wallet-touching edge stays Gifsy-only (design §12).
 *
 * Everything here is PURE (no fetch, no DOM) so the editor validation, the
 * material-edit re-approval rule, the restricted transition edge-map, and the
 * moderation badges are all unit-testable without rendering — mirroring
 * src/lib/gift-catalogue.ts and src/lib/gift-orders.ts.
 *
 * Design source of truth: platform/docs/plans/GIFT-CATALOGUE-AND-DISPATCH-DESIGN.md
 * (§1 decisions 6/7/12/13/15/16, §2 personas, §5 dispatch, §12 hardening).
 *
 * Wire contract consumed by the vendor pages (FE `/api/*` → backend `/v1/*`),
 * VENDOR-role, backend scopes by vendorId + the grant's clientId:
 *   GET   /api/vendor/me                        → { vendor:{id,name,status}, clientId, approvalPolicy }
 *   GET   /api/vendor/catalogue                 → { items: VendorCatalogueItem[] }
 *   GET   /api/vendor/catalogue/:id             → flat VendorCatalogueDetail
 *   POST  /api/vendor/catalogue                 (create — VendorItemPayload)
 *   PATCH /api/vendor/catalogue/:id             (edit   — VendorItemPayload)
 *   POST  /api/vendor/catalogue/upload          (multipart "file" — Excel bulk upload)
 *   GET   /api/vendor/catalogue/template        (xlsx blob — ASSUMED, flag for BE)
 *   GET   /api/vendor/categories                (shared taxonomy — ASSUMED, flag for BE)
 *   GET   /api/vendor/orders                    → { items: GiftOrderSummary[] }
 *   GET   /api/vendor/orders/:id                → flat GiftOrderDetail (incl. delivery PII)
 *   PATCH /api/vendor/orders/:id/fulfilment     (channel / partner / tracking / voucher)
 *   POST  /api/vendor/orders/:id/transition     (RESTRICTED — PROCESSING/DISPATCHED/DELIVERED only)
 * ─────────────────────────────────────────────────────────────────────────── */

import { paiseToRupees } from '@/lib/money';
import {
  type GiftModerationStatus,
  type GiftRedemptionMode,
  type GiftFulfilmentChannel,
  parseRupeesToPaise,
  parseImageUrls,
} from '@/lib/gift-catalogue';
import type { GiftOrderStatus } from '@/lib/gift-orders';

// Re-export the shared moderation/redemption/fulfilment enums so the vendor pages
// import them from one place.
export type { GiftModerationStatus, GiftRedemptionMode, GiftFulfilmentChannel };

// ── Vendor identity + approval policy ──────────────────────────────────────────

export type VendorStatus = 'ACTIVE' | 'SUSPENDED';

/** Per-grant moderation policy (§1 decision 7). v1 implements AUTO_LIVE + GIFSY_APPROVE;
 *  TENANT_APPROVE / EITHER are enum-ready for a later tenant-side moderation UI. */
export type GiftApprovalPolicy = 'AUTO_LIVE' | 'GIFSY_APPROVE' | 'TENANT_APPROVE' | 'EITHER';

/** GET /api/vendor/me → the logged-in vendor's identity + the grant context (one tenant
 *  per vendor login in v1, §1 decision 12). */
export interface VendorMe {
  vendor: { id: string; name: string; status: VendorStatus };
  /** The single tenant this vendor login is pinned to. */
  clientId: string;
  clientName?: string | null;
  approvalPolicy: GiftApprovalPolicy;
}

export const APPROVAL_POLICY_LABEL: Record<GiftApprovalPolicy, string> = {
  AUTO_LIVE: 'Auto-publish',
  GIFSY_APPROVE: 'Gifsy approval',
  TENANT_APPROVE: 'Tenant approval',
  EITHER: 'Gifsy or tenant approval',
};

export function approvalPolicyLabel(policy?: GiftApprovalPolicy | null): string {
  if (!policy) return '—';
  return APPROVAL_POLICY_LABEL[policy] ?? policy;
}

/** Under AUTO_LIVE a new/edited item goes live immediately. Under every other policy
 *  it needs a moderation pass — so a material edit re-submits it for approval. */
export function policyRequiresApproval(policy?: GiftApprovalPolicy | null): boolean {
  return policy != null && policy !== 'AUTO_LIVE';
}

/** The inline note shown on the editor: what happens to this item on save, given the
 *  grant's approval policy. Honest about the re-approval consequence of a material edit. */
export function reapprovalNote(policy?: GiftApprovalPolicy | null): string {
  if (policy === 'AUTO_LIVE') {
    return 'Your items publish automatically — changes go live to members immediately, no review needed.';
  }
  return 'New items and any material change (name, price, images or category) are submitted for Gifsy approval. While an item is pending review it is hidden from members until approved.';
}

// ── Moderation badge (member-visibility state of a catalogue row) ───────────────

export const VENDOR_MODERATION_LABEL: Record<GiftModerationStatus, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const VENDOR_MODERATION_BADGE: Record<GiftModerationStatus, string> = {
  DRAFT: 'bg-gray-50 text-gray-500 border-gray-200',
  PENDING: 'bg-amber-50 text-amber-700 border-amber-100',
  APPROVED: 'bg-green-50 text-green-700 border-green-100',
  REJECTED: 'bg-red-50 text-red-600 border-red-100',
};

export function moderationLabel(s?: GiftModerationStatus | string | null): string {
  if (!s) return '—';
  return VENDOR_MODERATION_LABEL[s as GiftModerationStatus] ?? String(s);
}

export function moderationBadgeClass(s?: GiftModerationStatus | string | null): string {
  return VENDOR_MODERATION_BADGE[s as GiftModerationStatus] ?? VENDOR_MODERATION_BADGE.DRAFT;
}

// ── Catalogue item shapes ──────────────────────────────────────────────────────

/** GET /api/vendor/catalogue → { items: VendorCatalogueItem[] } */
export interface VendorCatalogueItem {
  id: string;
  name: string;
  /**
   * The owning vendor id. The BE already scopes the list to this vendor, so it is
   * usually omitted; when present the FE uses it as a cheap defence-in-depth guard
   * (drop a row that isn't this vendor's — see the catalogue page) against an API slip.
   */
  vendorId?: string | null;
  categoryId: string | null;
  categoryName?: string | null;
  /** The vendor-set ₹ selling price (paise) — this IS the order value at redeem (§1.14). */
  sellingValuePaise: number;
  /** MRP is REQUIRED on vendor items (§12 price-bounds hardening). */
  mrpPaise: number | null;
  /** Derived points cost, shown when the BE returns it (₹ → points via tenant rate). */
  pointsCost?: number | null;
  moderationStatus: GiftModerationStatus;
  /** ACTIVE / INACTIVE listing state (independent of moderationStatus). */
  status?: string | null;
  redemptionMode?: GiftRedemptionMode | null;
  fulfilmentChannel?: GiftFulfilmentChannel | null;
  /** null = unlimited stock. */
  stockQuantity: number | null;
  imageUrls?: string[];
  /** Set when moderationStatus === 'REJECTED' — the reviewer's reason. */
  moderationReason?: string | null;
  updatedAt?: string | null;
}

/** GET /api/vendor/catalogue/:id → flat detail. */
export interface VendorCatalogueDetail extends VendorCatalogueItem {
  description: string;
  termsAndConditions?: string;
}

/** The editable form shape (rupees at the human edge; converted to paise on submit). */
export interface VendorItemFormState {
  name: string;
  categoryId: string;
  /** ₹ selling price as typed (→ sellingValuePaise). */
  sellingRupees: string;
  /** ₹ MRP as typed (→ mrpPaise). Required. */
  mrpRupees: string;
  description: string;
  redemptionMode: GiftRedemptionMode;
  fulfilmentChannel: GiftFulfilmentChannel;
  /** blank = unlimited; a number string otherwise. */
  stockQuantity: string;
  /** newline- or comma-separated image URLs; serialised to string[]. */
  imageUrls: string;
}

export const EMPTY_VENDOR_ITEM_FORM: VendorItemFormState = {
  name: '',
  categoryId: '',
  sellingRupees: '',
  mrpRupees: '',
  description: '',
  redemptionMode: 'PHYSICAL_GIFT',
  fulfilmentChannel: 'BRAND',
  stockQuantity: '',
  imageUrls: '',
};

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s);
}

/**
 * Validate the vendor catalogue-item editor. Returns human-readable errors (empty = valid).
 * Rules (design §12 price-bounds hardening):
 *  - name + category required
 *  - selling price required, > ₹0
 *  - MRP REQUIRED, > ₹0
 *  - selling price must NOT exceed MRP (a mis-priced gift inflates the outlet's 194R base —
 *    a tax-integrity vector, so we hard-block it client-side; the BE remains authoritative)
 *  - stock, if present, a whole number ≥ 0
 *  - image URLs must be valid http(s)
 */
export function validateVendorItemForm(form: VendorItemFormState): string[] {
  const errors: string[] = [];
  if (!form.name.trim()) errors.push('Name is required.');
  if (!form.categoryId.trim()) errors.push('Category is required.');

  const selling = parseRupeesToPaise(form.sellingRupees);
  if (selling == null) errors.push('Selling price must be a valid amount in ₹.');
  else if (selling <= 0) errors.push('Selling price must be greater than ₹0.');

  const mrp = parseRupeesToPaise(form.mrpRupees);
  if (mrp == null) errors.push('MRP is required and must be a valid amount in ₹.');
  else if (mrp <= 0) errors.push('MRP must be greater than ₹0.');

  if (selling != null && mrp != null && selling > mrp) {
    errors.push('Selling price cannot exceed the MRP.');
  }

  if (form.stockQuantity.trim() !== '') {
    const q = Number(form.stockQuantity.trim());
    if (!Number.isInteger(q) || q < 0) {
      errors.push('Stock quantity must be a whole number (0 or more), or blank for unlimited.');
    }
  }

  for (const url of parseImageUrls(form.imageUrls)) {
    if (!looksLikeUrl(url)) {
      errors.push(`Image URL is not valid: ${url}`);
      break;
    }
  }
  return errors;
}

/** Build the create/edit JSON body from a validated form. */
export function vendorItemFormToPayload(form: VendorItemFormState): Record<string, unknown> {
  return {
    name: form.name.trim(),
    categoryId: form.categoryId.trim(),
    sellingValuePaise: parseRupeesToPaise(form.sellingRupees),
    mrpPaise: parseRupeesToPaise(form.mrpRupees),
    description: form.description.trim(),
    redemptionMode: form.redemptionMode,
    fulfilmentChannel: form.fulfilmentChannel,
    stockQuantity: form.stockQuantity.trim() === '' ? null : Number(form.stockQuantity.trim()),
    imageUrls: parseImageUrls(form.imageUrls),
  };
}

/** Hydrate the editor from a detail record (paise → rupee string, array → textarea). */
export function vendorDetailToForm(d: VendorCatalogueDetail): VendorItemFormState {
  return {
    name: d.name ?? '',
    categoryId: d.categoryId ?? '',
    sellingRupees: d.sellingValuePaise != null ? String(paiseToRupees(d.sellingValuePaise)) : '',
    mrpRupees: d.mrpPaise != null ? String(paiseToRupees(d.mrpPaise)) : '',
    description: d.description ?? '',
    redemptionMode: (d.redemptionMode as GiftRedemptionMode) ?? 'PHYSICAL_GIFT',
    fulfilmentChannel: (d.fulfilmentChannel as GiftFulfilmentChannel) ?? 'BRAND',
    stockQuantity: d.stockQuantity == null ? '' : String(d.stockQuantity),
    imageUrls: (d.imageUrls ?? []).join('\n'),
  };
}

/**
 * A "material" edit = a change to name / selling price / images / category (design §12
 * re-moderation rule). Comparing the ORIGINAL detail against the edited form tells the
 * editor whether to warn that saving will re-submit an already-APPROVED item for review.
 */
export function isMaterialEdit(original: VendorCatalogueDetail, form: VendorItemFormState): boolean {
  const orig = vendorDetailToForm(original);
  if (orig.name.trim() !== form.name.trim()) return true;
  if (orig.categoryId.trim() !== form.categoryId.trim()) return true;
  // Compare price numerically (paise) so "1499" vs "1499.00" isn't a false positive.
  if (parseRupeesToPaise(orig.sellingRupees) !== parseRupeesToPaise(form.sellingRupees)) return true;
  // Compare the normalised image URL list, order-sensitive.
  const a = parseImageUrls(orig.imageUrls);
  const b = parseImageUrls(form.imageUrls);
  if (a.length !== b.length || a.some((u, i) => u !== b[i])) return true;
  return false;
}

/**
 * Should the editor warn the vendor that saving re-submits this item for approval?
 * True only when: editing an already-APPROVED item, under a non-AUTO policy, AND the
 * change is material. (A DRAFT/PENDING/REJECTED item is not "live", so no re-approval
 * warning is needed — it is going to review regardless.)
 */
export function willResubmitForApproval(
  original: VendorCatalogueDetail | null,
  form: VendorItemFormState,
  policy: GiftApprovalPolicy | null | undefined,
): boolean {
  if (!original) return false;
  if (!policyRequiresApproval(policy)) return false;
  if (original.moderationStatus !== 'APPROVED') return false;
  return isMaterialEdit(original, form);
}

// ── Restricted vendor order-transition edge-map ────────────────────────────────

/**
 * The vendor's ALLOWED forward transitions. The vendor is the sole fulfiller of its own
 * items' orders (§1 decision 13) but may ONLY move an order forward through the fulfilment
 * lane — PROCESSING → DISPATCHED → DELIVERED. Every wallet-/value-touching edge
 * (CANCELLED / RETURNED / FAILED / REVERSED → refund) is Gifsy-only (§12) and is NEVER
 * offered here. Compare with CONSOLE_NEXT_STATUS in gift-orders.ts (the Gifsy superset).
 */
export const VENDOR_NEXT_STATUS: Record<string, GiftOrderStatus[]> = {
  PENDING: ['PROCESSING'],
  CONFIRMED: ['PROCESSING'],
  PROCESSING: ['DISPATCHED'],
  DISPATCHED: ['DELIVERED'],
  // DELIVERED is terminal FOR THE VENDOR (a return/reversal is Gifsy-only).
};

/** The set of statuses a vendor is ever permitted to transition INTO (task guard). */
export const VENDOR_ALLOWED_TARGET_STATUSES: GiftOrderStatus[] = ['PROCESSING', 'DISPATCHED', 'DELIVERED'];

export function vendorNextStatusOptions(status?: string | null): GiftOrderStatus[] {
  if (!status) return [];
  return VENDOR_NEXT_STATUS[status] ?? [];
}

/** For the vendor, a status is terminal when it offers no forward fulfilment edge. */
export function isVendorTerminal(status?: string | null): boolean {
  return vendorNextStatusOptions(status).length === 0;
}

/** True only for the three fulfilment targets — a vendor must never be offered anything else. */
export function isVendorAllowedTarget(to: string): boolean {
  return (VENDOR_ALLOWED_TARGET_STATUSES as string[]).includes(to);
}

export interface VendorConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * Confirm copy for a vendor status change. Honest labels: "Queued ≠ Dispatched" — moving
 * to PROCESSING only acknowledges the order, DISPATCHED means it has actually shipped,
 * DELIVERED means the member has it. No wallet/refund language (vendors can't touch money).
 */
export function vendorConfirmCopy(to: string): VendorConfirmCopy {
  switch (to) {
    case 'PROCESSING':
      return {
        title: 'Start processing this order?',
        description:
          'Marks the order as being prepared. The member sees it is being worked on — this is not yet a dispatch.',
        confirmLabel: 'Start processing',
      };
    case 'DISPATCHED':
      return {
        title: 'Mark this order dispatched?',
        description:
          'Confirms the gift has actually shipped. The member is notified with the tracking details you saved. Only mark dispatched once it has really left — not while it is still queued.',
        confirmLabel: 'Confirm dispatch',
      };
    case 'DELIVERED':
      return {
        title: 'Mark this order delivered?',
        description:
          'Confirms the member has received the gift. This completes the order.',
        confirmLabel: 'Confirm delivery',
      };
    default:
      return {
        title: `Move order to ${to}?`,
        description: 'Advance this order to the next fulfilment stage.',
        confirmLabel: 'Confirm',
      };
  }
}

// ── 403 / suspended detection ──────────────────────────────────────────────────

/**
 * Detects a genuine "account suspended / grant revoked" state so the vendor pages can show
 * the blocked panel (instead of a generic error) when a suspended vendor — or a revoked
 * grant — 403s mid-session.
 *
 * PRECISE signal first: a real HTTP 403 from a scoped vendor endpoint. A vendor has no
 * partial-permission read of its OWN catalogue/orders, so a 403 there means access was
 * removed — pass the api-client's `res.status` in for this.
 *
 * The message fallback (when the status isn't threaded through) is NARROWED to real
 * suspension/revocation wording. It deliberately no longer matches a bare
 * "permission"/"forbidden"/"403" substring, so an unrelated error that merely mentions
 * those words can't masquerade as a full account-suspended panel (which had no recovery).
 */
export function isBlockedError(error?: string | null, status?: number): boolean {
  if (status === 403) return true;
  if (!error) return false;
  return /suspend|revoked|deactivat|no longer (active|have access)|access (has been )?removed/i.test(error);
}
