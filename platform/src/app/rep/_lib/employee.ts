/* ─── Employee Rewards REP app — shared API types, mappers & pure helpers ──────
   The rep app is the employee-facing (SALES_* of an EMPLOYEE_REWARDS tenant) earner
   portal. It is a ~80% subset of the partner app and talks ONLY to the account-first
   `/api/rewards/employee/*` surface (proxied to the backend `/v1/rewards/employee/*`).

   Auth is the httpOnly `token` cookie (AF-6): same-origin fetches carry it and the
   proxy injects the Bearer header, so call sites use `authHeader()` (a no-op kept for
   compatibility) or the central `api` client. There is NO x-active-partner-id here —
   the employee is account-first (one account, no outlet switch).

   SHAPES ADAPTED FROM THE PINNED CONTRACT (verified against the real backend):
     • catalog item carries { id, code, name, description, imageUrls[], pointsCost,
       redemptionMode, minRedemptionPoints, maxRedemptionPoints, stockQuantity, category,
       ... } enriched with `isAffordable` + `requiresConsent`, and (Wave 4) `featured` +
       `dreamEligible` flags; the response wraps `userBalance` and `pagination` (total
       lives under pagination, not top-level). `dreamEligible` gates the "Set as Dream
       Reward" control; the Home "Rewards for you" strip stays DERIVED (affordable /
       lowest-cost first) via pickFeatured — `featured` is surfaced but not the sole sort.
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
  featured?: boolean; // Wave 4: operator-curated "featured" flag.
  dreamEligible?: boolean; // Wave 4: may this item be chosen as a Dream Reward?
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
  featured: boolean;
  dreamEligible: boolean;
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
    featured: item.featured === true,
    dreamEligible: item.dreamEligible === true,
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

/* ─── Contests (GET /api/rewards/employee/contests) ─────────────────────────────
   The backend ALREADY filters to only the ACTIVE/SCHEDULED contests this employee is
   eligible for (by role/region) — the FE does NOT filter further, it just displays
   what comes back. eligibleRoleCodes/eligibleRegions ride along for completeness but
   are not surfaced (the filter is server-side). ───────────────────────────────── */

export interface ApiEmployeeContest {
  id: string;
  name: string;
  bannerUrl: string | null;
  description: string | null;
  startDate: string; // ISO
  endDate: string; // ISO
  bonusPoints: number;
  status: 'ACTIVE' | 'SCHEDULED';
  eligibleRoleCodes: string[];
  eligibleRegions: string[];
}

export interface Contest {
  id: string;
  name: string;
  bannerUrl: string | null;
  description: string;
  startDate: string;
  endDate: string;
  bonusPoints: number;
  status: 'ACTIVE' | 'SCHEDULED';
}

export function mapContest(api: ApiEmployeeContest): Contest {
  return {
    id: api.id,
    name: api.name,
    bannerUrl: api.bannerUrl ?? null,
    description: api.description ?? '',
    startDate: api.startDate,
    endDate: api.endDate,
    // Defensive clamp — points are display copy ("Win N pts"); never show a negative/NaN.
    bonusPoints: Number.isFinite(api.bonusPoints) ? Math.max(0, api.bonusPoints) : 0,
    // Anything the backend doesn't label SCHEDULED is treated as live/ACTIVE.
    status: api.status === 'SCHEDULED' ? 'SCHEDULED' : 'ACTIVE',
  };
}

/* ─── Dream Reward (GET/PUT /api/rewards/employee/dream) ────────────────────────
   The employee picks ONE aspirational reward; the backend returns the resolved dream
   plus progress + a forecast ETA computed from the employee's real earn history.
     • `dreamReward` is null when none is chosen yet.
     • `forecastDate` is null when the backend cannot forecast (e.g. too little earn
       history / a zero earn rate) — the FE HIDES the ETA line rather than faking one.
     • `reached` is true once the redeemable balance covers the dream's cost.
   PUT body { rewardId: string | null } sets (or clears) the dream and returns the SAME
   resolved shape (so the caller can reflect progress immediately); a non-eligible /
   non-visible rewardId is a 400, surfaced gracefully at the call site. ──────────── */

export interface ApiEmployeeDreamReward {
  id: string;
  name: string;
  imageUrl: string | null;
  pointsCost: number;
}

export interface ApiEmployeeDream {
  dreamReward: ApiEmployeeDreamReward | null;
  pointsRequired: number;
  pointsRemaining: number;
  redeemablePoints: number;
  monthlyEarnRate: number;
  forecastDate: string | null; // ISO, or null when not forecastable.
  reached: boolean;
}

export interface Dream {
  reward: ApiEmployeeDreamReward | null;
  pointsRequired: number;
  pointsRemaining: number;
  redeemablePoints: number;
  monthlyEarnRate: number;
  forecastDate: string | null;
  reached: boolean;
}

export function mapDream(api: ApiEmployeeDream): Dream {
  // Points are display + progress-ring inputs — never let a negative/NaN through.
  const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
  return {
    reward: api.dreamReward
      ? {
          id: api.dreamReward.id,
          name: api.dreamReward.name,
          imageUrl: api.dreamReward.imageUrl ?? null,
          pointsCost: clamp(api.dreamReward.pointsCost),
        }
      : null,
    pointsRequired: clamp(api.pointsRequired),
    pointsRemaining: clamp(api.pointsRemaining),
    redeemablePoints: clamp(api.redeemablePoints),
    monthlyEarnRate: clamp(api.monthlyEarnRate),
    forecastDate: api.forecastDate ?? null,
    reached: api.reached === true,
  };
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

/** The IST calendar day / short-month / year of an instant, as display primitives. */
function istDateParts(
  date: string | Date,
): { day: number; month: string; year: string } | null {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  // en-GB + Asia/Kolkata: day with NO leading zero ("1"), month short ("Nov"), 4-digit year.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: Number(get('day')), month: get('month'), year: get('year') };
}

/**
 * Human date range for a contest, pinned to IST, collapsing the shared month/year:
 *   same month + year → "1 – 30 Nov 2026"
 *   same year         → "1 Nov – 5 Dec 2026"
 *   spanning years    → "1 Nov 2026 – 5 Jan 2027"
 * Returns '' when BOTH ends are missing/invalid; if only one is valid, that single
 * date is shown — so a contest line never renders "Invalid Date".
 */
export function formatContestDateRange(start: string | Date, end: string | Date): string {
  const s = istDateParts(start);
  const e = istDateParts(end);
  if (!s && !e) return '';
  if (!s) return `${e!.day} ${e!.month} ${e!.year}`;
  if (!e) return `${s.day} ${s.month} ${s.year}`;
  if (s.year !== e.year) {
    return `${s.day} ${s.month} ${s.year} – ${e.day} ${e.month} ${e.year}`;
  }
  if (s.month !== e.month) {
    return `${s.day} ${s.month} – ${e.day} ${e.month} ${e.year}`;
  }
  return `${s.day} – ${e.day} ${e.month} ${e.year}`;
}

/**
 * Badge copy + variant for a contest status. ACTIVE reads as a live contest, SCHEDULED
 * as an upcoming one; the variant strings are valid `BadgeVariant` members so the page
 * can hand them straight to <Badge>. Any unrecognised status falls back to live.
 */
export function contestStatusBadge(
  status: string,
): { label: string; variant: 'success' | 'info' } {
  return status === 'SCHEDULED'
    ? { label: 'Upcoming', variant: 'info' }
    : { label: 'Live', variant: 'success' };
}

/* ─── Dream Reward progress + forecast helpers (unit-tested) ─────────────────── */

/**
 * Clamp the ratio a/b to an integer 0–100 percent (progress-ring / bar fill). A
 * non-positive or non-finite denominator → 0 (nothing to be "percent of"); an `a`
 * at or above `b` saturates at 100 (never over-fills the ring).
 */
export function pct(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((a / b) * 100)));
}

/**
 * Project a completion date from a remaining-points balance and an assumed monthly
 * earn rate: `from + ceil(remaining / ratePerMonth × 30)` days.
 *   • remaining ≤ 0 → already reached: returns a copy of `from` (today).
 *   • ratePerMonth ≤ 0 / non-finite → cannot forecast: returns null (the UI then hides
 *     the ETA rather than faking one).
 * `from` is injectable so callers/tests stay deterministic (never hardcode a clock —
 * pass the reference instant in). Pure: does not mutate `from`.
 */
export function forecastFromRate(
  remaining: number,
  ratePerMonth: number,
  from: Date = new Date(),
): Date | null {
  const rem = Number.isFinite(remaining) ? remaining : 0;
  if (rem <= 0) return new Date(from.getTime());
  if (!Number.isFinite(ratePerMonth) || ratePerMonth <= 0) return null;
  const days = Math.ceil((rem / ratePerMonth) * 30);
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Whole days a projected completion lands AFTER a target date (0 when on time or
 * early). Either side null/invalid → 0 (cannot judge lateness → treat as on time).
 */
export function daysLate(projected: Date | null, target: Date | null): number {
  if (!projected || !target) return 0;
  const p = projected.getTime();
  const t = target.getTime();
  if (Number.isNaN(p) || Number.isNaN(t)) return 0;
  const diffMs = p - t;
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * On-time status for the "Plan your finish" panel: compares a projected completion to
 * a chosen target date. `onTime` when the projection is on or before the target, else
 * the whole-day overshoot. A null projection (unforecastable) or null target reads as
 * on time (nothing to be late against). The page maps this to a green / red badge.
 */
export function onTimeBadge(
  projected: Date | null,
  target: Date | null,
): { onTime: boolean; daysLate: number } {
  const late = daysLate(projected, target);
  return { onTime: late === 0, daysLate: late };
}

/**
 * Add whole calendar months to a date (for the "1 / 2 / 3 months" target presets).
 * Uses setMonth so month-length overflow is handled by the platform (e.g. 31 Jan +1
 * month → early Mar). Pure: returns a new Date, does not mutate `from`.
 */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

/** "Mon YYYY" (e.g. "Nov 2026") in IST — the compact ETA label on the Home hero. */
export function formatMonthYear(date: string | Date | null | undefined): string {
  if (date == null) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/* ─── Team manager-rollup (GET /api/rewards/employee/team[?managerId=]) ──────────
   A manager employee's downline, served by the account-first team endpoint. Passing
   no managerId returns the CALLER's own direct team; passing a manager's salesUserId
   (a row with isManager:true) drills into that sub-team — the backend enforces that
   the target is inside the caller's subtree (a cross-subtree id is a 403/400, handled
   gracefully at the call site). A caller with no team comes back as
   { isManager:false, members:[] } → the FE shows a friendly "no team yet" state.

   The FE does NOT recompute rollup/achievement — those are server-authoritative. The
   mappers here only DEFENSIVELY clamp display numbers (never show a negative/NaN) and
   SORT the leaderboard (achievement desc, nulls last) so the view is deterministic. ─ */

export interface ApiTeamRoot {
  salesUserId: string;
  name: string;
  employeeCode: string;
  roleName: string;
}

export interface ApiTeamRollup {
  memberCount: number;
  earnedThisMonth: number;
  redeemedThisMonth: number;
  avgAchievementPct: number;
  onTrackCount: number;
}

export type TeamTrend = 'up' | 'down' | 'flat';

export interface ApiTeamMember {
  salesUserId: string;
  name: string;
  employeeCode: string;
  roleName: string;
  region: string;
  isManager: boolean;
  directReportCount: number;
  teamSize: number;
  pointsBalance: number;
  earnedThisMonth: number;
  redeemedThisMonth: number;
  targetPoints: number | null;
  achievedPct: number | null;
  trend: TeamTrend;
}

export interface ApiTeamMonth {
  monthKey: string;
  label: string;
  earned: number;
  redeemed: number;
}

export interface ApiTeamResponse {
  root: ApiTeamRoot | null;
  isManager: boolean;
  rollup: ApiTeamRollup;
  members: ApiTeamMember[];
  monthly: ApiTeamMonth[];
}

/** The mapped, sorted, display-safe team the TeamView renders. Same shape as the API
 *  response, but with clamped numbers, a sorted leaderboard, and non-null collections. */
export interface Team {
  root: ApiTeamRoot | null;
  isManager: boolean;
  rollup: ApiTeamRollup;
  members: ApiTeamMember[];
  monthly: ApiTeamMonth[];
}

/**
 * Clamp a percent to an integer 0–100 — for the progress-bar FILL WIDTH ONLY (a bar can't
 * exceed 100% wide). It must NOT be used for the displayed number, the headline avg, or the
 * sort key: achievement is intentionally UNCAPPED (a 250% over-achiever must read "250%", rank
 * above a 100% peer, and lift the team average). null / non-finite → 0; negatives floor to 0.
 */
export function clampPercent(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** A percent as a DISPLAY/sort value: non-negative integer, UNCAPPED (null preserved). */
export function displayPercent(n: number | null | undefined): number | null {
  if (n == null) return null;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

/**
 * Icon direction + copy + tone for a member's month-over-month trend. `direction`
 * selects the arrow (the page maps it to a lucide icon), `tone` selects the colour.
 * Anything unrecognised reads as a flat/steady trend.
 */
export function trendMeta(
  trend: string | null | undefined,
): { direction: TeamTrend; label: string; tone: TeamTrend } {
  if (trend === 'up') return { direction: 'up', label: 'Trending up', tone: 'up' };
  if (trend === 'down') return { direction: 'down', label: 'Trending down', tone: 'down' };
  return { direction: 'flat', label: 'Steady', tone: 'flat' };
}

/**
 * Sort a member list for the leaderboard: highest achievement first, NULLS LAST (an
 * un-targeted member sinks below everyone with a measured achievement). Ties break by
 * earned-this-month (desc) then name (asc) so the order is stable and deterministic.
 * Pure: returns a new array, does not mutate the input.
 */
export function sortByAchievement<
  T extends { achievedPct: number | null; earnedThisMonth?: number; name?: string },
>(members: T[]): T[] {
  return [...members].sort((a, b) => {
    const ap = a.achievedPct;
    const bp = b.achievedPct;
    if (ap == null && bp == null) {
      // both un-targeted → fall straight to the tiebreak
    } else if (ap == null) {
      return 1; // a sinks
    } else if (bp == null) {
      return -1; // b sinks
    } else if (bp !== ap) {
      return bp - ap; // higher achievement first
    }
    const ae = a.earnedThisMonth ?? 0;
    const be = b.earnedThisMonth ?? 0;
    if (be !== ae) return be - ae;
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
}

/**
 * The y-axis maximum for the earned-vs-redeemed chart: the largest single bar value
 * across all months (earned OR redeemed), with a floor of 1 so an all-zero team still
 * yields a valid (flat) chart rather than a divide-by-zero. Non-finite values ignored.
 */
export function teamChartMax(monthly: ApiTeamMonth[]): number {
  let max = 0;
  for (const m of monthly ?? []) {
    if (Number.isFinite(m.earned)) max = Math.max(max, m.earned);
    if (Number.isFinite(m.redeemed)) max = Math.max(max, m.redeemed);
  }
  return Math.max(1, max);
}

/**
 * Map + harden the raw team payload for the view. Clamps every display number to a
 * safe non-negative (percent fields to 0–100), preserves the null semantics of
 * targetPoints/achievedPct (null = no target, rendered as "No target"), sorts the
 * leaderboard, and guarantees non-null collections. Pure.
 */
export function mapTeam(api: ApiTeamResponse): Team {
  const clampNum = (n: number | null | undefined): number =>
    n != null && Number.isFinite(n) ? Math.max(0, n) : 0;

  const r = api.rollup ?? ({} as ApiTeamRollup);

  const members = (api.members ?? []).map(
    (m): ApiTeamMember => ({
      salesUserId: m.salesUserId,
      name: m.name,
      employeeCode: m.employeeCode,
      roleName: m.roleName,
      region: m.region,
      isManager: m.isManager === true,
      directReportCount: clampNum(m.directReportCount),
      teamSize: clampNum(m.teamSize),
      pointsBalance: clampNum(m.pointsBalance),
      earnedThisMonth: clampNum(m.earnedThisMonth),
      redeemedThisMonth: clampNum(m.redeemedThisMonth),
      // Preserve null (no target) — only clamp a real number.
      targetPoints: m.targetPoints == null ? null : clampNum(m.targetPoints),
      // UNCAPPED display value (over-achievement must survive for the number + the sort).
      achievedPct: displayPercent(m.achievedPct),
      trend: trendMeta(m.trend).direction,
    }),
  );

  return {
    root: api.root ?? null,
    isManager: api.isManager === true,
    rollup: {
      memberCount: clampNum(r.memberCount),
      earnedThisMonth: clampNum(r.earnedThisMonth),
      redeemedThisMonth: clampNum(r.redeemedThisMonth),
      avgAchievementPct: displayPercent(r.avgAchievementPct) ?? 0,
      onTrackCount: clampNum(r.onTrackCount),
    },
    members: sortByAchievement(members),
    monthly: (api.monthly ?? []).map((m) => ({
      monthKey: m.monthKey,
      label: m.label,
      earned: clampNum(m.earned),
      redeemed: clampNum(m.redeemed),
    })),
  };
}
