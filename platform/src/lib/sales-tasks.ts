import { KYCStatus } from '@/types';

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

/** Build the per-outlet Visibility task items: visibility-eligible outlets whose
 *  capture for the month is NOT yet APPROVED. UNDER_REVIEW → medium priority
 *  ("awaiting approval"); anything else → high ("capture pending"). Shared so the
 *  dashboard + Tasks page show the same Visibility count. */
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
