'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronRight, Users, AlertTriangle, Lock, LayoutList, LayoutGrid, Eye,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import {
  type GeoTargetConfig, type TargetParam,
  PERIODS, OUTLET_ACHIEVEMENTS,
  resolveConfig, pct, pctBg, pctBarColor,
  DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE,
  getPrimaryParam,
} from '@/lib/targets';
import { KYCStatus } from '@/types';
import { getRole, type SalesRole } from '@/lib/sales-role';
import { classifyPaceGap } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';
import {
  fetchOutletVisibilityStatuses,
  VISIBILITY_ELIGIBLE_OUTLET_TYPES,
  DEMO_VISIBILITY_MAP,
  type VisibilityStatusMap,
} from '@/lib/visibility-upload';

/* ─── Outlet roster ─────────────────────────────────────────────────────────── */

type OutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST' | 'SSS_TOT';

interface Outlet {
  id:         string;
  kycId:      string;
  outletCode: string;  // matches Outlet.outletCode in DB (used for visibility lookup)
  name:       string;
  location:   string;
  beat:       string;
  district:   string;
  state:      string;
  type:       OutletType;
  kycStatus:  KYCStatus;
}

const OUTLETS: Outlet[] = [
  // Andheri Beat
  { id: 'o1',  kycId: 'k1', outletCode: 'OUT-MH-2841', name: 'Kumar General Store', location: 'Andheri West',    beat: 'Andheri Beat',  district: 'Mumbai West', state: 'Maharashtra', type: 'SSS',     kycStatus: KYCStatus.APPROVED  },
  { id: 'o2',  kycId: 'k2', outletCode: 'OUT-MH-2842', name: 'Sharma Kirana',       location: 'Andheri East',    beat: 'Andheri Beat',  district: 'Mumbai West', state: 'Maharashtra', type: 'SSS',     kycStatus: KYCStatus.PENDING   },
  { id: 'o9',  kycId: 'k1', outletCode: 'OUT-MH-2849', name: 'Andheri Mart',        location: 'Andheri Station', beat: 'Andheri Beat',  district: 'Mumbai West', state: 'Maharashtra', type: 'WHOLESALER',   kycStatus: KYCStatus.APPROVED  },
  // Juhu Beat
  { id: 'o3',  kycId: 'k3', outletCode: 'OUT-MH-2843', name: 'Patel Grocery',       location: 'Juhu Scheme',     beat: 'Juhu Beat',     district: 'Mumbai West', state: 'Maharashtra', type: 'SSS',     kycStatus: KYCStatus.REJECTED  },
  { id: 'o4',  kycId: 'k4', outletCode: 'OUT-MH-2844', name: 'Singh Supermart',     location: 'Vile Parle West', beat: 'Juhu Beat',     district: 'Mumbai West', state: 'Maharashtra', type: 'WHOLESALER',   kycStatus: KYCStatus.APPROVED  },
  { id: 'o10', kycId: 'k4', outletCode: 'OUT-MH-2850', name: 'Juhu Corner Store',   location: 'Juhu Beach Road', beat: 'Juhu Beat',     district: 'Mumbai West', state: 'Maharashtra', type: 'SSS',     kycStatus: KYCStatus.APPROVED  },
  // Versova Beat
  { id: 'o5',  kycId: 'k5', outletCode: 'OUT-MH-2845', name: 'Mehta Provisions',    location: 'Versova Village', beat: 'Versova Beat',  district: 'Mumbai West', state: 'Maharashtra', type: 'SUB_STOCKIST', kycStatus: KYCStatus.SUBMITTED },
  { id: 'o6',  kycId: 'k1', outletCode: 'OUT-MH-2846', name: 'Versova Traders',     location: 'Four Bungalows',  beat: 'Versova Beat',  district: 'Mumbai West', state: 'Maharashtra', type: 'SSS',     kycStatus: KYCStatus.APPROVED  },
  { id: 'o11', kycId: 'k4', outletCode: 'OUT-MH-2851', name: 'Madh Island Stores',  location: 'Madh Island',     beat: 'Versova Beat',  district: 'Mumbai West', state: 'Maharashtra', type: 'WHOLESALER',   kycStatus: KYCStatus.APPROVED  },
  // DN Nagar Beat
  { id: 'o7',  kycId: 'k2', outletCode: 'OUT-MH-2847', name: 'DN Nagar Mart',       location: 'DN Nagar',        beat: 'DN Nagar Beat', district: 'Mumbai West', state: 'Maharashtra', type: 'SSS',     kycStatus: KYCStatus.APPROVED  },
  { id: 'o8',  kycId: 'k3', outletCode: 'OUT-MH-2848', name: 'Azad Nagar Grocers',  location: 'Azad Nagar',      beat: 'DN Nagar Beat', district: 'Mumbai West', state: 'Maharashtra', type: 'SUB_STOCKIST', kycStatus: KYCStatus.APPROVED  },
  { id: 'o12', kycId: 'k5', outletCode: 'OUT-MH-2852', name: 'Gilbert Hill Store',  location: 'Gilbert Hill',    beat: 'DN Nagar Beat', district: 'Mumbai West', state: 'Maharashtra', type: 'SSS',     kycStatus: KYCStatus.PENDING   },
];

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

/** Compare % of month elapsed vs % of target achieved.
 *  Returns the CSS bg class for the card-top strip. */
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

/* ─── Achievement cell ──────────────────────────────────────────────────────── */

function AchCell({ achieved, param }: { achieved: number; param: TargetParam }) {
  const p      = pct(achieved, param.target);
  const cls    = pctBg(p);
  // Heat-map cell tint — very subtle, gives instant scan-ability across columns
  const cellBg = p >= 100 ? 'bg-emerald-50' : p >= 80 ? 'bg-amber-50' : p >= 60 ? 'bg-orange-50' : 'bg-rose-50';
  const fmt    = (n: number) => param.unit === '₹L' ? `₹${n}L` : `${n}`;

  return (
    <td className={`px-3 py-2.5 min-w-[96px] ${cellBg}`}>
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-xs font-semibold text-gray-800">
          {fmt(achieved)}
          <span className="text-[10px] font-normal text-gray-400"> /{fmt(param.target)}</span>
        </span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${cls}`}>{p}%</span>
      </div>
    </td>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────────── */

// ─── Visibility badge ────────────────────────────────────────────────────────

const VIS_CHIP_CLASS: Record<string, string> = {
  PENDING:      'bg-amber-50 text-amber-700',
  UNDER_REVIEW: 'bg-blue-50 text-blue-700',
  APPROVED:     'bg-emerald-50 text-emerald-700',
};
const VIS_LABEL: Record<string, string> = {
  PENDING: 'Pending', UNDER_REVIEW: 'Under Review', APPROVED: 'Approved',
};

export default function SalesOutletsPage() {
  const router = useRouter();
  const [period,     setPeriod]     = useState('2026-05');
  const [loading,    setLoading]    = useState(true);
  const [config,     setConfig]     = useState<GeoTargetConfig | null>(null);
  const [view,       setView]       = useState<'table' | 'cards'>('table');
  const [typeFilter, setTypeFilter] = useState<OutletType | 'ALL'>('ALL');
  const [beatFilter, setBeatFilter] = useState<string>('ALL');
  const [role,       setRoleState]  = useState<SalesRole>('SO');

  // Visibility status map — starts with demo data, overwritten by API in production
  const [visibilityMap, setVisibilityMap] = useState<VisibilityStatusMap>(DEMO_VISIBILITY_MAP);

  // Cards on portrait mobile, table on landscape / desktop
  useEffect(() => {
    const update = () => setView(window.innerWidth < 768 ? 'cards' : 'table');
    update(); // set on mount
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    setRoleState(getRole());
  }, []);

  useEffect(() => {
    const onStorage = () => setRoleState(getRole());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const isFieldRole = role === 'XSR' || role === 'SO';

  // Unique beats sorted alphabetically
  const allBeats = useMemo(
    () => ['ALL', ...Array.from(new Set(OUTLETS.map((o) => o.beat))).sort()],
    [],
  );

  // Monthly periods only (no quarters)
  const monthlyPeriods = useMemo(
    () => PERIODS.filter((p) => !p.value.includes('Q')),
    [],
  );


  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      setConfig(resolveConfig(DEMO_BEAT, DEMO_DISTRICT, DEMO_STATE, period));
      setLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [period]);

  // Fetch visibility statuses for the selected month (RETAILER + MT outlets only)
  useEffect(() => {
    const eligibleCodes = OUTLETS
      .filter((o) => VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(o.type))
      .map((o) => o.outletCode);
    if (eligibleCodes.length === 0) return;
    fetchOutletVisibilityStatuses(eligibleCodes, period)
      .then((map) => {
        // Merge: API data takes precedence; demo data fills any gaps
        if (Object.keys(map).length > 0) {
          setVisibilityMap({ ...DEMO_VISIBILITY_MAP, ...map });
        }
        // If API returns empty (dev/demo mode), keep DEMO_VISIBILITY_MAP as-is
      });
  }, [period]);

  const params      = config?.params ?? [];
  const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? period;

  const visibleOutlets = useMemo(() => OUTLETS.filter((o) => {
    const matchesType = typeFilter === 'ALL' || o.type === typeFilter;
    const matchesBeat = beatFilter === 'ALL' || o.beat === beatFilter;
    return matchesType && matchesBeat;
  }), [typeFilter, beatFilter]);

  // Worst-performing approved outlets first (actionable), non-KYC at the bottom
  const sortedVisibleOutlets = useMemo(() => {
    const avgPct = (o: Outlet) => {
      if (!params.length) return 0;
      const ach = OUTLET_ACHIEVEMENTS[o.kycId];
      return params.reduce((s, p) => s + pct(ach?.achievements[p.id] ?? 0, p.target), 0) / params.length;
    };
    const approved = visibleOutlets
      .filter((o) => o.kycStatus === KYCStatus.APPROVED)
      .sort((a, b) => avgPct(a) - avgPct(b));
    const others = visibleOutlets.filter((o) => o.kycStatus !== KYCStatus.APPROVED);
    return [...approved, ...others];
  }, [visibleOutlets, params]);

  // Header context label for the table
  const tableGeoLabel = beatFilter !== 'ALL' ? beatFilter : 'Mumbai West';

  const teamSummary = useMemo(() => {
    if (!params.length) return null;
    const totals: Record<string, { achieved: number; target: number }> = {};
    params.forEach((p) => { totals[p.id] = { achieved: 0, target: 0 }; });
    visibleOutlets
      .filter((o) => o.kycStatus === KYCStatus.APPROVED)
      .forEach((o) => {
        const ach = OUTLET_ACHIEVEMENTS[o.kycId];
        params.forEach((p) => {
          totals[p.id].achieved += ach?.achievements[p.id] ?? 0;
          totals[p.id].target   += p.target;
        });
      });
    return totals;
  }, [params, visibleOutlets]);

  const approvedCount  = visibleOutlets.filter((o) => o.kycStatus === KYCStatus.APPROVED).length;
  const filteredCount  = OUTLETS.length - visibleOutlets.length;

  return (
    <div className="space-y-2.5 fade-in">
      {/* Row 1: title + view toggle (icons) */}
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-gray-900">
          Outlets
          <span className="text-base font-normal text-gray-400 ml-1.5">
            ({visibleOutlets.length}/{OUTLETS.length})
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

      {/* Row 2: unified filter strip — all dropdowns, consistent style */}
      <div className="flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {/* Period dropdown */}
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
          <svg
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 text-gray-400"
            viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        {/* Divider */}
        <div className="h-4 w-px bg-gray-200 shrink-0" />

        {/* Beat dropdown — XSR and SO only */}
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
            <svg
              className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${beatFilter !== 'ALL' ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`}
              viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}

        {/* Outlet type dropdown */}
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
          <svg
            className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${typeFilter !== 'ALL' ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`}
            viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : !config ? (
        <div className="flex flex-col items-center gap-3 py-8 bg-amber-50 rounded-2xl border border-amber-100">
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <p className="text-sm text-amber-700 font-medium">No targets set for {periodLabel}</p>
          <p className="text-xs text-amber-500">Admin needs to configure targets for your territory</p>
        </div>
      ) : (
        <>
          {/* ── TABLE VIEW ── */}
          {view === 'table' && visibleOutlets.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              {/* Table header bar */}
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {periodLabel} · {tableGeoLabel}
                </p>
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                  <span>{visibleOutlets.length} outlets</span>
                  {filteredCount > 0 && (
                    <span className="text-gray-300">· {filteredCount} filtered</span>
                  )}
                  {approvedCount < visibleOutlets.length && (
                    <span className="text-amber-500">· {visibleOutlets.length - approvedCount} KYC pending</span>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left" style={{ minWidth: `${180 + params.length * 105}px` }}>
                  <thead className="border-b border-gray-100 bg-gray-50/50">
                    <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                      {/* Wider first column — no separate Overall col */}
                      <th className="py-3 pl-4 pr-3 sticky left-0 bg-gray-50/80 z-10 min-w-[160px]">Outlet</th>
                      {params.map((p) => (
                        <th key={p.id} className="py-3 px-3 min-w-[92px]">
                          <span className="block truncate max-w-[88px]">{p.label}</span>
                          <span className="block font-normal text-gray-300 normal-case">{p.unit}</span>
                        </th>
                      ))}
                      <th className="py-3 pl-3 pr-4 w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {visibleOutlets.map((outlet) => {
                      const isKycApproved = outlet.kycStatus === KYCStatus.APPROVED;
                      const ach    = OUTLET_ACHIEVEMENTS[outlet.id];
                      const avgPct = isKycApproved && params.length > 0
                        ? Math.round(params.reduce((s, p) => s + pct(ach?.achievements[p.id] ?? 0, p.target), 0) / params.length)
                        : 0;
                      // Link to the KYC record for this outlet
                      const href = `/sales/kyc/${outlet.kycId}`;
                      return (
                        <tr
                          key={outlet.id}
                          onClick={() => router.push(href)}
                          className="hover:bg-gray-50 transition-colors group cursor-pointer"
                        >
                          {/* Sticky outlet name — overall % moved here */}
                          <td className="py-2.5 pl-4 pr-3 sticky left-0 bg-white group-hover:bg-gray-50 z-10 transition-colors">
                            <div className="flex items-center gap-2">
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-gray-900 truncate max-w-[110px]">{outlet.name}</p>
                                <p className="text-[9px] font-mono text-gray-400 leading-tight">{outlet.outletCode}</p>
                                <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                                  <Badge variant={kycBadge[outlet.kycStatus].variant} className="text-[8px] px-1 py-0">
                                    {kycBadge[outlet.kycStatus].label}
                                  </Badge>
                                  {isKycApproved && (
                                    <span className={`text-[9px] font-bold px-1 py-0.5 rounded-full ${pctBg(avgPct)}`}>
                                      {avgPct}%
                                    </span>
                                  )}
                                  {/* Visibility badge — RETAILER and MT only */}
                                  {VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(outlet.type) && visibilityMap[outlet.outletCode] && (
                                    <span className={`text-[8px] font-semibold px-1 py-0 rounded-full leading-tight ${VIS_CHIP_CLASS[visibilityMap[outlet.outletCode].status] ?? ''}`}>
                                      Visibility: {VIS_LABEL[visibilityMap[outlet.outletCode].status] ?? visibilityMap[outlet.outletCode].status}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Parameter cells */}
                          {params.map((p) => (
                            isKycApproved
                              ? <AchCell key={p.id} param={p} achieved={ach?.achievements[p.id] ?? 0} />
                              : <td key={p.id} className="px-3 py-2.5 text-center"><span className="text-[10px] text-gray-300">–</span></td>
                          ))}

                          <td className="pl-3 pr-4 py-2.5">
                            <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
                          </td>
                        </tr>
                      );
                    })}

                    {/* Team total row */}
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
                          const { achieved, target } = teamSummary[p.id];
                          const pp  = pct(achieved, target);
                          const fmt = (n: number) => p.unit === '₹L' ? `₹${n}L` : `${n}`;
                          return (
                            <td key={p.id} className="px-3 py-2.5">
                              <p className="text-[10px] font-bold text-gray-700">
                                {fmt(achieved)}<span className="text-gray-400 font-normal">/{fmt(target)}</span>
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
                const ach = OUTLET_ACHIEVEMENTS[outlet.id];
                const svParam   = getPrimaryParam(params);
                const kpiParams = params.filter((p) => !p.isPrimary);

                const svAchieved  = ach?.achievements[svParam?.id ?? ''] ?? 0;
                const svPct       = svParam ? pct(svAchieved, svParam.target) : 0;
                const stripClass  = isKycApproved ? paceStrip(svPct, period) : 'bg-gray-100';

                return (
                  <Link
                    key={outlet.id}
                    href={`/sales/kyc/${outlet.kycId}`}
                    className="block bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm hover:shadow-md transition-all active:scale-[0.99]"
                  >
                    {/* Traffic-light pace strip */}
                    <div className={`h-1 ${stripClass}`} />

                    {/* Header */}
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
                      <>
                        {/* Monthly Target progress bar — acts as header/body divider */}
                        {svParam && (() => {
                          const achieved = ach?.achievements[svParam.id] ?? 0;
                          const pp  = pct(achieved, svParam.target);
                          const fmt = (n: number) => `₹${n}L`;
                          return (
                            <div className="px-4 pt-2 pb-2.5 border-t border-gray-200">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px] font-semibold text-gray-600">Monthly Target</span>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[14px] font-bold text-gray-800">
                                    {fmt(achieved)}<span className="text-[12px] text-gray-400 font-normal"> /{fmt(svParam.target)}</span>
                                  </span>
                                  <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${pctBg(pp)}`}>{pp}%</span>
                                </div>
                              </div>
                              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${pctBarColor(pp)}`} style={{ width: `${Math.min(pp, 100)}%` }} />
                              </div>
                            </div>
                          );
                        })()}

                        {/* KPI grid — 2 columns, neutral accent border, % badge is the colour signal */}
                        {kpiParams.length > 0 && (
                          <div className="border-t border-gray-200 px-4 pt-2.5 pb-3 grid grid-cols-2 gap-x-3 gap-y-3">
                            {kpiParams.map((p) => {
                              const achieved = ach?.achievements[p.id] ?? 0;
                              const pp  = pct(achieved, p.target);
                              const fmt = (n: number) => p.unit === '₹L' ? `₹${n}L` : `${n}`;
                              return (
                                <div key={p.id} className="border-l-[3px] border-gray-200 pl-2">
                                  <p className="text-[11px] font-semibold text-gray-600 truncate leading-tight">{p.label}</p>
                                  <div className="flex items-center justify-between mt-0.5">
                                    <p className="text-[15px] font-bold text-gray-900 leading-tight">
                                      {fmt(achieved)}
                                      <span className="text-[12px] font-semibold text-gray-500"> /{fmt(p.target)}</span>
                                    </p>
                                    <span className={`text-[12px] font-bold px-1.5 py-0.5 rounded-full ${pctBg(pp)}`}>{pp}%</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="border-t border-gray-50 px-4 py-1.5 flex items-center gap-1.5">
                        <Lock className="h-3 w-3 text-gray-300" />
                        <p className="text-[11px] text-gray-400">Complete KYC to track targets</p>
                      </div>
                    )}

                    {/* Visibility badge strip — RETAILER and MT outlets only */}
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
