import { KYCStatus } from '@/types';
import type { SalesEligibleResponse } from '@/lib/visibility-types';

/**
 * Shared sales-task derivation — consumed by BOTH the sales dashboard
 * (/sales/dashboard) and the Tasks page (/sales/tasks) so their task counts can
 * never drift (the owner-reported "Approval Required is different in both views"
 * came from each page computing this independently).
 */

/** A KYC SUBMISSION (from /api/kyc) — the unit of approval. Approval/Rejected
 *  task counts derive from these so they match the KYC Submissions list exactly,
 *  INCLUDING submissions whose partner has no linked outlet (those never appear
 *  in /api/sales/outlets, so an outlet-derived count silently drops them). */
export interface KycSubRow {
  id: string;
  title: string;
  outletCode: string;
  status: KYCStatus;
  updatedAt: string;
}

/** Map + dedupe the /api/kyc payload into the rows used for Approval Required +
 *  Rejected KYC. Title mirrors the KYC list (outlet name → firm → rep). Collapsed
 *  to one row per outlet (latest by updatedAt); no-outlet submissions are kept
 *  individually (the Anil-Sharma case). Returns [] on a failed/empty payload. */
export function buildKycSubRows(kycResult: unknown): KycSubRow[] {
  const res = kycResult as { success?: boolean; data?: { submissions?: unknown[] } } | null;
  if (!res?.success) return [];
  const subs: KycSubRow[] = (res.data?.submissions ?? []).map((raw) => {
    const s = raw as {
      id: string; status?: string; updatedAt?: string; createdAt?: string;
      partner?: { businessName?: string; outlets?: { name?: string; outletCode?: string }[] };
      user?: { name?: string };
    };
    return {
      id:         s.id,
      title:      s.partner?.outlets?.[0]?.name ?? s.partner?.businessName ?? s.user?.name ?? 'KYC submission',
      outletCode: s.partner?.outlets?.[0]?.outletCode ?? '',
      status:     (s.status ?? '') as KYCStatus,
      updatedAt:  s.updatedAt ?? s.createdAt ?? '',
    };
  });
  const latestByOutlet = new Map<string, KycSubRow>();
  const noOutlet: KycSubRow[] = [];
  for (const e of subs) {
    if (!e.outletCode) { noOutlet.push(e); continue; }
    const cur = latestByOutlet.get(e.outletCode);
    if (!cur || new Date(e.updatedAt || 0).getTime() >= new Date(cur.updatedAt || 0).getTime()) {
      latestByOutlet.set(e.outletCode, e);
    }
  }
  return [...latestByOutlet.values(), ...noOutlet];
}

/** Minimal outlet shape needed to build a visibility task item. */
export interface VisibilityOutlet {
  id: string;
  name: string;
  location: string;
  outletCode: string;
}

export interface VisibilityTaskItem {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  priority: 'high' | 'medium' | 'low';
}

/** Build the per-outlet Visibility task items for the AMOUNT_UPLOAD capture mode:
 *  visibility-eligible outlets whose OutletVisibilityRecord for the month is NOT yet
 *  APPROVED. UNDER_REVIEW → medium priority ("awaiting approval"); anything else → high
 *  ("capture pending"). Shared so the dashboard + Tasks page show the same Visibility
 *  count. The mode-aware PHOTO_APPROVAL path is `buildPhotoCaptureTaskItems` below —
 *  both live here so the two surfaces can never drift. */
export function buildVisibilityTaskItems(
  eligibleOutlets: VisibilityOutlet[],
  statusMap: Record<string, { status?: string } | undefined>,
  visibilityEnabled?: boolean,
): VisibilityTaskItem[] {
  // Master Visibility switch (per-tenant, default OFF). When off, no visibility tasks surface.
  if (visibilityEnabled !== true) return [];
  return eligibleOutlets
    .filter((o) => statusMap[o.outletCode]?.status !== 'APPROVED')
    .map((o) => {
      const s = statusMap[o.outletCode]?.status;
      return {
        id:       `vis-${o.id}`,
        title:    o.name,
        subtitle: s === 'UNDER_REVIEW'
          ? 'Visibility submitted — awaiting approval'
          : `${o.location} · Visibility capture pending this month`,
        href:     '/sales/visibility',
        priority: s === 'UNDER_REVIEW' ? 'medium' : 'high',
      };
    });
}

/**
 * Build the per-outlet Visibility task items for the PHOTO_APPROVAL capture mode
 * (VISIBILITY-POSM-DESIGN.md D14). Source = the rep's current-window `getSalesEligible`
 * response: an outlet is a pending capture TASK only when THIS rep may capture it
 * (`canCapture`) AND the window is not satisfied — windowState `due` / `rejected` /
 * `late`. An `awaiting` (SUBMITTED) or `approved` window, and any view-only outlet
 * (`canCapture:false`, D8), are NOT tasks. Each item deep-links to the capture sheet
 * preselected on the outlet (`/sales/visibility?outletId=`). Returns [] for a null
 * response (endpoint disabled / 403 / not photo-mode) so the caller renders no group.
 *
 * Shared with `buildVisibilityTaskItems` (amount-upload) so the dashboard + Tasks page
 * derive the SAME Visibility count from one place; the page picks the builder by the
 * tenant's `visibilityCaptureMode`.
 */
export function buildPhotoCaptureTaskItems(
  eligible: SalesEligibleResponse | null | undefined,
): VisibilityTaskItem[] {
  if (!eligible || !Array.isArray(eligible.outlets)) return [];
  const ACTIONABLE = new Set(['due', 'rejected', 'late']);
  return eligible.outlets
    .filter((o) => o.canCapture && ACTIONABLE.has(o.windowState))
    .map((o) => {
      const subtitle =
        o.windowState === 'rejected'
          ? `Capture rejected — recapture required${o.rejectionReason ? `: ${o.rejectionReason}` : ''}`
          : o.windowState === 'late'
            ? 'Visibility capture overdue for this window'
            : 'Visibility capture due this window';
      return {
        id:       `vis-${o.outletId}`,
        title:    o.outletName,
        subtitle,
        href:     `/sales/visibility?outletId=${encodeURIComponent(o.outletId)}`,
        priority: 'high' as const,
      };
    });
}
