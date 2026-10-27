'use client';

/**
 * TeamViewScreen — the redesigned, recursive sales Team view (platform-wide).
 *
 * Shared by `/sales/team` (root = caller) and `/sales/team/[memberId]` (drill-down). Layout:
 *   My Team header → Filters (Outlet type · Program · KPI) → 4 summary cards (filtered) →
 *   direct-report league table (each scored by the selected KPI's outlets-achieved %, sorted
 *   worst-first). Tapping a member with a team drills into their team (filters carried in the
 *   URL); tapping a leaf (ISR, no team) opens that member's outlets page.
 *
 * Reads initial filter state from the URL query, so drilling down preserves the filters. Uses
 * useSearchParams → the page must render this inside a <Suspense> boundary.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { ArrowLeft, Users, MapPin, FileCheck, AlertTriangle, TrendingUp, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { fetchTeamView, teamFilterQuery, type TeamViewResponse, type TeamViewMember } from '@/lib/sales-team';

/* ─── Filter pill (shared select styling) ─────────────────────────────────────── */

function Pill({
  value, onChange, active, children,
}: { value: string; onChange: (v: string) => void; active: boolean; children: React.ReactNode }) {
  return (
    <div className="relative shrink-0">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none text-[11px] font-semibold border rounded-full pl-2.5 pr-6 py-1.5 bg-white focus:outline-none transition-colors cursor-pointer ${
          active ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-gray-200 text-gray-600 focus:border-[var(--brand-primary)]'
        }`}
      >
        {children}
      </select>
      <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${active ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/* ─── Achievement badge ───────────────────────────────────────────────────────── */

function pctClasses(pct: number): string {
  if (pct >= 100) return 'text-emerald-600 bg-emerald-50';
  if (pct >= 80) return 'text-amber-600 bg-amber-50';
  if (pct >= 60) return 'text-orange-500 bg-orange-50';
  return 'text-red-600 bg-red-50';
}

function MemberRow({ m, href }: { m: TeamViewMember; href: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 py-3.5 px-3 hover:bg-gray-50 transition-colors active:scale-[0.99]">
      <div className="w-10 h-10 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
        <span className="text-[var(--brand-primary)] font-bold text-sm">
          {m.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-gray-900 truncate">{m.name}</p>
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-bold ${m.achievedPct === null ? 'text-gray-400 bg-gray-100' : pctClasses(m.achievedPct)}`}>
            {m.achievedPct === null ? '—' : `${m.achievedPct}%`}
          </span>
        </div>
        <p className="text-xs text-gray-500 truncate">
          {[m.roleLabel, m.employeeCode, m.mobile].filter(Boolean).join(' · ')}
        </p>
        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
          {m.achievedPct !== null && (
            <span className="text-[10px] text-gray-500">{m.outletsAchieved}/{m.outletsWithTarget} hit target</span>
          )}
          {m.outlets > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-gray-500"><MapPin className="h-3 w-3" /> {m.outlets} outlets</span>
          )}
          {m.teamSize > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-gray-500"><Users className="h-3 w-3" /> {m.teamSize} team</span>
          )}
          {m.kycPending > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-amber-600"><AlertTriangle className="h-3 w-3" /> {m.kycPending} KYC</span>
          )}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
    </Link>
  );
}

/* ─── Screen ──────────────────────────────────────────────────────────────────── */

export function TeamViewScreen({ memberId }: { memberId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [outletType, setOutletType] = useState<string>(() => searchParams.get('outletType') ?? 'ALL');
  const [program, setProgram] = useState<string>(() => searchParams.get('program') ?? 'ALL');
  const [kpi, setKpi] = useState<string>(() => searchParams.get('kpi') ?? '');
  const [data, setData] = useState<TeamViewResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTeamView({ memberId, outletType, program, kpi })
      .then((r) => { if (!cancelled) setData(r.success ? r.data : null); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [memberId, outletType, program, kpi]);

  // Keep the current URL in sync with the active filters, so refresh / browser-back preserve them.
  const syncUrl = useCallback((next: { outletType?: string; program?: string; kpi?: string }) => {
    const q = teamFilterQuery({ outletType, program, kpi, ...next });
    router.replace(`${pathname}${q}`, { scroll: false });
  }, [router, pathname, outletType, program, kpi]);

  const filterSuffix = teamFilterQuery({ outletType, program, kpi });
  const selectedKpi = kpi || data?.kpiCode || '';
  const anyFilter = (outletType !== 'ALL') || (program !== 'ALL') || !!kpi;

  const summaryCards = useMemo(() => {
    const s = data?.summary;
    return [
      { label: 'Outlets', value: s ? String(s.outlets) : '—', icon: MapPin, color: 'text-gray-600' },
      { label: 'KYC Done', value: s ? String(s.kycDone) : '—', icon: FileCheck, color: 'text-emerald-600' },
      { label: 'KYC Pending', value: s ? String(s.kycPending) : '—', icon: AlertTriangle, color: 'text-amber-600' },
      { label: 'Avg Target', value: s && s.avgTargetPct !== null ? `${s.avgTargetPct}%` : '—', icon: TrendingUp, color: 'text-[var(--brand-primary)]' },
    ];
  }, [data]);

  const heading = memberId ? (data?.member?.name ?? 'Team') : 'My Team';
  const subheading = memberId && data?.member ? `${data.member.roleLabel}'s team` : '';

  return (
    <div className="space-y-4 fade-in">
      {memberId && (
        <button onClick={() => router.back()} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
      )}

      <div>
        <h1 className="text-xl font-bold text-gray-900">{heading}</h1>
        {subheading && <p className="text-sm text-gray-500">{subheading}</p>}
      </div>

      {/* Filters — topmost */}
      {data && (
        <div className="flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          <Pill value={outletType} onChange={(v) => { setOutletType(v); syncUrl({ outletType: v }); }} active={outletType !== 'ALL'}>
            <option value="ALL">All outlet types</option>
            {data.filterOptions.outletTypes.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
          </Pill>
          <Pill value={program} onChange={(v) => { setProgram(v); syncUrl({ program: v }); }} active={program !== 'ALL'}>
            <option value="ALL">All programs</option>
            {data.filterOptions.programs.map((p) => <option key={p} value={p}>{p}</option>)}
          </Pill>
          <Pill value={selectedKpi} onChange={(v) => { setKpi(v); syncUrl({ kpi: v }); }} active={!!kpi}>
            {data.filterOptions.kpis.map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}
          </Pill>
        </div>
      )}

      {/* Summary cards (filtered) */}
      <div className="grid grid-cols-4 gap-2">
        {summaryCards.map((c) => (
          <div key={c.label} className="bg-white rounded-xl border border-gray-100 p-3 flex flex-col items-center gap-1">
            <c.icon className={`h-4 w-4 ${c.color}`} />
            <p className={`text-base font-bold ${c.color}`}>{c.value}</p>
            <p className="text-[9px] text-gray-400 text-center leading-tight">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Member league table */}
      {loading && !data ? (
        <div className="flex items-center justify-center min-h-40"><Spinner size="lg" /></div>
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <div className="divide-y divide-gray-50">
              {!data || data.members.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">
                  {anyFilter ? 'No team members match the selected filters' : 'No team members found'}
                </p>
              ) : (
                data.members.map((m) => (
                  <MemberRow
                    key={m.id}
                    m={m}
                    href={m.teamSize > 0
                      ? `/sales/team/${m.id}${filterSuffix}`
                      : `/sales/team/${m.id}/outlets${filterSuffix}`}
                  />
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
