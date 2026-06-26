'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronRight, Users, AlertTriangle, Lock, LayoutList, LayoutGrid, Eye,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { PERIODS, CURRENT_MONTH, pct, pctBg, pctBarColor, getPrimaryParam } from '@/lib/targets';
import { KYCStatus } from '@/types';
import { getRole, type SalesRole } from '@/lib/sales-role';
import { classifyPaceGap } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';
import {
  fetchOutletVisibilityStatuses,
  VISIBILITY_ELIGIBLE_OUTLET_TYPES,
  type VisibilityStatusMap,
} from '@/lib/visibility-upload';

/* ─── Outlet roster ─────────────────────────────────────────────────────────── */

type OutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST' | 'SSS_TOT';

interface Outlet {
  id:         string;
  kycId:      string;
  outletCode: string;  // matches Outlet.outletCode in DB (used for target + visibility lookup)
  name:       string;
  location:   string;
  beat:       string;
  district:   string;
  state:      string;
  type:       OutletType;
  kycStatus:  KYCStatus;
}

/* ─── Real per-outlet target data (GET /api/sales/outlet-targets) ─────────────── */

interface KpiCol { code: string; name: string; unit: string; isPrimary: boolean; }
type OutletKpis = Record<string, { target: number | null; achieved: number | null; pace: number | null }>;

const TYPE_FILTERS: { value: OutletType | 'ALL'; label: string }[] = [
  { value: 'ALL',          label: 'All'          },
  { value: 'SSS',     label: 'SSS'     },
  { value: 'WHOLESALER',   label: 'Wholesaler'   },
  { value: 'SUB_STOCKIST', label: 'Sub-Stockist' },
];

const kycBadge: Record<KYCStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string }> = {
  [KYCStatus.APPROVED]:              { variant: 'success', label: 'Approved'      },
  [KYCStatus.PENDING]:               { variant: 'warning', label: 'Draft'         },
  [KYCStatus.SUBMITTED]:             { variant: 'info',    label: 'Submitted'     },
  [KYCStatus.UNDER_REVIEW]:          { variant: 'info',    label: 'In Review'     },
  [KYCStatus.PENDING_SO_APPROVAL]:   { variant: 'warning', label: 'Awaiting SO'   },
  [KYCStatus.PENDING_ASM_APPROVAL]:  { variant: 'warning', label: 'Awaiting ASM'  },
  [KYCStatus.PENDING_RSM_APPROVAL]:  { variant: 'warning', label: 'Awaiting RSM'  },
  [KYCStatus.PENDING_GIFSY]:         { variant: 'info',    label: 'Gifsy Review'  },
  [KYCStatus.REJECTED]:              { variant: 'danger',  label: 'Rejected'      },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger',  label: 'Re-upload'     },
  [KYCStatus.RE_KYC_REQUIRED]:       { variant: 'warning', label: 'Re-KYC'        },
  [KYCStatus.NOT_STARTED]:           { variant: 'default', label: 'KYC Pending'      },
  [KYCStatus.NOT_INTERESTED]:        { variant: 'default', label: 'Not Interested'   },
};

/* ─── Pace-based traffic light ─────────────────────────────────────────────── */

/** Compare % of month elapsed vs % of target achieved → CSS bg class for the card strip. */
function paceStrip(achievePct: number, period: string): string {
  const [year, month] = period.split('-').map(Number);
  const today    = new Date();
  const daysInMonth  = new Date(year, month, 0).getDate();
  const isCurrentMonth =
    today.getFullYear() === year && today.getMonth() + 1 === month;
  const elapsed  = isCurrentMonth ? today.getDate() : daysInMonth;
  const timePct  = Math.round((elapsed / daysInMonth) * 100);
  const gap      = timePct - achievePct;          // positive = behind pace
  const status   = classifyPaceGap(gap, timePct, getGifsySettings().paceAmberThreshold ?? 10);
  if (status === 'green') return 'bg-emerald-400';
  if (status === 'amber') return 'bg-amber-400';
  return 'bg-red-400';
}

/** Overall achievement % for an outlet = its primary KPI's pace, else the avg of KPIs with a target. */
function outletOverallPct(kpis: OutletKpis, primaryCode: string | null): number {
  if (primaryCode) {
    const k = kpis[primaryCode];
    if (k && k.target && k.target > 0) return pct(k.achieved ?? 0, k.target);
  }
  const withTarget = Object.values(kpis).filter((k) => k.target && k.target > 0);
  if (withTarget.length === 0) return 0;
  return Math.round(withTarget.reduce((s, k) => s + pct(k.achieved ?? 0, k.target ?? 0), 0) / withTarget.length);
}

const fmtNum = (n: number | null) => (n === null ? '–' : n.toLocaleString('en-IN'));

/* ─── Achievement cell (real target + achieved) ──────────────────────────────── */

function AchCell({ achieved, target }: { achieved: number | null; target: number | null }) {
  if (target === null && achieved === null) {
    return <td className="px-3 py-2.5 text-center"><span className="text-[10px] text-gray-300">–</span></td>;
  }
  const p      = target ? pct(achieved ?? 0, target) : 0;
  const cls    = pctBg(p);
  const cellBg = p >= 100 ? 'bg-emerald-50' : p >= 80 ? 'bg-amber-50' : p >= 60 ? 'bg-orange-50' : 'bg-rose-50';

  return (
    <td className={`px-3 py-2.5 min-w-[96px] ${cellBg}`}>
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-xs font-semibold text-gray-800">
          {fmtNum(achieved)}
          <span className="text-[10px] font-normal text-gray-400"> /{fmtNum(target)}</span>
        </span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${cls}`}>{p}%</span>
      </div>
    </td>
  );
}

/* ─── Visibility badge ────────────────────────────────────────────────────────── */

const VIS_CHIP_CLASS: Record<string, string> = {
  PENDING:      'bg-amber-50 text-amber-700',
  UNDER_REVIEW: 'bg-blue-50 text-blue-700',
  APPROVED:     'bg-emerald-50 text-emerald-700',
};
const VIS_LABEL: Record<string, string> = {
  PENDING: 'Pending', UNDER_REVIEW: 'Under Review', APPROVED: 'Approved',
};

/* ─── Page ──────────────────────────────────────────────────────────────────── */

export default function SalesOutletsPage() {
  const router = useRouter();
  const [outlets,    setOutlets]    = useState<Outlet[]>([]);
  const [period,     setPeriod]     = useState(CURRENT_MONTH);
  const [loading,    setLoading]    = useState(true);
  const [kpiColumns, setKpiColumns] = useState<KpiCol[]>([]);
  const [targetsByOutlet, setTargetsByOutlet] = useState<Record<string, OutletKpis>>({});
  const [view,       setView]       = useState<'table' | 'cards'>('table');
  const [typeFilter, setTypeFilter] = useState<OutletType | 'ALL'>('ALL');
  const [beatFilter, setBeatFilter] = useState<string>('ALL');
  const [role,       setRoleState]  = useState<SalesRole>('SO');

  const [visibilityMap, setVisibilityMap] = useState<VisibilityStatusMap>({});

  // Cards on portrait mobile, table on landscape / desktop
  useEffect(() => {
    const update = () => setView(window.innerWidth < 768 ? 'cards' : 'table');
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Roster (real /api/sales/outlets)
  useEffect(() => {
    setRoleState(getRole());
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
    fetch('/api/sales/outlets', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((body) => { if (body.success) setOutlets(body.data.outlets ?? []); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onStorage = () => setRoleState(getRole());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Real per-outlet KPI target vs achievement for the selected month.
  useEffect(() => {
    setLoading(true);
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
    fetch(`/api/sales/outlet-targets?period=${encodeURIComponent(period)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((body) => {
        if (body.success) {
          setKpiColumns(body.data.kpiColumns ?? []);
          const map: Record<string, OutletKpis> = {};
          for (const row of (body.data.rows ?? []) as { outletCode: string; kpis: OutletKpis }[]) {
            map[row.outletCode] = row.kpis;
          }
          setTargetsByOutlet(map);
        } else {
          setKpiColumns([]); setTargetsByOutlet({});
        }
      })
      .catch(() => { setKpiColumns([]); setTargetsByOutlet({}); })
      .finally(() => setLoading(false));
  }, [period]);

  const isFieldRole = role === 'XSR' || role === 'SO';

  const allBeats = useMemo(
    () => ['ALL', ...Array.from(new Set(outlets.map((o) => o.beat).filter(Boolean))).sort()],
    [outlets],
  );

  const monthlyPeriods = useMemo(() => PERIODS.filter((p) => !p.value.includes('Q')), []);

  // Fetch visibility statuses for the selected month (RETAILER + MT outlets only)
  useEffect(() => {
    const eligibleCodes = outlets
      .filter((o) => VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(o.type))
      .map((o) => o.outletCode);
    if (eligibleCodes.length === 0) return;
    fetchOutletVisibilityStatuses(eligibleCodes, period)
      .then((map) => { if (Object.keys(map).length > 0) setVisibilityMap(map); });
  }, [period, outlets]);

  const params      = kpiColumns;
  const primaryCode = getPrimaryParam(kpiColumns)?.code ?? null;
  const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? period;

  const kpisFor = (o: Outlet): OutletKpis => targetsByOutlet[o.outletCode] ?? {};

  const visibleOutlets = useMemo(() => outlets.filter((o) => {
    const matchesType = typeFilter === 'ALL' || o.type === typeFilter;
    const matchesBeat = beatFilter === 'ALL' || o.beat === beatFilter;
    return matchesType && matchesBeat;
  }), [outlets, typeFilter, beatFilter]);

  // Worst-performing approved outlets first (actionable), non-KYC at the bottom
  const sortedVisibleOutlets = useMemo(() => {
    const approved = visibleOutlets
      .filter((o) => o.kycStatus === KYCStatus.APPROVED)
      .sort((a, b) => outletOverallPct(kpisFor(a), primaryCode) - outletOverallPct(kpisFor(b), primaryCode));
    const others = visibleOutlets.filter((o) => o.kycStatus !== KYCStatus.APPROVED);
    return [...approved, ...others];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleOutlets, targetsByOutlet, primaryCode]);

  const tableGeoLabel = beatFilter !== 'ALL' ? beatFilter : 'My Outlets';

  // Team total = real sums across approved outlets, per KPI column.
  const teamSummary = useMemo(() => {
    if (!params.length) return null;
    const totals: Record<string, { achieved: number; target: number }> = {};
    params.forEach((p) => { totals[p.code] = { achieved: 0, target: 0 }; });
    visibleOutlets
      .filter((o) => o.kycStatus === KYCStatus.APPROVED)
      .forEach((o) => {
        const kpis = kpisFor(o);
        params.forEach((p) => {
          const k = kpis[p.code];
          if (!k) return;
          totals[p.code].achieved += k.achieved ?? 0;
          totals[p.code].target   += k.target ?? 0;
        });
      });
    return totals;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, visibleOutlets, targetsByOutlet]);

  const approvedCount  = visibleOutlets.filter((o) => o.kycStatus === KYCStatus.APPROVED).length;
  const filteredCount  = outlets.length - visibleOutlets.length;

  return (
    <div className="space-y-2.5 fade-in">
      {/* Row 1: title + view toggle */}
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-gray-900">
          Outlets
          <span className="text-base font-normal text-gray-400 ml-1.5">
            ({visibleOutlets.length}/{outlets.length})
          </span>
        </h1>
        <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5 shrink-0">
          {([
            { v: 'table', Icon: LayoutList,  label: 'Table' },
            { v: 'cards', Icon: LayoutGrid,  label: 'Cards' },
          ] as const).map(({ v, Icon, label }) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-label={label}
              title={label}
              className={`p-2 rounded-md transition-all ${view === v ? 'bg-white text-[var(--brand-primary)] shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: filter strip */}
      <div className="flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        <div className="relative shrink-0">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="appearance-none text-[11px] font-semibold border border-gray-200 rounded-full pl-2.5 pr-6 py-1 bg-white text-gray-800 focus:outline-none focus:border-[var(--brand-primary)] cursor-pointer transition-colors"
          >
            {monthlyPeriods.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 text-gray-400" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        <div className="h-4 w-px bg-gray-200 shrink-0" />

        {isFieldRole && (
          <div className="relative shrink-0">
            <select
              value={beatFilter}
              onChange={(e) => setBeatFilter(e.target.value)}
              className={`appearance-none text-[11px] font-semibold border rounded-full pl-2.5 pr-6 py-1 bg-white focus:outline-none transition-colors cursor-pointer ${
                beatFilter !== 'ALL' ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-gray-200 text-gray-600 focus:border-[var(--brand-primary)]'
              }`}
            >
              {allBeats.map((beat) => (
                <option key={beat} value={beat}>{beat === 'ALL' ? 'All Beats' : beat}</option>
              ))}
            </select>
            <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${beatFilter !== 'ALL' ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}

        <div className="relative shrink-0">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as OutletType | 'ALL')}
            className={`appearance-none text-[11px] font-semibold border rounded-full pl-2.5 pr-6 py-1 bg-white focus:outline-none transition-colors cursor-pointer ${
              typeFilter !== 'ALL' ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-gray-200 text-gray-600 focus:border-[var(--brand-primary)]'
            }`}
          >
            {TYPE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.value === 'ALL' ? 'All Types' : f.label}</option>
            ))}
          </select>
          <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${typeFilter !== 'ALL' ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : params.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 bg-amber-50 rounded-2xl border border-amber-100">
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <p className="text-sm text-amber-700 font-medium">No targets set for {periodLabel}</p>
          <p className="text-xs text-amber-500">Targets for your outlets haven&apos;t been uploaded for this month yet</p>
        </div>
      ) : (
        <>
          {/* ── TABLE VIEW ── */}
          {view === 'table' && visibleOutlets.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {periodLabel} · {tableGeoLabel}
                </p>
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                  <span>{visibleOutlets.length} outlets</span>
                  {filteredCount > 0 && <span className="text-gray-300">· {filteredCount} filtered</span>}
                  {approvedCount < visibleOutlets.length && (
                    <span className="text-amber-500">· {visibleOutlets.length - approvedCount} KYC pending</span>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left" style={{ minWidth: `${180 + params.length * 105}px` }}>
                  <thead className="border-b border-gray-100 bg-gray-50/50">
                    <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                      <th className="py-3 pl-4 pr-3 sticky left-0 bg-gray-50/80 z-10 min-w-[160px]">Outlet</th>
                      {params.map((p) => (
                        <th key={p.code} className="py-3 px-3 min-w-[92px]">
                          <span className="block truncate max-w-[88px]">{p.name}</span>
                          <span className="block font-normal text-gray-300 normal-case">{p.unit}</span>
                        </th>
                      ))}
                      <th className="py-3 pl-3 pr-4 w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {/* Approved outlets first, then the rest — same ordering as the
                        cards view (sortedVisibleOutlets), so the table matches. */}
                    {sortedVisibleOutlets.map((outlet) => {
                      const isKycApproved = outlet.kycStatus === KYCStatus.APPROVED;
                      const kpis = kpisFor(outlet);
                      const avgPct = isKycApproved ? outletOverallPct(kpis, primaryCode) : 0;
                      // When the outlet has no KYC submission yet (NOT_STARTED / master-
                      // uploaded), `kycId` is empty → `/sales/kyc/` is a dead "KYC not
                      // found" route. Send the rep to the start wizard pre-selected on
                      // this outlet instead. With a kycId, deep-link to the detail.
                      const href = outlet.kycId
                        ? `/sales/kyc/${outlet.kycId}`
                        : `/sales/kyc/new?outletId=${outlet.id}`;
                      return (
                        <tr
                          key={outlet.id}
                          onClick={() => router.push(href)}
                          className="hover:bg-gray-50 transition-colors group cursor-pointer"
                        >
                          <td className="py-2.5 pl-4 pr-3 sticky left-0 bg-white group-hover:bg-gray-50 z-10 transition-colors">
                            <div className="flex items-center gap-2">
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-gray-900 truncate max-w-[110px]">{outlet.name}</p>
                                <p className="text-[9px] font-mono text-gray-400 leading-tight">{outlet.outletCode}</p>
                                <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                                  <Badge variant={kycBadge[outlet.kycStatus].variant} className="text-[8px] px-1 py-0">
                                    {kycBadge[outlet.kycStatus].label}
                                  </Badge>
                                  {isKycApproved && Object.keys(kpis).length > 0 && (
                                    <span className={`text-[9px] font-bold px-1 py-0.5 rounded-full ${pctBg(avgPct)}`}>
                                      {avgPct}%
                                    </span>
                                  )}
                                  {VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(outlet.type) && visibilityMap[outlet.outletCode] && (
                                    <span className={`text-[8px] font-semibold px-1 py-0 rounded-full leading-tight ${VIS_CHIP_CLASS[visibilityMap[outlet.outletCode].status] ?? ''}`}>
                                      Visibility: {VIS_LABEL[visibilityMap[outlet.outletCode].status] ?? visibilityMap[outlet.outletCode].status}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>

                          {params.map((p) => (
                            isKycApproved
                              ? <AchCell key={p.code} achieved={kpis[p.code]?.achieved ?? null} target={kpis[p.code]?.target ?? null} />
                              : <td key={p.code} className="px-3 py-2.5 text-center"><span className="text-[10px] text-gray-300">–</span></td>
                          ))}

                          <td className="pl-3 pr-4 py-2.5">
                            <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
                          </td>
                        </tr>
                      );
                    })}

                    {teamSummary && (
                      <tr className="bg-[var(--brand-primary)]/5 border-t-2 border-[var(--brand-primary)]/20">
                        <td className="py-2.5 pl-4 pr-3 sticky left-0 bg-[var(--brand-primary)]/5 z-10">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-[var(--brand-primary)]/20 flex items-center justify-center shrink-0">
                              <Users className="h-3.5 w-3.5 text-[var(--brand-primary)]" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-bold text-[var(--brand-primary)]">Team Total</p>
                              <p className="text-[9px] text-[var(--brand-primary)]/60">{approvedCount} approved outlets</p>
                            </div>
                          </div>
                        </td>
                        {params.map((p) => {
                          const { achieved, target } = teamSummary[p.code];
                          const pp  = pct(achieved, target);
                          return (
                            <td key={p.code} className="px-3 py-2.5">
                              <p className="text-[10px] font-bold text-gray-700">
                                {fmtNum(achieved)}<span className="text-gray-400 font-normal">/{fmtNum(target)}</span>
                              </p>
                              <span className={`text-[9px] font-bold px-1 py-0.5 rounded-full ${pctBg(pp)}`}>{pp}%</span>
                            </td>
                          );
                        })}
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Empty state */}
          {visibleOutlets.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 bg-gray-50 rounded-2xl border border-gray-100">
              <AlertTriangle className="h-7 w-7 text-gray-300" />
              <p className="text-sm text-gray-400">No outlets match the selected filters</p>
              <button
                onClick={() => { setTypeFilter('ALL'); setBeatFilter('ALL'); }}
                className="text-xs text-[var(--brand-primary)] font-semibold hover:underline mt-1"
              >
                Clear all filters
              </button>
            </div>
          )}

          {/* ── CARDS VIEW ── */}
          {view === 'cards' && visibleOutlets.length > 0 && (
            <div className="space-y-3">
              {sortedVisibleOutlets.map((outlet) => {
                const isKycApproved = outlet.kycStatus === KYCStatus.APPROVED;
                const kpis      = kpisFor(outlet);
                const svParam   = getPrimaryParam(params);
                const kpiParams = params.filter((p) => !p.isPrimary);

                const svK    = svParam ? kpis[svParam.code] : undefined;
                const svPct  = svParam && svK?.target ? pct(svK.achieved ?? 0, svK.target) : 0;
                const stripClass = isKycApproved ? paceStrip(svPct, period) : 'bg-gray-100';

                return (
                  <Link
                    key={outlet.id}
                    // No submission yet → start wizard (else the empty kycId yields a dead
                    // /sales/kyc/ → "KYC not found"). With a kycId → detail deep-link.
                    href={
                      outlet.kycId
                        ? `/sales/kyc/${outlet.kycId}`
                        : `/sales/kyc/new?outletId=${outlet.id}`
                    }
                    className="block bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm hover:shadow-md transition-all active:scale-[0.99]"
                  >
                    <div className={`h-1 ${stripClass}`} />

                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-base font-bold text-gray-900 truncate">{outlet.name}</p>
                          {outlet.kycStatus !== KYCStatus.APPROVED && (
                            <Badge variant={kycBadge[outlet.kycStatus].variant} className="shrink-0 text-[9px]">
                              {kycBadge[outlet.kycStatus].label}
                            </Badge>
                          )}
                        </div>
                        <p className="text-[10px] font-mono text-gray-400 leading-tight mt-0.5">{outlet.outletCode}</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                    </div>

                    {isKycApproved ? (
                      Object.keys(kpis).length === 0 ? (
                        <div className="border-t border-gray-50 px-4 py-1.5 flex items-center gap-1.5">
                          <p className="text-[11px] text-gray-400">No targets uploaded for this outlet this month</p>
                        </div>
                      ) : (
                        <>
                          {svParam && svK && (
                            <div className="px-4 pt-2 pb-2.5 border-t border-gray-200">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px] font-semibold text-gray-600">{svParam.name}</span>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[14px] font-bold text-gray-800">
                                    {fmtNum(svK.achieved)}<span className="text-[12px] text-gray-400 font-normal"> /{fmtNum(svK.target)}{svParam.unit ? ` ${svParam.unit}` : ''}</span>
                                  </span>
                                  <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${pctBg(svPct)}`}>{svPct}%</span>
                                </div>
                              </div>
                              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${pctBarColor(svPct)}`} style={{ width: `${Math.min(svPct, 100)}%` }} />
                              </div>
                            </div>
                          )}

                          {kpiParams.length > 0 && (
                            <div className="border-t border-gray-200 px-4 pt-2.5 pb-3 grid grid-cols-2 gap-x-3 gap-y-3">
                              {kpiParams.map((p) => {
                                const k = kpis[p.code];
                                const pp = k?.target ? pct(k.achieved ?? 0, k.target) : 0;
                                return (
                                  <div key={p.code} className="border-l-[3px] border-gray-200 pl-2">
                                    <p className="text-[11px] font-semibold text-gray-600 truncate leading-tight">{p.name}</p>
                                    <div className="flex items-center justify-between mt-0.5">
                                      <p className="text-[15px] font-bold text-gray-900 leading-tight">
                                        {fmtNum(k?.achieved ?? null)}
                                        <span className="text-[12px] font-semibold text-gray-500"> /{fmtNum(k?.target ?? null)}</span>
                                      </p>
                                      <span className={`text-[12px] font-bold px-1.5 py-0.5 rounded-full ${pctBg(pp)}`}>{pp}%</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </>
                      )
                    ) : (
                      <div className="border-t border-gray-50 px-4 py-1.5 flex items-center gap-1.5">
                        <Lock className="h-3 w-3 text-gray-300" />
                        <p className="text-[11px] text-gray-400">Complete KYC to track targets</p>
                      </div>
                    )}

                    {VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(outlet.type) && visibilityMap[outlet.outletCode] && (
                      <div className="border-t border-gray-100 px-4 py-2 flex items-center gap-1.5">
                        <Eye className="h-3 w-3 text-gray-400 shrink-0" />
                        <span className="text-[11px] text-gray-500 font-medium">Visibility:</span>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${VIS_CHIP_CLASS[visibilityMap[outlet.outletCode].status] ?? ''}`}>
                          {VIS_LABEL[visibilityMap[outlet.outletCode].status] ?? visibilityMap[outlet.outletCode].status}
                        </span>
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
