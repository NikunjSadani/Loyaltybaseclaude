'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronRight, Users, AlertTriangle, LayoutList, LayoutGrid, Eye,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { PERIODS, CURRENT_MONTH, pct, pctBg, pctBarColor, getPrimaryParam } from '@/lib/targets';
import { kycOrderRank } from '@/lib/kyc-order';
import { KYCStatus } from '@/types';
import { getRole, type SalesRole } from '@/lib/sales-role';
import { classifyPaceGap } from '@/lib/pace';
import { getGifsySettings } from '@/lib/gifsy-settings';
import { istDateKey } from '@/lib/ist-date';
import {
  fetchOutletVisibilityStatuses,
  VISIBILITY_ELIGIBLE_OUTLET_TYPES,
  type VisibilityStatusMap,
} from '@/lib/visibility-upload';
import { visibilityApi } from '@/lib/visibility';
import { classifyVisibilityCapture, type VisibilitySummaryBucket } from '@/lib/visibility-types';
import { useClientConfig } from '@/lib/platform/client-config-context';
import { useOutletTypeLabels } from '@/lib/platform/use-outlet-type-labels';

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
  programName?: string;  // from the outlet master (sales roster payload) — drives the Program filter
}

/* ─── Real per-outlet target data (GET /api/sales/outlet-targets) ─────────────── */

interface KpiCol { code: string; name: string; unit: string; isPrimary: boolean; rollup?: 'SUM' | 'OUTLET_COUNT'; }
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
  [KYCStatus.DRAFT]:                 { variant: 'warning', label: 'Pending'       },
  [KYCStatus.SUBMITTED]:             { variant: 'info',    label: 'Submitted'     },
  [KYCStatus.UNDER_REVIEW]:          { variant: 'info',    label: 'In Review'     },
  [KYCStatus.PENDING_SO_APPROVAL]:   { variant: 'warning', label: 'Awaiting SO'   },
  [KYCStatus.PENDING_ASM_APPROVAL]:  { variant: 'warning', label: 'Awaiting ASM'  },
  [KYCStatus.PENDING_RSM_APPROVAL]:  { variant: 'warning', label: 'Awaiting RSM'  },
  [KYCStatus.PENDING_GIFSY]:         { variant: 'info',    label: 'Gifsy Review'  },
  [KYCStatus.REJECTED]:              { variant: 'danger',  label: 'Rejected'      },
  [KYCStatus.RE_UPLOAD_REQUIRED]:    { variant: 'danger',  label: 'Rejected'      },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger',  label: 'Rejected'      },
  [KYCStatus.RE_KYC_REQUIRED]:       { variant: 'warning', label: 'Re-KYC'        },
  [KYCStatus.NOT_STARTED]:           { variant: 'default', label: 'KYC Pending'      },
  [KYCStatus.NOT_INTERESTED]:        { variant: 'default', label: 'Not Interested'   },
};

/* ─── Pace-based traffic light ─────────────────────────────────────────────── */

/** Compare % of month elapsed vs % of target achieved → CSS bg class for the card strip. */
function paceStrip(achievePct: number, period: string): string {
  const [year, month] = period.split('-').map(Number);
  // "Today" resolved in IST (prod/SSR runs UTC; an off-IST clock skews pacing by a day at boundaries).
  const key      = istDateKey(new Date()); // "YYYY-MM-DD" in Asia/Kolkata
  const daysInMonth  = new Date(year, month, 0).getDate();
  const isCurrentMonth =
    Number(key.slice(0, 4)) === year && Number(key.slice(5, 7)) === month;
  const elapsed  = isCurrentMonth ? Number(key.slice(8, 10)) : daysInMonth;
  const timePct  = Math.round((elapsed / daysInMonth) * 100);
  const gap      = timePct - achievePct;          // positive = behind pace
  const status   = classifyPaceGap(gap, timePct, getGifsySettings().paceAmberThreshold ?? 10);
  if (status === 'green') return 'bg-emerald-400';
  if (status === 'amber') return 'bg-amber-400';
  return 'bg-red-400';
}

/** PRIMARY-KPI achievement % for an outlet, or null when it has no primary target set (so
 *  callers can sort no-target outlets last rather than treating them as a 0% performer). */
function outletPrimaryPct(kpis: OutletKpis, primaryCode: string | null): number | null {
  if (!primaryCode) return null;
  const k = kpis[primaryCode];
  if (k && k.target && k.target > 0) return pct(k.achieved ?? 0, k.target);
  return null;
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

/** Photo-approval (PHOTO_APPROVAL mode) visibility badge — the 5-status model shared with the
 *  sales dashboard summary card (classifyVisibilityCapture). Bajaj-scoped. */
const VIS_BUCKET_BADGE: Record<VisibilitySummaryBucket, { label: string; cls: string }> = {
  approved:  { label: 'Approved',  cls: 'bg-emerald-50 text-emerald-700' },
  partial:   { label: 'Partial',   cls: 'bg-amber-50 text-amber-700' },
  in_review: { label: 'In review', cls: 'bg-blue-50 text-blue-700' },
  pending:   { label: 'Pending',   cls: 'bg-gray-100 text-gray-600' },
  rejected:  { label: 'Rejected',  cls: 'bg-red-50 text-red-700' },
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
  const [programFilter, setProgramFilter] = useState<string>('ALL');
  const [role,       setRoleState]  = useState<SalesRole>('SO');

  // Bajaj-scoped outlets-page additions (program filter, photo-visibility badge, primary sort)
  // — keeps every other tenant's outlets page byte-identical.
  const isBajaj = (useClientConfig().slug ?? '').trim().toLowerCase() === 'bajaj';
  // Per-tenant outlet-type display labels; falls back to the TYPE_FILTERS labels until resolved.
  const { label: outletTypeLabel } = useOutletTypeLabels();

  const [visibilityMap, setVisibilityMap] = useState<VisibilityStatusMap>({});
  // Photo-approval (PHOTO_APPROVAL) per-outlet 5-status, keyed by outletCode (Bajaj). Only
  // in-scope outlets appear here → "visibility applicable" is implicit in map membership.
  const [visPhotoByCode, setVisPhotoByCode] = useState<Record<string, VisibilitySummaryBucket>>({});

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
    fetch('/api/sales/outlets')
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
    fetch(`/api/sales/outlet-targets?period=${encodeURIComponent(period)}`)
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

  // Distinct programs across the roster (Bajaj Program filter). 'ALL' + sorted names.
  const allPrograms = useMemo(
    () => ['ALL', ...Array.from(new Set(outlets.map((o) => o.programName).filter((p): p is string => !!p))).sort()],
    [outlets],
  );

  const monthlyPeriods = useMemo(() => PERIODS.filter((p) => !p.value.includes('Q')), []);

  // Fetch visibility statuses for the selected month (RETAILER + MT outlets only)
  useEffect(() => {
    // Bajaj uses the PHOTO_APPROVAL badge below (visPhotoByCode); skip the amount-upload
    // path entirely so the two never render a double "Visibility:" pill on one outlet.
    if (isBajaj) return;
    const eligibleCodes = outlets
      .filter((o) => VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(o.type))
      .map((o) => o.outletCode);
    if (eligibleCodes.length === 0) return;
    fetchOutletVisibilityStatuses(eligibleCodes, period)
      .then((map) => { if (Object.keys(map).length > 0) setVisibilityMap(map); });
  }, [period, outlets, isBajaj]);

  // Photo-approval visibility status per outlet (Bajaj) — the CURRENT window's 5-status from
  // the same getSalesEligible call the dashboard uses. getSalesEligible is current-window only,
  // so this badge reflects the current month regardless of the period selector (visibility is a
  // this-period concept; no per-past-window sales read exists).
  useEffect(() => {
    if (!isBajaj) { setVisPhotoByCode({}); return; }
    const gs = getGifsySettings();
    if (gs.visibilityEnabled !== true || (gs.visibilityCaptureMode ?? 'PHOTO_APPROVAL') !== 'PHOTO_APPROVAL') {
      setVisPhotoByCode({});
      return;
    }
    let cancelled = false;
    visibilityApi.getSalesEligible()
      .then((r) => {
        if (cancelled) return;
        if (!r.success) { setVisPhotoByCode({}); return; }
        const map: Record<string, VisibilitySummaryBucket> = {};
        for (const o of r.data.outlets ?? []) {
          if (o.outletCode) map[o.outletCode] = classifyVisibilityCapture(o);
        }
        setVisPhotoByCode(map);
      })
      .catch(() => { if (!cancelled) setVisPhotoByCode({}); });
    return () => { cancelled = true; };
  }, [isBajaj, outlets]);

  const params      = kpiColumns;
  const primaryCode = getPrimaryParam(kpiColumns)?.code ?? null;
  const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? period;
  // The photo-visibility badge is CURRENT-window only (getSalesEligible has no past-window
  // read), so only show it when the current month is selected — never stale on a past period.
  const isCurrentPeriod = period === CURRENT_MONTH;

  const kpisFor = (o: Outlet): OutletKpis => targetsByOutlet[o.outletCode] ?? {};

  const visibleOutlets = useMemo(() => outlets.filter((o) => {
    const matchesType = typeFilter === 'ALL' || o.type === typeFilter;
    const matchesBeat = beatFilter === 'ALL' || o.beat === beatFilter;
    const matchesProgram = programFilter === 'ALL' || o.programName === programFilter;
    return matchesType && matchesBeat && matchesProgram;
  }), [outlets, typeFilter, beatFilter, programFilter]);

  // Owner-specified outlet order (2026-07-03): Approved → Re-KYC → Rejected →
  // Pending → Not Interested (see kycOrderRank). Within Approved, worst performer
  // first (actionable); within every other bucket, alphabetical by name.
  //
  // Bajaj (owner 2026-10-27): within Approved, sort strictly by PRIMARY-KPI achievement
  // ascending (lowest first) and push outlets with no primary target to the bottom — so the
  // actionable low performers surface on top, not the no-target outlets. Other tenants keep
  // the original overall-% order (byte-identical). The KYC-status grouping is preserved.
  const sortedVisibleOutlets = useMemo(() => {
    return [...visibleOutlets].sort((a, b) => {
      const ra = kycOrderRank(a.kycStatus);
      const rb = kycOrderRank(b.kycStatus);
      if (ra !== rb) return ra - rb;
      if (ra === 0) {
        if (isBajaj) {
          const pa = outletPrimaryPct(kpisFor(a), primaryCode);
          const pb = outletPrimaryPct(kpisFor(b), primaryCode);
          if (pa === null && pb === null) return a.name.localeCompare(b.name);
          if (pa === null) return 1;   // no primary target → after those that have one
          if (pb === null) return -1;
          if (pa !== pb) return pa - pb; // lowest primary achievement first
          return a.name.localeCompare(b.name);
        }
        return outletOverallPct(kpisFor(a), primaryCode) - outletOverallPct(kpisFor(b), primaryCode);
      }
      return a.name.localeCompare(b.name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleOutlets, targetsByOutlet, primaryCode, isBajaj]);

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
          if (p.rollup === 'OUTLET_COUNT') {
            // Count outlets that met their own target (denominator = outlets with a target).
            const t = k.target ?? 0;
            if (t > 0) {
              totals[p.code].target += 1;
              if ((k.achieved ?? 0) >= t) totals[p.code].achieved += 1;
            }
          } else {
            totals[p.code].achieved += k.achieved ?? 0;
            totals[p.code].target   += k.target ?? 0;
          }
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
              <option key={f.value} value={f.value}>{f.value === 'ALL' ? 'All Types' : outletTypeLabel(f.value, f.label)}</option>
            ))}
          </select>
          <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${typeFilter !== 'ALL' ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        {/* Program filter (Bajaj) — only when the roster has more than one program. */}
        {isBajaj && allPrograms.length > 2 && (
          <div className="relative shrink-0">
            <select
              value={programFilter}
              onChange={(e) => setProgramFilter(e.target.value)}
              className={`appearance-none text-[11px] font-semibold border rounded-full pl-2.5 pr-6 py-1 bg-white focus:outline-none transition-colors cursor-pointer ${
                programFilter !== 'ALL' ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-gray-200 text-gray-600 focus:border-[var(--brand-primary)]'
              }`}
            >
              {allPrograms.map((p) => (
                <option key={p} value={p}>{p === 'ALL' ? 'All Programs' : p}</option>
              ))}
            </select>
            <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${programFilter !== 'ALL' ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}
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
                                  {!isBajaj && VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(outlet.type) && visibilityMap[outlet.outletCode] && (
                                    <span className={`text-[8px] font-semibold px-1 py-0 rounded-full leading-tight ${VIS_CHIP_CLASS[visibilityMap[outlet.outletCode].status] ?? ''}`}>
                                      Visibility: {VIS_LABEL[visibilityMap[outlet.outletCode].status] ?? visibilityMap[outlet.outletCode].status}
                                    </span>
                                  )}
                                  {isBajaj && isCurrentPeriod && visPhotoByCode[outlet.outletCode] && (
                                    <span className={`text-[8px] font-semibold px-1 py-0 rounded-full leading-tight ${VIS_BUCKET_BADGE[visPhotoByCode[outlet.outletCode]].cls}`}>
                                      Visibility: {VIS_BUCKET_BADGE[visPhotoByCode[outlet.outletCode]].label}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Show every outlet's real target/achieved numbers — not just
                              approved. AchCell already renders a "–" for a genuinely empty
                              value; we no longer gate the whole cell on kycStatus. */}
                          {params.map((p) => (
                            <AchCell key={p.code} achieved={kpis[p.code]?.achieved ?? null} target={kpis[p.code]?.target ?? null} />
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
                                {fmtNum(achieved)}<span className="text-gray-400 font-normal">/{fmtNum(target)}{p.rollup === 'OUTLET_COUNT' ? ' outlets' : ''}</span>
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

              {teamSummary && (
                <p className="px-4 py-2 text-[10px] text-gray-400 border-t border-gray-100">
                  Team Total reflects approved &amp; active outlets only.
                </p>
              )}
            </div>
          )}

          {/* Empty state */}
          {visibleOutlets.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 bg-gray-50 rounded-2xl border border-gray-100">
              <AlertTriangle className="h-7 w-7 text-gray-300" />
              <p className="text-sm text-gray-400">No outlets match the selected filters</p>
              <button
                onClick={() => { setTypeFilter('ALL'); setBeatFilter('ALL'); setProgramFilter('ALL'); }}
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
                const kpis      = kpisFor(outlet);
                const svParam   = getPrimaryParam(params);
                // Exclude the actual headline KPI by code — getPrimaryParam falls back to params[0]
                // when none is flagged primary, so !isPrimary would duplicate params[0] in the grid.
                const kpiParams = params.filter((p) => p.code !== svParam?.code);

                const svK    = svParam ? kpis[svParam.code] : undefined;
                const svPct  = svParam && svK?.target ? pct(svK.achieved ?? 0, svK.target) : 0;
                // Colored pace strip whenever this outlet has a primary target (any KYC status); gray otherwise.
                const stripClass = svK?.target ? paceStrip(svPct, period) : 'bg-gray-100';

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
                          {/* Show the KYC-status badge for EVERY outlet, incl. Approved
                              (owner 2026-07-03) — matches the table view. */}
                          <Badge variant={kycBadge[outlet.kycStatus].variant} className="shrink-0 text-[9px]">
                            {kycBadge[outlet.kycStatus].label}
                          </Badge>
                        </div>
                        <p className="text-[10px] font-mono text-gray-400 leading-tight mt-0.5">{outlet.outletCode}</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                    </div>

                    {/* Targets/achievements are shown for EVERY outlet regardless of KYC
                        status (owner 2026-07-03); an outlet with no uploaded target shows
                        the neutral no-target note instead of a KYC lock. */}
                    {Object.keys(kpis).length === 0 ? (
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
                    )}

                    {!isBajaj && VISIBILITY_ELIGIBLE_OUTLET_TYPES.includes(outlet.type) && visibilityMap[outlet.outletCode] && (
                      <div className="border-t border-gray-100 px-4 py-2 flex items-center gap-1.5">
                        <Eye className="h-3 w-3 text-gray-400 shrink-0" />
                        <span className="text-[11px] text-gray-500 font-medium">Visibility:</span>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${VIS_CHIP_CLASS[visibilityMap[outlet.outletCode].status] ?? ''}`}>
                          {VIS_LABEL[visibilityMap[outlet.outletCode].status] ?? visibilityMap[outlet.outletCode].status}
                        </span>
                      </div>
                    )}
                    {isBajaj && isCurrentPeriod && visPhotoByCode[outlet.outletCode] && (
                      <div className="border-t border-gray-100 px-4 py-2 flex items-center gap-1.5">
                        <Eye className="h-3 w-3 text-gray-400 shrink-0" />
                        <span className="text-[11px] text-gray-500 font-medium">Visibility:</span>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${VIS_BUCKET_BADGE[visPhotoByCode[outlet.outletCode]].cls}`}>
                          {VIS_BUCKET_BADGE[visPhotoByCode[outlet.outletCode]].label}
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
