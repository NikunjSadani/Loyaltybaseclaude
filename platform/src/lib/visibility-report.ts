/**
 * Month-wise Visibility (POSM) report client + plain status words (VISIBILITY-POSM-DESIGN.md §Metrics).
 * Backend: GET /v1/visibility/report[/tenant][/outlets] (visibility-report.service.ts) and the shared metric
 * definitions in api/src/visibility/visibility-metrics.ts.
 *
 * Imported months: the API's rule (api/src/visibility/visibility-import.helper.ts) decides; this file only shows it.
 *
 * NOTE (consolidation): the plain status words below are a LOCAL mapping. A parallel track is adding plain status
 * labels to `lib/visibility-types.ts`; once both land, point PLAIN_STATUS_LABEL at that single source. The older
 * `visibilityApi.getReport/getTenantReport` + `VisibilityReport` type (per-window shape) are superseded by this file.
 */
import { api } from '@/lib/api-client';
import { istMonthKey } from '@/lib/ist-date';

export const PLAIN_STATUSES = [
  'WAITING',
  'APPROVED',
  'NEEDS_RETAKE',
  'REJECTED',
  'CLOSED_NOT_APPROVED',
  'NOT_CAPTURED',
  'MISSED',
  'NOT_TRACKED',
] as const;
export type PlainStatus = (typeof PLAIN_STATUSES)[number];

/** The words shown to people (mirror of the API's PLAIN_STATUS_LABEL — api/src/visibility/visibility-metrics.ts). */
export const PLAIN_STATUS_LABEL: Record<PlainStatus, string> = {
  WAITING: 'Waiting for review',
  APPROVED: 'Approved',
  NEEDS_RETAKE: 'Needs re-take',
  REJECTED: 'Rejected',
  CLOSED_NOT_APPROVED: 'Not approved — window closed',
  NOT_CAPTURED: 'Not captured yet',
  MISSED: 'Missed',
  NOT_TRACKED: 'Not tracked (imported month)',
};

/**
 * One-line explanation per status (tile toggletips / list legend). "Needs re-take" and "Rejected" only ever apply
 * while the window is OPEN (the rep can still redo it); once it closes the same capture is "Not approved — window
 * closed" (a resubmit is refused), so no hint here ever tells a rep to do something they can't.
 */
export const PLAIN_STATUS_HINT: Record<PlainStatus, string> = {
  WAITING: 'Captured by the rep; Gifsy has not finished reviewing it.',
  APPROVED: 'Reviewed and approved — this visit counts as done.',
  NEEDS_RETAKE: 'One or more photos were sent back and the window is still open — the rep can re-take them.',
  REJECTED: 'The whole capture was rejected and the window is still open — the rep can capture again.',
  CLOSED_NOT_APPROVED: 'Photos were sent back or rejected and the window closed before a new capture — this visit was not approved.',
  NOT_CAPTURED: 'No capture yet, and the window is still open (or has not started).',
  MISSED: 'No capture by the time the window closed.',
  NOT_TRACKED: 'Imported month — the old app only kept approved visits, so a missing visit is not tracked.',
};

export interface StatusTally {
  /** Visits due. In an imported month: only the visits the old app recorded. */
  inScope: number;
  waiting: number;
  approved: number;
  needsRetake: number;
  rejected: number;
  closedNotApproved: number;
  notCaptured: number;
  missed: number;
  notTracked: number;
  /** null for an imported month (not tracked). */
  coveragePct: number | null;
}

export interface BreakdownRow extends StatusTally {
  key: string;
  label: string;
}

export type ReportGroup = 'programme' | 'rep' | 'manager';

export interface MonthReport {
  month: string;
  windowKey: string | null;
  windows: Array<{ key: string; closed: boolean }>;
  windowClosed: boolean;
  frequencyPerMonth: number;
  outletScope: string[];
  programs?: string[];
  subPrograms?: string[];
  outletsInScope: number;
  /** A month before the portal went live (imported old-app history) — coverage / Missed are not tracked. */
  importedMonth?: boolean;
  /** Plain one-line reason, present when importedMonth. */
  importedMonthNote?: string;
  summary: StatusTally;
  notCounted: { outOfScope: number; otherWindow: number };
  breakdowns: Record<ReportGroup, BreakdownRow[]>;
}

export interface ReportOutletRow {
  outletId: string;
  outletCode: string;
  outletName: string;
  programme: string | null;
  subProgramme: string | null;
  windowKey: string;
  status: PlainStatus;
  captureId: string | null;
  rep: string | null;
  manager: string | null;
  capturedBy: string | null;
  capturedOn: string | null;
  reviewedBy: string | null;
  reviewedOn: string | null;
  imported: boolean;
}

export interface ReportOutletsPage {
  month: string;
  windowKey: string | null;
  status: PlainStatus | null;
  group: ReportGroup | null;
  groupKey: string | null;
  groupLabel: string | null;
  rows: ReportOutletRow[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

export interface ReportQuery {
  month?: string;
  windowKey?: string;
}

export interface OutletsQuery extends ReportQuery {
  status?: PlainStatus;
  group?: ReportGroup;
  groupKey?: string;
  page?: number;
  pageSize?: number;
}

function qs(params: object): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

const BASE = '/api/visibility/report';

export const visibilityReportApi = {
  /** GIFSY (`admin`) or CLIENT_ADMIN read-only (`tenant`) month report. */
  getReport(variant: 'admin' | 'tenant', q: ReportQuery = {}) {
    return api.get<MonthReport>(`${BASE}${variant === 'tenant' ? '/tenant' : ''}${qs(q)}`);
  },
  /** The outlets behind a tile and/or a breakdown row, paged. */
  getOutlets(variant: 'admin' | 'tenant', q: OutletsQuery = {}) {
    return api.get<ReportOutletsPage>(`${BASE}${variant === 'tenant' ? '/tenant' : ''}/outlets${qs(q)}`);
  },
};

/** The current IST month `YYYY-MM`. */
export function currentIstMonth(now: Date = new Date()): string {
  return istMonthKey(now);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 2026" from "2026-11". */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/**
 * Month options, newest first: the current IST month back `count` months (default 24 — covers the imported
 * old-app history from Apr 2025). Never a future month.
 */
export function monthOptions(count = 24, now: Date = new Date()): Array<{ value: string; label: string }> {
  const cur = currentIstMonth(now);
  let y = Number(cur.slice(0, 4));
  let mo = Number(cur.slice(5, 7));
  const out: Array<{ value: string; label: string }> = [];
  for (let i = 0; i < count; i++) {
    const value = `${y}-${String(mo).padStart(2, '0')}`;
    out.push({ value, label: monthLabel(value) });
    mo -= 1;
    if (mo === 0) { mo = 12; y -= 1; }
  }
  return out;
}

/** "P2" → "Window 2 (16–end)"-style label is owned by lib/visibility-window; this is the short form. */
export function windowShortLabel(windowKey: string): string {
  const m = /-P(\d+)$/.exec(windowKey);
  return m ? `Window ${m[1]}` : windowKey;
}
