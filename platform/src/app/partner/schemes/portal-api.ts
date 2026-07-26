/**
 * portal-api.ts — outlet/partner-portal data helpers for the Scheme
 * Data-Collection feature (D27).
 *
 * These wrap the CANONICAL `schemeApi` (lib/schemes.ts — do NOT edit) plus the one
 * enrollee-readable route the client doesn't expose a typed method for: the
 * enrollment-form GET (`GET /api/schemes/:id/enrollment-form`, open to all in-tenant
 * roles, tenant-scoped in the service). The renderer needs the FULL form schema and
 * neither `listEligible` (form summary only) nor `getMyEnrollment` returns it.
 *
 * GROUP-AWARE: every call is same-origin, so the edge proxy injects the httpOnly
 * `active_partner_id` cookie as `x-active-partner-id`; the backend resolves the
 * active partner (own or an authorized login-less sibling) server-side. The FE never
 * sets that header — switching outlet (OutletSwitcher) hard-reloads, so a later fetch
 * here is already scoped to the newly-active outlet.
 */

import { api } from '@/lib/api-client';
import { schemeApi } from '@/lib/schemes';
import type {
  AudienceConfig,
  CampaignType,
  EnrollmentFormSchema,
  PartnerEligibleScheme,
  SchemeEnrollment,
} from '@/lib/scheme-types';

export interface EnrollmentFormResult {
  schema: EnrollmentFormSchema;
  campaignType: CampaignType | string;
  version: number;
}

/**
 * Fetch a scheme's CURRENT enrollment form schema. Returns null when no form is
 * configured (the route 404s) — such a scheme is enrollable with an empty body.
 */
export async function fetchEnrollmentForm(schemeId: string): Promise<EnrollmentFormResult | null> {
  const res = await api.get<{
    enrollmentForm: { formSchema: EnrollmentFormSchema; campaignType: string; version: number } | null;
  }>(`/api/schemes/${schemeId}/enrollment-form`);
  if (!res.success) return null; // 404 = no form configured
  const form = res.data?.enrollmentForm;
  if (!form || !form.formSchema) return null;
  return { schema: form.formSchema, campaignType: form.campaignType, version: form.version };
}

export type PortalStatus = 'NOT_ENROLLED' | 'SUBMITTED' | 'REJECTED';

/** A scheme + this outlet's current enrollment state (null = not yet enrolled). */
export interface PortalScheme {
  scheme: PartnerEligibleScheme;
  enrollment: SchemeEnrollment | null;
}

export function statusOf(p: Pick<PortalScheme, 'enrollment'>): PortalStatus {
  if (!p.enrollment) return 'NOT_ENROLLED';
  return p.enrollment.status === 'REJECTED' ? 'REJECTED' : 'SUBMITTED';
}

/**
 * Self-enrollment is allowed (D21) when the scheme has no audience config (opt-in
 * default → visible/enrollable to all) OR the audience explicitly enables it. Mirrors
 * the backend's `resolveRoster` SELF gate.
 */
export function selfEnrollAllowed(scheme: { audienceConfig?: AudienceConfig | null }): boolean {
  const a = scheme.audienceConfig;
  if (!a) return true;
  return a.selfEnrollAllowed === true;
}

/**
 * A fixed-roster audience (Excel Mode B, or a frozen FILTER snapshot) cannot lazily
 * create a roster row on first self-enroll — the enrollee endpoints don't surface the
 * pre-enrollment `schemeOutletId`, so an outlet with no existing enrollment can only be
 * enrolled by its sales rep. Live-rule / unconfigured audiences self-enroll freely.
 */
export function isFixedRoster(scheme: { audienceConfig?: AudienceConfig | null }): boolean {
  const a = scheme.audienceConfig;
  if (!a) return false;
  return a.mode === 'EXCEL' || a.frozen === true;
}

/** This outlet's current enrollment for a scheme, or null when not enrolled (404). */
export async function fetchMyEnrollment(schemeId: string): Promise<SchemeEnrollment | null> {
  const res = await schemeApi.getMyEnrollment(schemeId);
  return res.success ? res.data.enrollment : null;
}

/**
 * The full portal list: every eligible ACTIVE scheme for the active outlet, each
 * paired with this outlet's current enrollment (if any). Enrollment lookups run in
 * parallel; a failed lookup (incl. the 404 "not enrolled") resolves to null.
 */
export async function loadPortalSchemes(): Promise<PortalScheme[]> {
  const res = await schemeApi.listEligible();
  if (!res.success) throw new Error(res.error);
  const schemes = res.data.schemes ?? [];
  const enrollments = await Promise.all(
    schemes.map((s) =>
      fetchMyEnrollment(s.id).catch(() => null),
    ),
  );
  return schemes.map((scheme, i) => ({ scheme, enrollment: enrollments[i] }));
}

/** Detail-page load: the eligible record + this outlet's enrollment + the form schema. */
export async function loadPortalScheme(schemeId: string): Promise<{
  scheme: PartnerEligibleScheme | null;
  enrollment: SchemeEnrollment | null;
  form: EnrollmentFormResult | null;
}> {
  const [listRes, enrollment, form] = await Promise.all([
    schemeApi.listEligible(),
    fetchMyEnrollment(schemeId).catch(() => null),
    fetchEnrollmentForm(schemeId).catch(() => null),
  ]);
  const scheme = listRes.success
    ? (listRes.data.schemes ?? []).find((s) => s.id === schemeId) ?? null
    : null;
  return { scheme, enrollment, form };
}
