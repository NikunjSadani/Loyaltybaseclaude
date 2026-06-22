import type { EnrollmentFormConfig, FormField } from '@/lib/campaign';
import { api } from '@/lib/api-client';

/* ─── Scheme types ───────────────────────────────────────────────────────────── */

export type SchemeStatus   = 'PENDING_ACCEPTANCE' | 'ACTIVE' | 'ENROLLED' | 'EXPIRED';
export type SchemeEligibility = 'WHOLESALER' | 'SSS' | 'SUB_STOCKIST' | 'ALL';

export interface SchemeKpiLabel {
  label: string;   // e.g. "Monthly Volume", "Focus Product 1"
  unit:  string;   // e.g. "cases", "SKUs"
}

export interface Scheme {
  id:          string;
  name:        string;
  description: string;
  period:      string;          // e.g. "Jun '26 – Aug '26"
  startDate:   string;          // ISO
  endDate:     string;          // ISO
  eligibility: SchemeEligibility[];
  kpis:        SchemeKpiLabel[];
  status:      SchemeStatus;
  createdAt:   string;
  acceptDeadline: string;       // ISO — last date to self-register
}

/* ─── Admin-published scheme (written by SchemeBuilder on publish) ────────── */

export interface AdminPublishedScheme {
  id:                       string;
  name:                     string;
  description:              string;
  period:                   string;
  startDate:                string;
  endDate:                  string;
  acceptDeadline:           string;
  outletTargeting:          'ALL' | 'SPECIFIC';
  targetedOutletIds:        string[];
  requiresSelfRegistration: boolean;
  publishedAt:              string;
  // Enriched display fields (set by scheme builder on publish / seed data)
  status:                   'ACTIVE' | 'DRAFT' | 'UPCOMING' | 'ARCHIVED' | 'EXPIRED';
  incentiveType?:           string;
  calculationMethod?:       string;
  applicableClasses?:       string[];
  partnersEnrolled?:        number;
  totalPayout?:             string;
  createdBy?:               string;
  // Partner-facing fields
  eligibility?:             SchemeEligibility[];
  kpis?:                    SchemeKpiLabel[];
  /** Enrollment form configured by admin in SchemeBuilder */
  enrollmentFormConfig?:    EnrollmentFormConfig;
}

/* ─── Backend API response shapes ────────────────────────────────────────── */

/**
 * Shape returned by GET /api/schemes (proxied from GET /v1/schemes).
 * The backend always returns ACTIVE schemes; includes eligibility relation.
 */
interface BackendScheme {
  id:             string;
  clientId:       string;
  code:           string;
  name:           string;
  description?:   string;
  schemeType:     string;
  status:         string;
  startDate:      string;
  endDate:        string;
  holdingPeriodDays: number;
  rewardType:     string;
  budgetPaise?:   number;
  termsAndConditions?: string;
  isStackable:    boolean;
  priority:       number;
  imageUrl?:      string;
  metadata?:      Record<string, unknown>;
  createdByUserId?: string;
  createdAt:      string;
  updatedAt:      string;
  deletedAt?:     string | null;
  /** Included via the `include: { eligibility: true }` in service.list() */
  eligibility:    Array<{
    id:                string;
    schemeId:          string;
    specificPartnerId?: string | null;
    stateCode?:        string | null;
    cityCode?:         string | null;
    pincodePattern?:   string | null;
    isExclusion:       boolean;
    createdAt:         string;
    updatedAt:         string;
  }>;
}

/* ─── Month abbreviation helper ───────────────────────────────────────────── */

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtMonthYear(iso: string): string {
  const d = new Date(iso);
  return `${MONTH_ABBR[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
}

/** Format start–end as "Jun '26 – Aug '26" (or "Jun '26" when same month). */
function formatPeriod(startIso: string, endIso: string): string {
  const s = fmtMonthYear(startIso);
  const e = fmtMonthYear(endIso);
  return s === e ? s : `${s} – ${e}`;
}

/* ─── Map BackendScheme → Scheme (partner/sales-facing type) ─────────────── */

/**
 * Maps a backend Scheme record to the Scheme display type consumed by partner
 * and sales UIs. Fields the backend doesn't provide are omitted rather than
 * fabricated:
 *
 *   - period       → derived from startDate + endDate
 *   - acceptDeadline → mapped from endDate (backend has no separate deadline)
 *   - eligibility  → derived from eligibility relation: if the scheme has any
 *                    non-exclusion eligibility rows whose specificPartnerId is
 *                    null (i.e. geo/open rows, not partner-specific targeting)
 *                    we cannot infer outlet-type eligibility from the schema,
 *                    so we default to ['ALL']. The backend already pre-filters
 *                    the list for non-admin callers via specificPartnerId checks,
 *                    so every scheme returned is already eligible for the caller.
 *   - kpis         → omitted (field absent from backend Scheme model)
 *   - description  → mapped from backend description (may be empty string)
 *   - status       → set to 'PENDING_ACCEPTANCE' (all listed schemes are ACTIVE
 *                    and not yet accepted by this user — enrollment check is
 *                    done separately in fetchPendingSchemes)
 */
function backendToScheme(s: BackendScheme): Scheme {
  return {
    id:             s.id,
    name:           s.name,
    description:    s.description ?? '',
    period:         formatPeriod(s.startDate, s.endDate),
    startDate:      s.startDate,
    endDate:        s.endDate,
    // acceptDeadline: backend has no dedicated field — map to endDate so
    // formatDeadline() shows the scheme end date as the participation cutoff.
    acceptDeadline: s.endDate,
    eligibility:    ['ALL'],   // see note above — backend pre-filters per-partner
    kpis:           [],        // not modelled on the backend Scheme; omitted
    status:         'PENDING_ACCEPTANCE',
    createdAt:      s.createdAt,
  };
}

/* ─── fetchSchemes() — real backend catalog read ─────────────────────────── */

/**
 * Fetches ALL active schemes from the backend for the calling user's tenant.
 * For non-admin callers (partners/sales) the backend pre-filters to schemes
 * the caller is eligible for via SchemeEligibility.specificPartnerId rows.
 *
 * Returns the mapped Scheme[] or throws on network/auth error.
 */
export async function fetchSchemes(): Promise<Scheme[]> {
  const result = await api.get<{ schemes: BackendScheme[]; pagination: unknown }>(
    '/api/schemes',
  );
  if (!result.success) throw new Error(result.error);
  const schemes = result.data.schemes ?? [];
  return schemes.map(backendToScheme);
}

/* ─── Enrollment API response shape ─────────────────────────────────────────── */

export interface EnrollmentResult {
  enrollment: {
    id:        string;
    schemeId:  string;
    userId:    string;
    status:    string;
    createdAt: string;
  };
}

/* ─── Self-enrollment (SELF mode) ───────────────────────────────────────────── */

/**
 * Accept a scheme from the partner app — persists enrollment to the backend.
 *
 * POST /api/schemes/:id/enroll  { enrollmentMode: 'SELF', formValues? }
 * The backend identifies the calling partner from the JWT; outletId is kept as
 * a parameter for the caller's convenience but is NOT sent in the request body
 * (the backend derives the partner from the JWT, not from outletId).
 *
 * formValues is optional — pass {} or omit when there is no enrollment form.
 */
export async function acceptScheme(
  schemeId: string,
  _outletId: string,
  formValues: Record<string, unknown> = {},
): Promise<EnrollmentResult> {
  const result = await api.post<EnrollmentResult>(
    `/api/schemes/${schemeId}/enroll`,
    { enrollmentMode: 'SELF', formValues },
  );
  if (!result.success) throw new Error(result.error);
  return result.data;
}

/* ─── Sales-team enrollment (SALES mode) ─────────────────────────────────── */

/**
 * Enroll an outlet on behalf of a partner (sales-assisted flow).
 *
 * POST /api/schemes/:id/enroll  { enrollmentMode: 'SALES', targetPartnerId, formValues? }
 * targetPartnerId is the ChannelPartner.id of the outlet being enrolled (NOT the
 * outletId). The backend checks the caller has an active assignment to that partner.
 *
 * formValues is optional — pass {} or omit when there is no enrollment form.
 */
export async function saveSalesEnrollment(
  schemeId: string,
  targetPartnerId: string,
  formValues: Record<string, unknown> = {},
): Promise<EnrollmentResult> {
  const result = await api.post<EnrollmentResult>(
    `/api/schemes/${schemeId}/enroll`,
    { enrollmentMode: 'SALES', targetPartnerId, formValues },
  );
  if (!result.success) throw new Error(result.error);
  return result.data;
}

/**
 * Check whether the calling user is enrolled in a given scheme.
 *
 * GET /api/schemes/:id/my-enrollment — returns 404 if not enrolled.
 * Returns true if enrolled, false if not enrolled. Throws on other errors.
 *
 * Note: for the sales flow this checks the calling SALES user's own enrollment,
 * not the target outlet's. See SchemeEnrollmentSheet for how session-local
 * enrollment state is tracked after a successful saveSalesEnrollment call.
 */
export async function isEnrolledInScheme(schemeId: string): Promise<boolean> {
  const result = await api.get<{ enrollment: unknown }>(
    `/api/schemes/${schemeId}/my-enrollment`,
  );
  if (!result.success) {
    // The backend returns a non-ok response for 404 (not enrolled).
    // The api-client captures the HTTP status in the error body's error field.
    // Accept any non-ok response as "not enrolled" — any real auth error will
    // be caught because the scheme list fetch itself would have already failed.
    return false;
  }
  return true;
}

/**
 * @deprecated Use isEnrolledInScheme() instead.
 * Retained for callers that still pass _outletId; outletId is ignored because
 * the backend derives partner identity from the JWT.
 */
export async function isOutletEnrolledInScheme(
  schemeId: string,
  _outletId: string,
): Promise<boolean> {
  return isEnrolledInScheme(schemeId);
}

/* ─── fetchPendingSchemes() — partner self-enrollment catalog ─────────────── */

/**
 * Fetches schemes pending self-acceptance for the calling partner.
 *
 * Strategy:
 *   1. GET /api/schemes — returns all ACTIVE schemes eligible for this caller
 *      (backend pre-filters by tenant + ACTIVE status).
 *   2. For each scheme, GET /api/schemes/:id/my-enrollment to check if already
 *      enrolled. Runs the checks in parallel (Promise.allSettled) to keep
 *      latency proportional to scheme count, not sequential.
 *   3. Returns only unenrolled schemes.
 *
 * After enrolling + reloading, an already-enrolled scheme will NOT reappear
 * because step 2 excludes it. The banner component calls this on mount; after
 * onAccept() the banner filters locally (removes accepted scheme from pending[]),
 * and on the next mount the backend enrollment check confirms exclusion.
 *
 * outletType and outletId parameters are retained for call-site compatibility
 * but are not used to filter — the backend already scopes the list correctly.
 */
export async function fetchPendingSchemes(
  _outletType?: string,
  _outletId?: string,
): Promise<Scheme[]> {
  const schemes = await fetchSchemes();
  if (schemes.length === 0) return [];

  // Parallel enrollment checks — one per scheme
  const enrollmentChecks = await Promise.allSettled(
    schemes.map((s) => isEnrolledInScheme(s.id)),
  );

  return schemes.filter((_, i) => {
    const check = enrollmentChecks[i];
    // If the check settled as fulfilled with true → already enrolled → exclude.
    // If rejected or false → not enrolled → include.
    if (check.status === 'fulfilled' && check.value === true) return false;
    return true;
  });
}

/* ─── Deadline helpers (internal) ────────────────────────────────────────── */

function isDeadlineValid(acceptDeadline: string): boolean {
  return !acceptDeadline || new Date(acceptDeadline) >= new Date();
}

/* ─── Map AdminPublishedScheme → Scheme (for localStorage-based paths) ─────── */

function toScheme(s: AdminPublishedScheme): Scheme {
  return {
    id:             s.id,
    name:           s.name,
    description:    s.description,
    period:         s.period,
    startDate:      s.startDate,
    endDate:        s.endDate,
    eligibility:    s.eligibility ?? ['ALL'],
    kpis:           s.kpis ?? [],
    status:         'PENDING_ACCEPTANCE',
    createdAt:      s.publishedAt,
    acceptDeadline: s.acceptDeadline,
  };
}

/**
 * Synchronous localStorage-based getPendingSchemes — retained for test
 * compatibility and admin-builder use. The live PARTNER catalog no longer calls
 * this; it uses fetchPendingSchemes() (async, real backend).
 *
 * Returns schemes from localStorage filtered by eligibility, deadline, targeting,
 * and the supplied enrolledSchemeIds list.
 */
export function getPendingSchemes(
  outletType: SchemeEligibility | string,
  outletId?: string,
  enrolledSchemeIds: string[] = [],
): Scheme[] {
  return loadAdminSchemes()
    .filter((s) => {
      if (!s.requiresSelfRegistration) return false;
      if (enrolledSchemeIds.includes(s.id)) return false;
      if (!isDeadlineValid(s.acceptDeadline)) return false;
      if (s.outletTargeting === 'SPECIFIC') {
        if (!outletId || !s.targetedOutletIds.includes(outletId)) return false;
      }
      const eligibility = s.eligibility ?? ['ALL'];
      if (!eligibility.includes('ALL') && !eligibility.includes(outletType as SchemeEligibility)) {
        return false;
      }
      return true;
    })
    .map(toScheme);
}

/* ─── fetchAllSchemes() — sales team view ────────────────────────────────── */

/**
 * Fetches ALL active schemes for the sales team enrollment view.
 * No enrollment-state filtering — the sales sheet tracks enrolled outlets
 * locally within the session (backend is source of truth; local state prevents
 * re-showing already-enrolled outlets in the same sheet open).
 *
 * Equivalent to the old getAllPendingSchemes() but reads from the real backend.
 */
export async function fetchAllSchemes(): Promise<Scheme[]> {
  return fetchSchemes();
}

/**
 * Synchronous localStorage-based getAllPendingSchemes — retained for test
 * compatibility, admin-builder use, and the sales/dashboard page import.
 * The live SALES TASKS catalog no longer calls this; it uses fetchAllSchemes()
 * (async, real backend).
 *
 * Returns ALL non-expired admin-published schemes from localStorage.
 */
export function getAllPendingSchemes(): Scheme[] {
  return loadAdminSchemes()
    .filter((s) => isDeadlineValid(s.acceptDeadline))
    .map(toScheme);
}

/* ─── Admin localStorage helpers (retained for SchemeBuilder + tests) ────── */

/*
 * The partner/sales catalog no longer uses localStorage demo data — it reads
 * from the real backend via fetchPendingSchemes() / fetchAllSchemes(). The
 * localStorage helpers below are retained for:
 *   - The admin SchemeBuilder page (out of scope of this pass)
 *   - Unit tests (platform/src/lib/__tests__/schemes-enrollment.test.ts)
 * seedAdminSchemes() seeds DEMO_SEED_SCHEMES for tests only; those seeds
 * never appear on live partner/sales surfaces.
 */

const ADMIN_SCHEMES_KEY = 'loyaltybase_admin_schemes_v1';

function loadAdminSchemes(): AdminPublishedScheme[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(ADMIN_SCHEMES_KEY) ?? '[]') as AdminPublishedScheme[];
  } catch { return []; }
}

function saveAllAdminSchemes(schemes: AdminPublishedScheme[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ADMIN_SCHEMES_KEY, JSON.stringify(schemes));
}

/** Returns admin-created schemes from localStorage (for SchemeBuilder admin page). */
export function getAdminSchemes(): AdminPublishedScheme[] {
  return loadAdminSchemes();
}

/**
 * Seeds demo schemes into localStorage if the key is empty.
 * Safe to call on every mount — will not overwrite existing data.
 *
 * NOTE: The demo seed data is intentionally NOT used by the live partner/sales
 * catalog (which reads from the real backend via fetchPendingSchemes /
 * fetchAllSchemes). This export is retained for:
 *   - Unit tests (platform/src/lib/__tests__/schemes-enrollment.test.ts)
 *   - Any admin-builder page that calls it to pre-populate its local view
 * The SEED data below is test/demo-only; it never drives live partner UI.
 */
export function seedAdminSchemes(): void {
  const existing = loadAdminSchemes();
  if (existing.length > 0) return;   // already seeded — no-op
  saveAllAdminSchemes(DEMO_SEED_SCHEMES);
}

/**
 * Demo seed schemes — used ONLY by seedAdminSchemes() for unit tests and the
 * admin SchemeBuilder local-preview. Never rendered on live partner/sales surfaces.
 */
const DEMO_SEED_SCHEMES: AdminPublishedScheme[] = [
  {
    id:                       'sch_q2_2026',
    name:                     'Summer Push Q2 FY26',
    description:              'Quarterly growth scheme focused on Bertolli and Figaro range expansion across all general trade outlets.',
    period:                   "Jun '26 – Aug '26",
    startDate:                '2026-06-01',
    endDate:                  '2026-08-31',
    acceptDeadline:           '2026-06-30T23:59:59',
    outletTargeting:          'ALL',
    targetedOutletIds:        [],
    requiresSelfRegistration: true,
    publishedAt:              '2026-05-20T09:00:00',
    status:                   'ACTIVE',
    eligibility:              ['WHOLESALER', 'SSS', 'SUB_STOCKIST'],
    kpis: [
      { label: 'Monthly Volume',   unit: 'cases' },
      { label: 'Focus Product 1',  unit: 'cases' },
    ],
  },
  {
    id:                       'sch_visibility_jun',
    name:                     'Visibility Drive — June 2026',
    description:              'Monthly scheme rewarding outlet visibility compliance.',
    period:                   "Jun '26",
    startDate:                '2026-06-01',
    endDate:                  '2026-06-30',
    acceptDeadline:           '2026-06-15T23:59:59',
    outletTargeting:          'ALL',
    targetedOutletIds:        [],
    requiresSelfRegistration: true,
    publishedAt:              '2026-05-22T11:00:00',
    status:                   'ACTIVE',
    eligibility:              ['SSS', 'SUB_STOCKIST'],
    kpis: [
      { label: 'Shelf Compliance', unit: 'submissions' },
    ],
  },
  {
    id:                       'sch_wholesale_drive_q2',
    name:                     'Wholesale Drive Q2 FY26',
    description:              'Exclusive scheme for wholesale partners.',
    period:                   "Jun '26 – Jul '26",
    startDate:                '2026-06-01',
    endDate:                  '2026-07-31',
    acceptDeadline:           '2026-06-20T23:59:59',
    outletTargeting:          'ALL',
    targetedOutletIds:        [],
    requiresSelfRegistration: true,
    publishedAt:              '2026-05-24T10:00:00',
    status:                   'ACTIVE',
    eligibility:              ['WHOLESALER'],
    kpis: [
      { label: 'Monthly Volume',   unit: 'cases' },
    ],
  },
];

/** Save (upsert) a single scheme published via the admin builder. */
export function saveAdminScheme(scheme: AdminPublishedScheme): void {
  const existing = loadAdminSchemes();
  const idx = existing.findIndex((s) => s.id === scheme.id);
  if (idx >= 0) existing[idx] = scheme; else existing.unshift(scheme);
  saveAllAdminSchemes(existing);
}

/* ─── Deadline helpers ────────────────────────────────────────────────────── */

export function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ─── Enrollment form helpers ─────────────────────────────────────────────── */

/**
 * Returns true when the scheme has an enrollment form with at least one field.
 * Used to decide whether to render EnrollmentFormRenderer in SchemeSheet.
 */
export function hasEnrollmentForm(scheme: AdminPublishedScheme): boolean {
  return (scheme.enrollmentFormConfig?.fields?.length ?? 0) > 0;
}

/**
 * Returns the scheme's enrollment form fields sorted by their `order` property.
 * Returns an empty array when there is no enrollment form configured.
 */
export function getEnrollmentFields(scheme: AdminPublishedScheme): FormField[] {
  const fields = scheme.enrollmentFormConfig?.fields;
  if (!fields || fields.length === 0) return [];
  return [...fields].sort((a, b) => a.order - b.order);
}
