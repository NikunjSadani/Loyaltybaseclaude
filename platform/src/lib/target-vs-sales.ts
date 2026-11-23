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

/** Plain-English filter line, e.g. "November 2026 · Programme: Gold · Sales manager: Asha (and team)". */
export function describeTvsFilters(parts: {
  period: string;
  program?: string | null;
  outletType?: string | null;
  managerName?: string | null;
  managerId?: string | null;
  bucketLabel?: string | null;
}): string {
  const out = [parts.period];
  out.push(parts.program ? `Programme: ${parts.program}` : 'All programmes');
  out.push(parts.outletType ? `Outlet type: ${parts.outletType}` : 'All outlet types');
  if (parts.managerId) out.push(`Sales manager: ${parts.managerName ?? 'selected manager'} (and team)`);
  else out.push('Everyone');
  if (parts.bucketLabel) out.push(`Billing bucket: ${parts.bucketLabel}`);
  return out.join(' · ');
}
