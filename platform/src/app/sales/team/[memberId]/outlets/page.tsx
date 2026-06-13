'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft, AlertTriangle, Lock, LayoutGrid, LayoutList, ChevronRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { KYCStatus } from '@/types';
import {
  OUTLET_ACHIEVEMENTS, MEMBER_TERRITORY, XSR_OUTLETS,
  resolveConfig, pct, pctBg, pctBarColor, DEMO_PERIOD, PERIODS,
  getPrimaryParam,
  type GeoTargetConfig,
} from '@/lib/targets';

/* ─── Outlet metadata ───────────────────────────────────────────────────────── */

type OutletType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

interface OutletMeta {
  id: string;
  name: string;
  location: string;
  type: OutletType;
  kycStatus: KYCStatus;
  kycId: string;
  beat: string;
}

const OUTLET_META: Record<string, OutletMeta> = {
  o1:  { id: 'o1',  name: 'Kumar General Store', location: 'Andheri W',   type: 'SSS',     kycStatus: KYCStatus.APPROVED, kycId: 'k1', beat: 'Andheri Beat'  },
  o2:  { id: 'o2',  name: 'Star Kirana',          location: 'Andheri E',   type: 'SSS',     kycStatus: KYCStatus.APPROVED, kycId: 'k2', beat: 'Andheri Beat'  },
  o3:  { id: 'o3',  name: 'Raj Provisions',        location: 'Chakala',     type: 'WHOLESALER',   kycStatus: KYCStatus.PENDING,  kycId: 'k3', beat: 'Andheri Beat'  },
  o4:  { id: 'o4',  name: 'Om Supermart',          location: 'Andheri W',   type: 'SSS',     kycStatus: KYCStatus.APPROVED, kycId: 'k4', beat: 'Andheri Beat'  },
  o5:  { id: 'o5',  name: 'Juhu Mart',             location: 'Juhu',        type: 'SSS',     kycStatus: KYCStatus.APPROVED, kycId: 'k5', beat: 'Juhu Beat'     },
  o6:  { id: 'o6',  name: 'Beach Provisions',      location: 'JVPD',        type: 'WHOLESALER',   kycStatus: KYCStatus.PENDING,  kycId: 'k1', beat: 'Juhu Beat'     },
  o7:  { id: 'o7',  name: 'Gulshan Stores',        location: 'Vile Parle',  type: 'SSS',     kycStatus: KYCStatus.REJECTED, kycId: 'k2', beat: 'Juhu Beat'     },
  o8:  { id: 'o8',  name: 'Versova Daily Needs',   location: 'Versova',     type: 'SSS',     kycStatus: KYCStatus.APPROVED, kycId: 'k3', beat: 'Versova Beat'  },
  o9:  { id: 'o9',  name: 'Royal Kirana',          location: 'Andheri W',   type: 'SSS',     kycStatus: KYCStatus.APPROVED, kycId: 'k4', beat: 'Versova Beat'  },
  o10: { id: 'o10', name: 'Four Seasons Mart',     location: 'Lokhandwala', type: 'WHOLESALER',   kycStatus: KYCStatus.PENDING,  kycId: 'k5', beat: 'Versova Beat'  },
  o11: { id: 'o11', name: 'Nagar General',         location: 'DN Nagar',    type: 'SSS',     kycStatus: KYCStatus.PENDING,  kycId: 'k1', beat: 'DN Nagar Beat' },
  o12: { id: 'o12', name: 'Sunrise Provisions',    location: 'Amboli',      type: 'WHOLESALER',   kycStatus: KYCStatus.APPROVED, kycId: 'k2', beat: 'DN Nagar Beat' },
  o13: { id: 'o13', name: 'Regal Stores',          location: 'DN Nagar',    type: 'SUB_STOCKIST', kycStatus: KYCStatus.REJECTED, kycId: 'k3', beat: 'DN Nagar Beat' },
};

/* ─── Member hierarchy data ─────────────────────────────────────────────────── */

const MEMBER_NAMES: Record<string, { name: string; role: string; territory: string }> = {
  xsr1: { name: 'Anil Sharma',     role: 'XSR', territory: 'Andheri Beat'  },
  xsr2: { name: 'Divya Pillai',    role: 'XSR', territory: 'Juhu Beat'     },
  xsr3: { name: 'Kiran Rao',       role: 'XSR', territory: 'Versova Beat'  },
  xsr4: { name: 'Meena Joshi',     role: 'XSR', territory: 'DN Nagar Beat' },
  so1:  { name: 'Rajesh Kumar',    role: 'SO',  territory: 'Mumbai West'   },
  so2:  { name: 'Nisha Verma',     role: 'SO',  territory: 'Mumbai East'   },
  so3:  { name: 'Arjun Patil',     role: 'SO',  territory: 'Thane City'    },
  so4:  { name: 'Sunita Desai',    role: 'SO',  territory: 'Navi Mumbai'   },
  asm1: { name: 'Priya Mehta',     role: 'ASM', territory: 'Mumbai Zone'   },
  asm2: { name: 'Rohit Deshpande', role: 'ASM', territory: 'Pune Zone'     },
  asm3: { name: 'Sonal Agrawal',   role: 'ASM', territory: 'Nashik Zone'   },
  asm4: { name: 'Vikram Bhosale',  role: 'ASM', territory: 'Nagpur Zone'   },
  rsm1: { name: 'Suresh Nair',     role: 'RSM', territory: 'Maharashtra'   },
  zm1:  { name: 'Deepak Gupta',    role: 'ZNM', territory: 'West Zone'     },
};

/** Direct-report member IDs (manager → [reportIds]) */
const MEMBER_REPORTS: Record<string, string[]> = {
  so1:  ['xsr1', 'xsr2', 'xsr3', 'xsr4'],
  so2:  [],
  so3:  [],
  so4:  [],
  asm1: ['so1', 'so2', 'so3', 'so4'],
  asm2: [],
  asm3: [],
  asm4: [],
  rsm1: ['asm1', 'asm2', 'asm3', 'asm4'],
  zm1:  ['rsm1'],
};

/** Recursively collect outlet IDs for a member's entire tree */
function collectOutletIds(memberId: string): string[] {
  if (XSR_OUTLETS[memberId]) return XSR_OUTLETS[memberId];
  const reports = MEMBER_REPORTS[memberId] ?? [];
  return reports.flatMap(collectOutletIds);
}

/* ─── KYC badge config ──────────────────────────────────────────────────────── */

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
  [KYCStatus.NOT_STARTED]:           { variant: 'default', label: 'KYC Pending'   },
  [KYCStatus.NOT_INTERESTED]:        { variant: 'default', label: 'Not Interested'},
};

/* ─── Pace strip ────────────────────────────────────────────────────────────── */

function paceStrip(achievePct: number, period: string): string {
  const [year, month] = period.split('-').map(Number);
  const today       = new Date();
  const daysInMonth = new Date(year, month, 0).getDate();
  const isCurrentMonth =
    today.getFullYear() === year && today.getMonth() + 1 === month;
  const elapsed = isCurrentMonth ? today.getDate() : daysInMonth;
  const timePct = Math.round((elapsed / daysInMonth) * 100);
  const gap     = timePct - achievePct;
  if (gap <= 0)  return 'bg-emerald-400';
  if (gap <= 15) return 'bg-amber-400';
  return 'bg-red-400';
}

/* ─── Filter constants ──────────────────────────────────────────────────────── */

const TYPE_FILTERS: { value: OutletType | 'ALL'; label: string }[] = [
  { value: 'ALL',          label: 'All'          },
  { value: 'SSS',          label: 'SSS'          },
  { value: 'WHOLESALER',   label: 'Wholesaler'   },
  { value: 'SUB_STOCKIST', label: 'Sub-Stockist' },
];

/* ─── Page ──────────────────────────────────────────────────────────────────── */

export default function MemberOutletsPage() {
  const params   = useParams();
  const memberId = Array.isArray(params.memberId) ? params.memberId[0] : (params.memberId ?? '');

  const member      = MEMBER_NAMES[memberId];
  const allOutletIds = useMemo(() => collectOutletIds(memberId), [memberId]);

  const [period,     setPeriod]     = useState(DEMO_PERIOD);
  const [loading,    setLoading]    = useState(true);
  const [config,     setConfig]     = useState<GeoTargetConfig | null>(null);
  const [view,       setView]       = useState<'table' | 'cards'>('cards');
  const [typeFilter, setTypeFilter] = useState<OutletType | 'ALL'>('ALL');
  const [beatFilter, setBeatFilter] = useState<string>('ALL');

  // Cards on mobile, table on desktop
  useEffect(() => {
    const update = () => setView(window.innerWidth < 768 ? 'cards' : 'table');
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Resolve config when period changes
  useEffect(() => {
    setLoading(true);
    const territory = MEMBER_TERRITORY[memberId];
    const t = setTimeout(() => {
      if (territory) {
        setConfig(resolveConfig(territory.beat, territory.district, territory.state, period));
      }
      setLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [memberId, period]);

  const params2 = config?.params ?? [];
  const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? period;

  // All beats from this member's outlets
  const allBeats = useMemo(() => {
    const beats = new Set(allOutletIds.map((id) => OUTLET_META[id]?.beat).filter(Boolean));
    return ['ALL', ...Array.from(beats).sort()];
  }, [allOutletIds]);

  // Resolve outlet objects for this member
  const allOutlets = useMemo(
    () => allOutletIds.map((id) => OUTLET_META[id]).filter(Boolean) as OutletMeta[],
    [allOutletIds],
  );

  // Apply filters
  const visibleOutlets = useMemo(() => allOutlets.filter((o) => {
    const matchesType = typeFilter === 'ALL' || o.type === typeFilter;
    const matchesBeat = beatFilter === 'ALL' || o.beat === beatFilter;
    return matchesType && matchesBeat;
  }), [allOutlets, typeFilter, beatFilter]);

  // Sort: worst-performing approved first, non-KYC last
  const sortedOutlets = useMemo(() => {
    const avgPct = (o: OutletMeta) => {
      if (!params2.length) return 0;
      const ach = OUTLET_ACHIEVEMENTS[o.id];
      return params2.reduce((s, p) => s + pct(ach?.achievements[p.id] ?? 0, p.target), 0) / params2.length;
    };
    const approved = visibleOutlets
      .filter((o) => o.kycStatus === KYCStatus.APPROVED)
      .sort((a, b) => avgPct(a) - avgPct(b));
    const others = visibleOutlets.filter((o) => o.kycStatus !== KYCStatus.APPROVED);
    return [...approved, ...others];
  }, [visibleOutlets, params2]);

  const approvedCount = visibleOutlets.filter((o) => o.kycStatus === KYCStatus.APPROVED).length;
  const filteredCount = allOutlets.length - visibleOutlets.length;

  // Show beat filter only for XSR/SO-level members with multiple beats
  const showBeatFilter = allBeats.length > 2;

  const monthlyPeriods = useMemo(() => PERIODS.filter((p) => !p.value.includes('Q')), []);

  if (!member) {
    return (
      <div className="flex flex-col items-center justify-center min-h-48 gap-3">
        <AlertTriangle className="h-8 w-8 text-gray-300" />
        <p className="text-sm text-gray-400">Member not found</p>
        <Link href="/sales/team" className="text-xs text-[#16a34a] font-semibold hover:underline">
          Back to team
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 fade-in">

      {/* Back nav + title */}
      <div className="flex items-center gap-2">
        <Link
          href={`/sales/team/${memberId}`}
          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500 shrink-0"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-gray-900 leading-tight truncate">
            {member.name}&apos;s Outlets
          </h1>
          <p className="text-xs text-gray-400">
            {member.role} · {member.territory} ·{' '}
            <span className="font-medium text-gray-600">{allOutlets.length} outlets</span>
          </p>
        </div>
        {/* View toggle */}
        <div className="ml-auto flex bg-gray-100 rounded-lg p-0.5 gap-0.5 shrink-0">
          {([
            { v: 'table', Icon: LayoutList,  label: 'Table' },
            { v: 'cards', Icon: LayoutGrid,  label: 'Cards' },
          ] as const).map(({ v, Icon, label }) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-label={label}
              title={label}
              className={`p-2 rounded-md transition-all ${view === v ? 'bg-white text-[#16a34a] shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      {/* Filter strip */}
      <div className="flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {/* Period */}
        <div className="relative shrink-0">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="appearance-none text-[11px] font-semibold border border-gray-200 rounded-full pl-2.5 pr-6 py-1 bg-white text-gray-800 focus:outline-none focus:border-[#16a34a] cursor-pointer transition-colors"
          >
            {monthlyPeriods.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 text-gray-400" viewBox="0 0 10 6" fill="none">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        <div className="h-4 w-px bg-gray-200 shrink-0" />

        {/* Beat (only when member spans multiple beats) */}
        {showBeatFilter && (
          <div className="relative shrink-0">
            <select
              value={beatFilter}
              onChange={(e) => setBeatFilter(e.target.value)}
              className={`appearance-none text-[11px] font-semibold border rounded-full pl-2.5 pr-6 py-1 bg-white focus:outline-none transition-colors cursor-pointer ${
                beatFilter !== 'ALL' ? 'border-[#16a34a] text-[#16a34a]' : 'border-gray-200 text-gray-600 focus:border-[#16a34a]'
              }`}
            >
              {allBeats.map((beat) => (
                <option key={beat} value={beat}>{beat === 'ALL' ? 'All Beats' : beat}</option>
              ))}
            </select>
            <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${beatFilter !== 'ALL' ? 'text-[#16a34a]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}

        {/* Type */}
        <div className="relative shrink-0">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as OutletType | 'ALL')}
            className={`appearance-none text-[11px] font-semibold border rounded-full pl-2.5 pr-6 py-1 bg-white focus:outline-none transition-colors cursor-pointer ${
              typeFilter !== 'ALL' ? 'border-[#16a34a] text-[#16a34a]' : 'border-gray-200 text-gray-600 focus:border-[#16a34a]'
            }`}
          >
            {TYPE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.value === 'ALL' ? 'All Types' : f.label}</option>
            ))}
          </select>
          <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${typeFilter !== 'ALL' ? 'text-[#16a34a]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      {/* No outlets in tree */}
      {allOutlets.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-10 bg-gray-50 rounded-2xl border border-gray-100">
          <AlertTriangle className="h-8 w-8 text-gray-300" />
          <p className="text-sm font-medium text-gray-500">No outlet data available</p>
          <p className="text-xs text-gray-400 text-center px-6">
            Outlet performance data is not yet linked for this member.
          </p>
        </div>
      )}

      {loading && allOutlets.length > 0 ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : !config && allOutlets.length > 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 bg-amber-50 rounded-2xl border border-amber-100">
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <p className="text-sm text-amber-700 font-medium">No targets set for {periodLabel}</p>
          <p className="text-xs text-amber-500">Admin needs to configure targets for this territory</p>
        </div>
      ) : config && allOutlets.length > 0 ? (
        <>
          {/* ── TABLE VIEW ── */}
          {view === 'table' && visibleOutlets.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {periodLabel} · {member.territory}
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
                <table className="w-full text-left" style={{ minWidth: `${180 + params2.length * 105}px` }}>
                  <thead className="border-b border-gray-100 bg-gray-50/50">
                    <tr className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                      <th className="py-3 pl-4 pr-3 sticky left-0 bg-gray-50/80 z-10 min-w-[160px]">Outlet</th>
                      {params2.map((p) => (
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
                      const isApproved = outlet.kycStatus === KYCStatus.APPROVED;
                      const ach = OUTLET_ACHIEVEMENTS[outlet.id];
                      const avgPct = isApproved && params2.length > 0
                        ? Math.round(params2.reduce((s, p) => s + pct(ach?.achievements[p.id] ?? 0, p.target), 0) / params2.length)
                        : 0;
                      return (
                        <tr
                          key={outlet.id}
                          className="hover:bg-gray-50 transition-colors group cursor-pointer"
                        >
                          <td className="py-2.5 pl-4 pr-3 sticky left-0 bg-white group-hover:bg-gray-50 z-10 transition-colors">
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-gray-900 truncate max-w-[110px]">{outlet.name}</p>
                              <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                                <Badge variant={kycBadge[outlet.kycStatus].variant} className="text-[8px] px-1 py-0">
                                  {kycBadge[outlet.kycStatus].label}
                                </Badge>
                                {isApproved && (
                                  <span className={`text-[9px] font-bold px-1 py-0.5 rounded-full ${pctBg(avgPct)}`}>
                                    {avgPct}%
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          {params2.map((p) => {
                            const achieved = isApproved ? (ach?.achievements[p.id] ?? 0) : null;
                            const pp = achieved !== null ? pct(achieved, p.target) : 0;
                            const fmt = (n: number) => p.unit === '₹L' ? `₹${n}L` : `${n}`;
                            const cellBg = achieved !== null
                              ? (pp >= 100 ? 'bg-emerald-50' : pp >= 80 ? 'bg-amber-50' : pp >= 60 ? 'bg-orange-50' : 'bg-rose-50')
                              : '';
                            return isApproved && achieved !== null ? (
                              <td key={p.id} className={`px-3 py-2.5 min-w-[96px] ${cellBg}`}>
                                <div className="flex items-baseline justify-between gap-1">
                                  <span className="text-xs font-semibold text-gray-800">
                                    {fmt(achieved)}
                                    <span className="text-[10px] font-normal text-gray-400"> /{fmt(p.target)}</span>
                                  </span>
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${pctBg(pp)}`}>{pp}%</span>
                                </div>
                              </td>
                            ) : (
                              <td key={p.id} className="px-3 py-2.5 text-center">
                                <span className="text-[10px] text-gray-300">–</span>
                              </td>
                            );
                          })}
                          <td className="pl-3 pr-4 py-2.5">
                            <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
                          </td>
                        </tr>
                      );
                    })}
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
                className="text-xs text-[#16a34a] font-semibold hover:underline mt-1"
              >
                Clear all filters
              </button>
            </div>
          )}

          {/* ── CARDS VIEW ── */}
          {view === 'cards' && visibleOutlets.length > 0 && (
            <div className="space-y-3">
              {sortedOutlets.map((outlet) => {
                const isApproved = outlet.kycStatus === KYCStatus.APPROVED;
                const ach        = OUTLET_ACHIEVEMENTS[outlet.id];
                const svParam    = getPrimaryParam(params2);
                const kpiParams  = params2.filter((p) => !p.isPrimary);

                const svAchieved = ach?.achievements[svParam?.id ?? ''] ?? 0;
                const svPct      = svParam ? pct(svAchieved, svParam.target) : 0;
                const stripClass = isApproved ? paceStrip(svPct, period) : 'bg-gray-100';

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
                        <p className="text-[11px] text-gray-400 mt-0.5">{outlet.location} · {outlet.beat}</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                    </div>

                    {isApproved ? (
                      <>
                        {/* Monthly Target progress bar */}
                        {svParam && (() => {
                          const achieved = ach?.achievements[svParam.id] ?? 0;
                          const pp  = pct(achieved, svParam.target);
                          const fmt = (n: number) => svParam.unit === '₹L' ? `₹${n}L` : `${n}`;
                          return (
                            <div className="px-4 pt-2 pb-2.5 border-t border-gray-200">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px] font-semibold text-gray-600">{svParam.label}</span>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[14px] font-bold text-gray-800">
                                    {fmt(achieved)}
                                    <span className="text-[12px] text-gray-400 font-normal"> /{fmt(svParam.target)} {svParam.unit}</span>
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

                        {/* KPI grid */}
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
                  </Link>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
