import type { EnrollmentFormConfig, FormField } from '@/lib/campaign';

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

const ADMIN_SCHEMES_KEY = 'loyaltybase_admin_schemes_v1';

/* ─── Seed data ───────────────────────────────────────────────────────────── */

const SEED_SCHEMES: AdminPublishedScheme[] = [
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
    incentiveType:            'SALES',
    calculationMethod:        'SLAB',
    applicableClasses:        ['GOLD', 'SILVER', 'PLATINUM'],
    partnersEnrolled:         1243,
    totalPayout:              '₹28.4L',
    createdBy:                'Rahul Agarwal',
    eligibility:              ['WHOLESALER', 'SSS', 'SUB_STOCKIST'],
    kpis: [
      { label: 'Monthly Volume',   unit: 'cases' },
      { label: 'Focus Product 1',  unit: 'cases' },
      { label: 'Focus Product 2',  unit: 'cases' },
      { label: 'Focus Category',   unit: 'cases' },
      { label: 'No. of Lines',     unit: 'SKUs'  },
    ],
  },
  {
    id:                       'sch_visibility_jun',
    name:                     'Visibility Drive — June 2026',
    description:              'Monthly scheme rewarding outlet visibility compliance — shelf placement, pricing boards, and display units.',
    period:                   "Jun '26",
    startDate:                '2026-06-01',
    endDate:                  '2026-06-30',
    acceptDeadline:           '2026-06-15T23:59:59',
    outletTargeting:          'ALL',
    targetedOutletIds:        [],
    requiresSelfRegistration: true,
    publishedAt:              '2026-05-22T11:00:00',
    status:                   'ACTIVE',
    incentiveType:            'VISIBILITY',
    calculationMethod:        'FLAT',
    applicableClasses:        ['GOLD', 'SILVER', 'BRONZE', 'STANDARD'],
    partnersEnrolled:         3214,
    totalPayout:              '₹12.1L',
    createdBy:                'Rahul Agarwal',
    eligibility:              ['SSS', 'SUB_STOCKIST'],
    kpis: [
      { label: 'Shelf Compliance', unit: 'submissions' },
      { label: 'Display Unit',     unit: 'units'       },
    ],
  },
  {
    id:                       'sch_wholesale_drive_q2',
    name:                     'Wholesale Drive Q2 FY26',
    description:              'Exclusive scheme for wholesale partners — volume growth incentives on bulk purchase of Bertolli and Figaro across all SKUs.',
    period:                   "Jun '26 – Jul '26",
    startDate:                '2026-06-01',
    endDate:                  '2026-07-31',
    acceptDeadline:           '2026-06-20T23:59:59',
    outletTargeting:          'ALL',
    targetedOutletIds:        [],
    requiresSelfRegistration: true,
    publishedAt:              '2026-05-24T10:00:00',
    status:                   'ACTIVE',
    incentiveType:            'SALES',
    calculationMethod:        'SLAB',
    applicableClasses:        ['GOLD', 'PLATINUM'],
    partnersEnrolled:         0,
    totalPayout:              '—',
    createdBy:                'Priya Menon',
    eligibility:              ['WHOLESALER'],
    kpis: [
      { label: 'Monthly Volume',   unit: 'cases'  },
      { label: 'Bulk Order Value', unit: '₹ lakh' },
      { label: 'SKU Range',        unit: 'SKUs'   },
    ],
  },
  {
    id:                       'sch_referral_bonus',
    name:                     'Referral Bonus Program',
    description:              'Earn bonus points for every new outlet you onboard to the Deoleo Loyalty platform.',
    period:                   "Jan '26 – Dec '26",
    startDate:                '2026-01-01',
    endDate:                  '2026-12-31',
    acceptDeadline:           '2026-12-15T23:59:59',
    outletTargeting:          'ALL',
    targetedOutletIds:        [],
    requiresSelfRegistration: true,
    publishedAt:              '2026-01-01T00:00:00',
    status:                   'ACTIVE',
    incentiveType:            'REFERRAL',
    calculationMethod:        'FLAT',
    applicableClasses:        ['GOLD', 'SILVER', 'BRONZE', 'PLATINUM', 'STANDARD'],
    partnersEnrolled:         4821,
    totalPayout:              '₹3.8L',
    createdBy:                'Amit Khanna',
    eligibility:              ['ALL'],
    kpis: [
      { label: 'New Outlets Onboarded', unit: 'outlets' },
    ],
  },
  {
    id:                       'sch_monsoon_q3',
    name:                     'Monsoon Sales Boost',
    description:              'Seasonal scheme targeting secondary sales growth during the monsoon period across all partner classes.',
    period:                   "Jul '26 – Sep '26",
    startDate:                '2026-07-01',
    endDate:                  '2026-09-30',
    acceptDeadline:           '2026-07-10T23:59:59',
    outletTargeting:          'ALL',
    targetedOutletIds:        [],
    requiresSelfRegistration: false,
    publishedAt:              '2026-06-01T10:00:00',
    status:                   'UPCOMING',
    incentiveType:            'SECONDARY_SALES',
    calculationMethod:        'PERCENTAGE',
    applicableClasses:        ['GOLD', 'PLATINUM'],
    partnersEnrolled:         0,
    totalPayout:              '—',
    createdBy:                'Priya Menon',
    eligibility:              ['WHOLESALER', 'SSS'],
    kpis: [
      { label: 'Secondary Sales Volume', unit: 'cases' },
    ],
  },
];

/* ─── Storage helpers ─────────────────────────────────────────────────────── */

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

/* ─── Public: read all admin schemes ─────────────────────────────────────── */

export function getAdminSchemes(): AdminPublishedScheme[] {
  return loadAdminSchemes();
}

/* ─── Public: seed demo data (idempotent) ─────────────────────────────────── */

/**
 * Seeds demo schemes into localStorage if the key is empty.
 * Safe to call on every mount — will not overwrite existing data.
 */
export function seedAdminSchemes(): void {
  const existing = loadAdminSchemes();
  if (existing.length > 0) return;   // already seeded — no-op
  saveAllAdminSchemes(SEED_SCHEMES);
}

/** Save (upsert) a single scheme published via the admin builder. */
export function saveAdminScheme(scheme: AdminPublishedScheme): void {
  const existing = loadAdminSchemes();
  const idx = existing.findIndex((s) => s.id === scheme.id);
  if (idx >= 0) existing[idx] = scheme; else existing.unshift(scheme);
  saveAllAdminSchemes(existing);
}

/* ─── Self-enrollment persistence ───────────────────────────────────────────── */

const ACCEPTED_KEY = 'loyaltybase_accepted_schemes_v1';

export interface SelfEnrollment {
  schemeId:   string;
  outletId:   string;
  acceptedAt: string;
}

export function getSelfEnrollments(): SelfEnrollment[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(ACCEPTED_KEY) ?? '[]');
    // Migrate old format (plain string[]) to new format (SelfEnrollment[])
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
      return (raw as string[]).map((id) => ({ schemeId: id, outletId: '', acceptedAt: '' }));
    }
    return raw as SelfEnrollment[];
  } catch { return []; }
}

/** Accept a scheme from the partner app — stores schemeId + outletId together. */
export function acceptScheme(schemeId: string, outletId: string): void {
  const all = getSelfEnrollments();
  if (!all.find((e) => e.schemeId === schemeId && e.outletId === outletId)) {
    all.push({ schemeId, outletId, acceptedAt: new Date().toISOString() });
    localStorage.setItem(ACCEPTED_KEY, JSON.stringify(all));
  }
}

/** Returns scheme IDs accepted by any outlet (backward-compat helper). */
export function getAcceptedSchemeIds(): string[] {
  return getSelfEnrollments().map((e) => e.schemeId);
}

/* ─── Sales-team enrollment tracking ─────────────────────────────────────── */

const SALES_ENROLLMENTS_KEY = 'loyaltybase_sales_enrollments_v1';

export interface SalesEnrollment {
  schemeId:   string;
  outletId:   string;
  enrolledAt: string;
}

export function getSalesEnrollments(): SalesEnrollment[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(SALES_ENROLLMENTS_KEY) ?? '[]') as SalesEnrollment[];
  } catch { return []; }
}

export function saveSalesEnrollment(schemeId: string, outletId: string): void {
  const all = getSalesEnrollments();
  if (!all.find((e) => e.schemeId === schemeId && e.outletId === outletId)) {
    all.push({ schemeId, outletId, enrolledAt: new Date().toISOString() });
    localStorage.setItem(SALES_ENROLLMENTS_KEY, JSON.stringify(all));
  }
}

export function isOutletEnrolledInScheme(schemeId: string, outletId: string): boolean {
  const salesEnrolled = getSalesEnrollments().some(
    (e) => e.schemeId === schemeId && e.outletId === outletId,
  );
  const selfEnrolled = getSelfEnrollments().some(
    (e) => e.schemeId === schemeId && e.outletId === outletId,
  );
  return salesEnrolled || selfEnrolled;
}

/* ─── Deadline helpers ────────────────────────────────────────────────────── */

export function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isDeadlineValid(acceptDeadline: string): boolean {
  return !acceptDeadline || new Date(acceptDeadline) >= new Date();
}

/* ─── Map AdminPublishedScheme → Scheme (partner-facing type) ─────────────── */

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

/* ─── Partner-facing: pending schemes for self-enrollment ─────────────────── */

/**
 * Returns schemes that are pending self-acceptance for this outlet.
 * - Reads ONLY from admin-published schemes (no hardcoded mock fallback).
 * - Filters by eligibility, acceptDeadline, and existing enrollment.
 */
export function getPendingSchemes(outletType: SchemeEligibility | string, outletId?: string): Scheme[] {
  const accepted = getAcceptedSchemeIds();

  return loadAdminSchemes()
    .filter((s) => {
      if (!s.requiresSelfRegistration) return false;
      if (accepted.includes(s.id)) return false;
      if (outletId && isOutletEnrolledInScheme(s.id, outletId)) return false;
      if (!isDeadlineValid(s.acceptDeadline)) return false;
      if (s.outletTargeting === 'SPECIFIC') {
        if (!outletId || !s.targetedOutletIds.includes(outletId)) return false;
      }
      // Eligibility check: if scheme has explicit eligibility, enforce it
      const eligibility = s.eligibility ?? ['ALL'];
      if (!eligibility.includes('ALL') && !eligibility.includes(outletType as SchemeEligibility)) {
        return false;
      }
      return true;
    })
    .map(toScheme);
}

/* ─── Sales-team facing: all non-expired pending schemes ─────────────────── */

/**
 * Returns ALL non-expired admin-published schemes for the sales team view.
 * Does NOT filter by outlet type — the sales team can enrol any eligible outlet.
 * Reads ONLY from admin-published schemes (no hardcoded mock fallback).
 */
export function getAllPendingSchemes(): Scheme[] {
  return loadAdminSchemes()
    .filter((s) => isDeadlineValid(s.acceptDeadline))
    .map(toScheme);
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
