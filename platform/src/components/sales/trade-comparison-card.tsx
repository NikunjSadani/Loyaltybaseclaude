'use client';

/**
 * TradeComparisonCard — Bajaj sales-dashboard "Trade comparison" card (SO-and-above only;
 * the page gates rendering on hasTeamView(role)). Shows the primary KPI's Monthly sale (₹) and
 * Target met across three buckets — Current | Last month | Last 3 months — for the selected
 * outlet type (the RLP/BSC toggle), with a Program filter and a team-member drill-down.
 *
 * Data sources:
 *   • GET /api/sales/trade-comparison — the three buckets (re-fetched on outletType/program/member).
 *   • GET /api/sales/team-view — reused ONCE for the filter OPTION lists (programs + the caller's
 *     direct reports), auth-scoped by the backend to the caller's subtree.
 *
 * last3Months renders ONLY the pct for "Target met" (per the owner's spec); current & lastMonth
 * additionally show the achieved/withTarget ratio.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { fetchTradeComparison, type TradeComparisonResult, type TradeComparisonBucket, type TradeComparisonKpi } from '@/lib/sales-trade-comparison';
import { fetchTeamView } from '@/lib/sales-team';
import { formatInrCompact, formatCompact, isInrUnit } from '@/lib/format-inr';

interface MemberOption { id: string; name: string; roleLabel: string }

function pctColor(pct: number | null): string {
  if (pct === null) return 'text-gray-400';
  if (pct >= 100) return 'text-emerald-600';
  if (pct >= 80) return 'text-amber-600';
  if (pct >= 60) return 'text-orange-500';
  return 'text-red-500';
}

/**
 * Format a monthly-sale value by the SELECTED KPI's unit (reusing the shared formatters): an INR
 * unit → compact ₹ (K/L/Cr); any other unit → the compact magnitude with the unit suffix; no unit →
 * the compact magnitude alone.
 */
function formatByUnit(value: number, unit?: string | null): string {
  if (isInrUnit(unit)) return formatInrCompact(value);
  return `${formatCompact(value)}${unit ? ` ${unit}` : ''}`;
}

/** Shared select styling (mirrors the dashboard trend-filter pills). */
function FilterSelect({
  value, onChange, active, children, label,
}: { value: string; onChange: (v: string) => void; active: boolean; children: React.ReactNode; label: string }) {
  return (
    <div className="relative shrink-0">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none text-[11px] font-semibold border rounded-full pl-2.5 pr-6 py-1 bg-white focus:outline-none transition-colors cursor-pointer ${active ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]' : 'border-gray-200 text-gray-600 focus:border-[var(--brand-primary)]'}`}
      >
        {children}
      </select>
      <svg className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-2.5 w-2.5 ${active ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** One "Target met" cell: ratio (current/lastMonth) above the pct, or pct-only (last3Months). */
function TargetMetCell({ bucket, pctOnly }: { bucket: TradeComparisonBucket; pctOnly: boolean }) {
  const { achieved, withTarget, pct } = bucket.targetMet;
  return (
    <div className="flex flex-col items-center">
      {!pctOnly && achieved !== null && withTarget !== null && (
        <span className="text-[10px] text-gray-400 leading-none">{achieved}/{withTarget}</span>
      )}
      <span className={`text-sm font-bold leading-tight ${pctColor(pct)}`}>
        {pct === null ? '—' : `${pct}%`}
      </span>
    </div>
  );
}

export function TradeComparisonCard({ outletType }: { outletType: string }) {
  const [data, setData] = useState<TradeComparisonResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Filter state + option lists (programs + direct reports), loaded once from team-view.
  const [program, setProgram] = useState('');
  const [memberId, setMemberId] = useState('');
  const [programOptions, setProgramOptions] = useState<string[]>([]);
  const [memberOptions, setMemberOptions] = useState<MemberOption[]>([]);

  // KPI selection ('' = the primary default → unchanged initial view). The selectable KPI list comes
  // from the comparison response's `kpis`; we keep it in its own state so it STAYS rendered while a
  // refetch clears `data`, and so it re-populates for the outlet type's applicable set on a toggle.
  const [kpi, setKpi] = useState('');
  const [kpiOptions, setKpiOptions] = useState<TradeComparisonKpi[]>([]);

  // Filter options — one team-view call, auth-scoped to the caller's subtree.
  useEffect(() => {
    let cancelled = false;
    fetchTeamView({})
      .then((r) => {
        if (cancelled || !r.success) return;
        setProgramOptions(r.data.filterOptions.programs ?? []);
        setMemberOptions((r.data.members ?? []).map((m) => ({ id: m.id, name: m.name, roleLabel: m.roleLabel })));
      })
      .catch(() => { /* leave option lists empty — the dropdowns simply show "All" */ });
    return () => { cancelled = true; };
  }, []);

  // Buckets — re-fetch whenever the outletType toggle, program, or member changes. We CLEAR the
  // previous data at the start of every refetch so a failed/empty refetch can never silently keep
  // showing the previous outlet type's numbers (audit Finding 3: toggle RLP→BSC while the backend
  // errors must NOT leave RLP figures on screen under a "BSC" header).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setData(null);
    fetchTradeComparison(outletType, program || undefined, memberId || undefined, kpi || undefined)
      .then((r) => {
        if (cancelled) return;
        if (r) { setData(r); setKpiOptions(r.kpis ?? []); } else setError(true);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [outletType, program, memberId, kpi]);

  const columns = useMemo(
    () => [
      { key: 'current' as const, label: 'Current', pctOnly: false },
      { key: 'lastMonth' as const, label: 'Last month', pctOnly: false },
      { key: 'last3Months' as const, label: 'Last 3 months', pctOnly: true },
    ],
    [],
  );

  const hasAnyData =
    !!data &&
    (data.buckets.current.monthlySale > 0 ||
      data.buckets.lastMonth.monthlySale > 0 ||
      data.buckets.last3Months.monthlySale > 0 ||
      data.buckets.current.targetMet.pct !== null ||
      data.buckets.lastMonth.targetMet.pct !== null);

  return (
    <Card data-testid="trade-comparison-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-[var(--brand-primary)]" /> Trend Comparison
          </CardTitle>
          {/* KPI selector — replaces the old static KPI label. '' = the primary default (unchanged
              initial view); the options are the outlet type's applicable KPIs from the response. */}
          <FilterSelect label="KPI" value={kpi} onChange={setKpi} active={kpi !== ''}>
            <option value="">Primary KPI</option>
            {kpiOptions.map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}
          </FilterSelect>
        </div>

        {/* Program + team-member filters */}
        <div className="flex items-center gap-1.5 mt-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          <FilterSelect label="Program" value={program} onChange={setProgram} active={program !== ''}>
            <option value="">All programs</option>
            {programOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </FilterSelect>
          <FilterSelect label="Team member" value={memberId} onChange={setMemberId} active={memberId !== ''}>
            <option value="">My team</option>
            {memberOptions.map((m) => <option key={m.id} value={m.id}>{m.name}{m.roleLabel ? ` · ${m.roleLabel}` : ''}</option>)}
          </FilterSelect>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6"><Spinner size="md" /></div>
        ) : error ? (
          <p className="text-xs text-red-500 py-3 text-center">Couldn&apos;t load the comparison. Pull to refresh.</p>
        ) : !data || !data.kpiName ? (
          <p className="text-xs text-gray-400 py-3 text-center">No primary KPI applies to this outlet type.</p>
        ) : !hasAnyData ? (
          <p className="text-xs text-gray-400 py-3 text-center">No sales or target data for the selected filters yet.</p>
        ) : (
          <div className="space-y-2">
            {/* Column header */}
            <div className="grid grid-cols-4 gap-1 items-end">
              <div />
              {columns.map((c) => (
                <div key={c.key} className="text-[10px] font-semibold text-gray-500 text-center leading-tight">{c.label}</div>
              ))}
            </div>

            {/* Row: the selected KPI's value (labelled with the KPI name, so it isn't stuck on
                "Monthly sale" when another KPI is picked) */}
            <div className="grid grid-cols-4 gap-1 items-center py-1.5 border-t border-gray-50">
              <div className="text-[11px] font-medium text-gray-600">{data.kpiName}</div>
              {columns.map((c) => (
                <div key={c.key} className="text-sm font-bold text-gray-800 text-center">
                  {/* Formatted by the selected KPI's unit — INR → compact ₹ (K/L/Cr) so lakhs/crores
                      don't overflow the card; any other unit → compact value + unit suffix. */}
                  {formatByUnit(data.buckets[c.key].monthlySale, data.kpiUnit)}
                </div>
              ))}
            </div>

            {/* Row: Width of achievement — same ratio as the old "Target met" (outlets meeting
                target ÷ outlets with a target), nomenclature change only. */}
            <div className="grid grid-cols-4 gap-1 items-center py-1.5 border-t border-gray-50">
              <div className="text-[11px] font-medium text-gray-600">Width of achievement</div>
              {columns.map((c) => (
                <div key={c.key} className="text-center">
                  <TargetMetCell bucket={data.buckets[c.key]} pctOnly={c.pctOnly} />
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
