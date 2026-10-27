/**
 * sales-team.ts — typed client for the redesigned Team view (GET /api/sales/team-view).
 *
 * Returns, for the caller (or a drilled-into `memberId`), the filtered team summary + each
 * direct report scored by the selected KPI's "outlets achieved ÷ outlets with a target", plus
 * the filter option lists. See SalesService.getTeamView.
 */

import { api, type ApiResponse } from '@/lib/api-client';

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

export interface TeamViewResponse {
  member: { id: string; name: string; roleLabel: string; role: string; level: number } | null;
  summary: { outlets: number; kycDone: number; kycPending: number; avgTargetPct: number | null };
  members: TeamViewMember[];
  filterOptions: {
    outletTypes: { code: string; name: string }[];
    programs: string[];
    kpis: { code: string; label: string }[];
  };
  kpiCode: string | null;
}

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
  if (params.kpi) qs.set('kpi', params.kpi);
  const q = qs.toString();
  return api.get<TeamViewResponse>(`/api/sales/team-view${q ? `?${q}` : ''}`);
}

/** Build the `?outletType=&program=&kpi=` suffix to carry the active filters across drill-downs. */
export function teamFilterQuery(f: { outletType?: string; program?: string; kpi?: string }): string {
  const qs = new URLSearchParams();
  if (f.outletType && f.outletType !== 'ALL') qs.set('outletType', f.outletType);
  if (f.program && f.program !== 'ALL') qs.set('program', f.program);
  if (f.kpi) qs.set('kpi', f.kpi);
  const q = qs.toString();
  return q ? `?${q}` : '';
}
