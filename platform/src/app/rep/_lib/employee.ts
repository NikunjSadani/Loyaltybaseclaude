/* ─── Employee Rewards REP app — shared API types, mappers & pure helpers ──────
   The rep app is the employee-facing (SALES_* of an EMPLOYEE_REWARDS tenant) earner
   portal. It is a ~80% subset of the partner app and talks ONLY to the account-first
   `/api/rewards/employee/*` surface (proxied to the backend `/v1/rewards/employee/*`).

   Auth is the httpOnly `token` cookie (AF-6): same-origin fetches carry it and the
   proxy injects the Bearer header, so call sites use `authHeader()` (a no-op kept for
   compatibility) or the central `api` client. There is NO x-active-partner-id here —
   the employee is account-first (one account, no outlet switch).

   SHAPES ADAPTED FROM THE PINNED CONTRACT (verified against the real backend):
     • catalog item has NO `featured` / `dreamEligible` fields — the real member-safe
       select is { id, code, name, description, imageUrls[], pointsCost, redemptionMode,
       minRedemptionPoints, maxRedemptionPoints, stockQuantity, category, ... } enriched
       with `isAffordable` + `requiresConsent`; the response wraps `userBalance` and
       `pagination` (total lives under pagination, not top-level). The Home "featured"
       strip is therefore DERIVED (affordable / lowest-cost first) — see pickFeatured.
     • catalog image is `imageUrls: string[]`, not a single `imageUrl`.
     • redeem is SINGLE-STEP (no OTP confirm): one POST → { orderId, orderNumber,
       requiredPoints, status, message }. `sourceKey` (a fresh UUID per redeem intent,
       reused on retry) is REQUIRED for idempotency.
     • wallet summary carries `lifetimeExpired` on top of the partner shape.
──────────────────────────────────────────────────────────────────────────────── */

import {
  TransactionType,
  WalletBucket,
  type WalletBalance,
  type WalletTransaction,
} from '@/types';

/* ─── Wallet summary (GET /api/rewards/employee/wallet) ─────────────────────── */

export interface ApiEmployeeWallet {
  earnedPoints: number;
  lockedPoints: number;
  redeemablePoints: number;
  redeemedPoints: number;
  expiredPoints: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  lifetimeExpired: number;
  currency: string;
  conversionRate: number;
}

export function mapEmployeeBalance(api: ApiEmployeeWallet): WalletBalance {
  return {
    earned: api.earnedPoints,
    locked: api.lockedPoints,
    redeemable: api.redeemablePoints,
    redeemed: api.redeemedPoints,
    expired: api.expiredPoints,
    available: api.redeemablePoints,
  };
}

/* ─── Passbook (GET /api/rewards/employee/wallet/transactions) ───────────────
   Same row shape as the partner passbook (the backend reuses the shared builder). */

export interface ApiEmployeeTransaction {
  id: string;
  transactionType: string; // 'CREDIT_POINTS_EARNED' | 'DEBIT_REDEMPTION' | ...
  description: string;
  points: number;
  date: string; // ISO
  balanceType: string; // 'EARNED' | 'REDEEMED' | 'EXPIRED' | 'LOCKED'
  balanceAfter: number;
  referenceType: string | null;
  referenceId: string | null;
  fieldName?: string | null;
  narration?: string | null;
}

function mapTransactionType(apiType: string): TransactionType {
  if (apiType.startsWith('CREDIT')) return TransactionType.CREDIT;
  if (apiType.startsWith('DEBIT')) return TransactionType.DEBIT;
  if (apiType.includes('EXPIRE') || apiType.includes('EXPIR')) return TransactionType.EXPIRE;
  if (apiType.includes('UNLOCK')) return TransactionType.UNLOCK;
  if (apiType.includes('LOCK')) return TransactionType.LOCK;
  return TransactionType.CREDIT;
}

function mapBucket(balanceType: string): WalletBucket {
  if (balanceType === 'REDEEMED') return WalletBucket.REDEEMED;
  if (balanceType === 'EXPIRED') return WalletBucket.EXPIRED;
  if (balanceType === 'LOCKED') return WalletBucket.LOCKED;
  return WalletBucket.EARNED;
}

export function mapEmployeeTransaction(t: ApiEmployeeTransaction): WalletTransaction {
  // Credit rows lead with the resolved FIELD NAME as the header and show the raw
  // upload narration as a small sub-line — same treatment as the partner passbook.
  const hasFieldName = !!t.fieldName;
  const header = hasFieldName ? (t.fieldName as string) : t.description;
  const narration = hasFieldName && t.narration ? t.narration : undefined;

  return {
    id: t.id,
    walletId: 'w1',
    userId: 'u1',
    type: mapTransactionType(t.transactionType),
    bucket: mapBucket(t.balanceType),
    amount: t.points,
    balanceAfter: t.balanceAfter,
    description: header,
    schemeId: t.referenceId,
    invoiceId: null,
    kpiLabel: t.fieldName ?? undefined,
    narration,
    reversedById: null,
    reversalReason: null,
    createdAt: new Date(t.date),
  };
}

/* ─── Catalogue (GET /api/rewards/employee/catalog) ─────────────────────────── */

export interface ApiEmployeeCatalogItem {
  id: string;
  code?: string | null;
  name: string;
  description?: string | null;
  imageUrls?: string[] | null;
  pointsCost: number;
  redemptionMode?: string | null; // 'GIFT_CARD' | 'PHYSICAL_GIFT' | ...
  minRedemptionPoints?: number | null;
  maxRedemptionPoints?: number | null;
  stockQuantity?: number | null;
  termsAndConditions?: string | null;
  category?: string | null;
  isAffordable?: boolean;
  requiresConsent?: boolean;
}

export interface EmployeeCatalogResponse {
  items: ApiEmployeeCatalogItem[];
  userBalance: number;
  pagination: { page: number; limit: number; total: number; pages: number };
}

export interface CatalogItem {
  id: string;
  code: string;
  name: string;
  description: string;
  category: string;
  imageUrl: string | null;
  pointsCost: number;
  redemptionMode: string | null;
  isAffordable: boolean;
  requiresConsent: boolean;
  inStock: boolean;
}

export function mapCatalogItem(item: ApiEmployeeCatalogItem): CatalogItem {
  return {
    id: item.id,
    code: item.code ?? '',
    name: item.name,
    description: item.description ?? '',
    category: item.category ?? 'Rewards',
    imageUrl: item.imageUrls?.[0] ?? null,
    pointsCost: item.pointsCost,
    redemptionMode: item.redemptionMode ?? null,
    isAffordable: item.isAffordable ?? false,
    requiresConsent: item.requiresConsent === true,
    // Null stock = unlimited; 0 = out of stock.
    inStock: item.stockQuantity == null || item.stockQuantity > 0,
  };
}

/* ─── Orders (GET /api/rewards/employee/orders[/:id]) ───────────────────────── */

export interface ApiEmployeeOrder {
  id: string;
  orderNumber?: string;
  reward?: { id: string; name: string; imageUrls?: string[] } | null;
  status: string;
  redemptionMode?: string | null;
  totalPointsCost: number;
  quantity?: number;
  voucherCode?: string | null;
  voucherProvider?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  logisticsPartner?: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  returnedAt?: string | null;
}

/* ─── Track (GET /api/rewards/employee/orders/:id/track) ────────────────────── */

export interface EmployeeTrack {
  orderId: string;
  orderNumber?: string;
  status: string;
  reward?: { id: string; name: string; imageUrls?: string[] } | null;
  quantity?: number;
  logisticsPartner?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  timeline: Array<{ fromStatus: string | null; toStatus: string; createdAt: string }>;
}

/* ─── Redeem (POST /api/rewards/employee/redeem) ────────────────────────────── */

export interface EmployeeRedeemPayload {
  rewardId: string;
  sourceKey: string; // REQUIRED idempotency key — a fresh UUID per redeem intent.
  quantity?: number;
  amount?: number; // FREE_AMOUNT vouchers only.
  deliveryAddress?: {
    name: string;
    mobile: string;
    address: string;
    city: string;
    state: string;
    pincode: string;
  };
  consent?: boolean; // VENDOR-sourced items only.
}

export interface EmployeeRedeemResult {
  orderId: string;
  orderNumber: string;
  requiredPoints: number;
  status: string;
  message: string;
}

/* ─── Profile (GET /api/auth/me → user + salesUser) ─────────────────────────── */

export interface EmployeeMe {
  user?: {
    name?: string | null;
    phone?: string | null;
    salesUser?: {
      id?: string;
      employeeCode?: string | null;
      region?: string | null;
      zone?: string | null;
      reportingTo?: { name?: string | null; designation?: string | null; phone?: string | null } | null;
    } | null;
  };
}

/* ─── Pure helpers (unit-tested in __tests__/employee.test.ts) ───────────────── */

/** INR formatting used across the rep app (points shown as pts; cash rail is N/A for employees). */
export function formatInr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * Affordability of a reward given the employee's redeemable balance. Returns whether it
 * is affordable and, if not, the point shortfall. Mirrors the backend `isAffordable`
 * computation (balance >= cost) so the client never contradicts the server, but also
 * yields the shortfall for the "Need N more pts" copy. Negative/NaN inputs are clamped.
 */
export function affordability(
  balance: number,
  cost: number,
): { affordable: boolean; shortfall: number } {
  const b = Number.isFinite(balance) ? Math.max(0, balance) : 0;
  const c = Number.isFinite(cost) ? Math.max(0, cost) : 0;
  return { affordable: b >= c, shortfall: Math.max(0, c - b) };
}

/**
 * Derive the Home "featured" strip. The backend catalogue carries no featured/dream flag
 * (contract adaptation), so we surface the most redeemable items: affordable ones first
 * (cheapest within reach), then the next cheapest to aspire to — a stable, meaningful
 * strip straight from the real data. Returns at most `limit` items.
 */
export function pickFeatured(items: CatalogItem[], limit = 6): CatalogItem[] {
  const inStock = items.filter((i) => i.inStock);
  const affordable = inStock
    .filter((i) => i.isAffordable)
    .sort((a, b) => b.pointsCost - a.pointsCost); // best (priciest you can afford) first
  const aspirational = inStock
    .filter((i) => !i.isAffordable)
    .sort((a, b) => a.pointsCost - b.pointsCost); // nearest-reach next
  return [...affordable, ...aspirational].slice(0, limit);
}
