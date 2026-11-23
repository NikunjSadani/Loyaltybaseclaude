/**
 * Target vs Sales report — shared FE helpers (Reports page + the Overview billing card's download).
 * Backend: GET /v1/admin/reports/target-vs-sales (export kind `target-vs-sales`,
 * api/src/exports/kinds/batch2/target-vs-sales.kind.ts).
 */
import { hasPermissionFor, STAFF_ROLE } from '@/lib/use-permissions';

export const TVS_REPORT_URL = '/api/admin/reports/target-vs-sales';
export const TVS_FILTERS_URL = '/api/admin/reports/target-vs-sales/filters';

/** The `bucket` filter's keys = the billing card's progress bands (backend TARGET_VS_SALES_BUCKET_KEYS). */
export const TVS_BUCKET_KEYS = ['NOT_STARTED', 'P0_20', 'P20_40', 'P40_60', 'P60_80', 'P80_100', 'ACHIEVED'] as const;
export type TvsBucketKey = (typeof TVS_BUCKET_KEYS)[number];

/** The bands with their card labels — fixed, so the bucket filter works even if the filter lists fail to load. */
export const TVS_BUCKETS: ReadonlyArray<{ key: TvsBucketKey; label: string }> = [
  { key: 'NOT_STARTED', label: 'Not started' },
  { key: 'P0_20', label: 'Under 20%' },
  { key: 'P20_40', label: '20–39%' },
  { key: 'P40_60', label: '40–59%' },
  { key: 'P60_80', label: '60–79%' },
  { key: 'P80_100', label: '80–99%' },
  { key: 'ACHIEVED', label: 'Achieved (100%+)' },
];

/** "2026-01" → "Jan 2026" (the server's Downloads-page wording). */
export function tvsMonthWords(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[m - 1] ? `${names[m - 1]} ${y}` : ym;
}

/** The period part of a "For: …" line. */
export function tvsPeriodWords(from: string, to: string): string {
  return from === to ? tvsMonthWords(from) : `${tvsMonthWords(from)} – ${tvsMonthWords(to)}`;
}

export function isTvsBucketKey(v: string | null | undefined): v is TvsBucketKey {
  return !!v && (TVS_BUCKET_KEYS as readonly string[]).includes(v);
}

/**
 * Who may download it — mirrors the backend guard (@Roles CLIENT_ADMIN | GIFSY_ADMIN + targets:read; a GIFSY_STAFF
 * operator defers to their granted permission). Everyone else (MIS, sales, partners) never sees the action.
 */
export function canDownloadTargetVsSales(role: string | null | undefined, permissions: string[] = []): boolean {
  if (role === 'CLIENT_ADMIN' || role === 'GIFSY_ADMIN') return true;
  if (role === STAFF_ROLE) return hasPermissionFor(role, permissions, 'targets:read');
  return false;
}

export interface TvsQuery {
  fromMonth: string;
  toMonth: string;
  format: 'json' | 'xlsx';
  program?: string | null;
  outletType?: string | null;
  managerId?: string | null;
  bucket?: string | null;
}

/** Query string for the report; empty filters are left out (absent = all). */
export function tvsQueryString(q: TvsQuery): string {
  const sp = new URLSearchParams();
  sp.set('fromMonth', q.fromMonth);
  sp.set('toMonth', q.toMonth);
  sp.set('format', q.format);
  if (q.program) sp.set('program', q.program);
  if (q.outletType) sp.set('outletType', q.outletType);
  if (q.managerId) sp.set('managerId', q.managerId);
  if (q.bucket) sp.set('bucket', q.bucket);
  return sp.toString();
}

/**
 * Plain-English filter line — the SAME words as the billing card's subtitle / drill-down ("Program:", "Outlet type:",
 * "Manager: X (and team)") and its dropdowns ("All outlet types", "Everyone"), e.g.
 * "November 2026 · Program: Gold · All outlet types · Manager: Asha (and team)".
 */
export function describeTvsFilters(parts: {
  period: string;
  program?: string | null;
  outletType?: string | null;
  managerName?: string | null;
  managerId?: string | null;
  bucketLabel?: string | null;
}): string {
  const out = [parts.period];
  out.push(parts.program ? `Program: ${parts.program}` : 'All programs');
  out.push(parts.outletType ? `Outlet type: ${parts.outletType}` : 'All outlet types');
  if (parts.managerId) out.push(`Manager: ${parts.managerName ?? 'selected manager'} (and team)`);
  else out.push('Everyone');
  if (parts.bucketLabel) out.push(`Billing bucket: ${parts.bucketLabel}`);
  return out.join(' · ');
}
