/**
 * sales-team.ts — typed client for the redesigned Team view (GET /api/sales/team-view).
 *
 * Returns, for the caller (or a drilled-into `memberId`), the filtered team summary + each
 * direct report, in ONE of two shapes keyed by `mode`:
 *   • OVERVIEW (default — kpi='OVERVIEW' or empty): every member scored across ALL KPIs
 *     (an all-KPI grid + an overall `score`), summary carries `avgScore`.
 *   • SINGLE (a specific KPI code): each member scored by that one KPI's
 *     "outlets achieved ÷ outlets with a target" (`achievedPct`), summary carries `avgTargetPct`.
 * Plus the filter option lists. See SalesService.getTeamView.
 */

import { api, type ApiResponse } from '@/lib/api-client';

/** Sentinel KPI value selecting the all-KPI OVERVIEW mode (the default). */
export const OVERVIEW_KPI = 'OVERVIEW';

export interface TeamViewKpi {
  code: string;
  label: string;
}

export interface TeamFilterOptions {
  outletTypes: { code: string; name: string }[];
  programs: string[];
  kpis: TeamViewKpi[];
}

/* ─── OVERVIEW mode ─────────────────────────────────────────────────────────────── */

export interface OverviewMember {
  id: string;
  name: string;
  roleLabel: string;
  employeeCode: string;
  mobile: string;
  teamSize: number;
  outlets: number;
  kycDone: number;
  kycPending: number;
  /** Achievement % per KPI code; null = no targeted outlets for that KPI. */
  kpiPercents: Record<string, number | null>;
  /** Overall score across KPIs; null = nothing to score. */
  score: number | null;
}

export interface OverviewResponse {
  mode: 'OVERVIEW';
  member: { id: string; name: string; roleLabel: string } | null;
  /** Ordered KPI columns to render in each member's grid. */
  kpis: TeamViewKpi[];
  summary: { outlets: number; kycDone: number; kycPending: number; avgScore: number | null };
  members: OverviewMember[];
  filterOptions: TeamFilterOptions;
}

/* ─── SINGLE mode (today's shape) ───────────────────────────────────────────────── */

export interface TeamViewMember {
  id: string;
  name: string;
  employeeCode: string;
  mobile: string;
  role: string;
  roleLabel: string;
  teamSize: number;
  outlets: number;
  kycDone: number;
  kycPending: number;
  outletsAchieved: number;
  outletsWithTarget: number;
  /** % of (KYC-approved, filtered, with-a-target) outlets that hit the KPI target; null = no targeted outlets. */
  achievedPct: number | null;
}

export interface SingleResponse {
  mode: 'SINGLE';
  member: { id: string; name: string; roleLabel: string; role: string; level: number } | null;
  summary: { outlets: number; kycDone: number; kycPending: number; avgTargetPct: number | null };
  members: TeamViewMember[];
  filterOptions: TeamFilterOptions;
  kpiCode: string | null;
}

/** Discriminated union on `mode`. */
export type TeamViewResponse = OverviewResponse | SingleResponse;

export interface TeamViewParams {
  memberId?: string;
  outletType?: string;
  program?: string;
  kpi?: string;
}

export function fetchTeamView(params: TeamViewParams): Promise<ApiResponse<TeamViewResponse>> {
  const qs = new URLSearchParams();
  if (params.memberId) qs.set('memberId', params.memberId);
  if (params.outletType && params.outletType !== 'ALL') qs.set('outletType', params.outletType);
  if (params.program && params.program !== 'ALL') qs.set('program', params.program);
  // kpi is ALWAYS sent; empty/absent selects OVERVIEW (the default mode).
  qs.set('kpi', params.kpi && params.kpi !== '' ? params.kpi : OVERVIEW_KPI);
  const q = qs.toString();
  return api.get<TeamViewResponse>(`/api/sales/team-view${q ? `?${q}` : ''}`);
}

/**
 * Build the `?outletType=&program=&kpi=` suffix to carry the active filters across drill-downs.
 * OVERVIEW is the default mode, so it is omitted (an absent `kpi` means OVERVIEW) to keep URLs clean.
 */
export function teamFilterQuery(f: { outletType?: string; program?: string; kpi?: string }): string {
  const qs = new URLSearchParams();
  if (f.outletType && f.outletType !== 'ALL') qs.set('outletType', f.outletType);
  if (f.program && f.program !== 'ALL') qs.set('program', f.program);
  if (f.kpi && f.kpi !== OVERVIEW_KPI) qs.set('kpi', f.kpi);
  const q = qs.toString();
  return q ? `?${q}` : '';
}
