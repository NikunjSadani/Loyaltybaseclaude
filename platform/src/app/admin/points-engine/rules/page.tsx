'use client';

/**
 * Points Engine — RULE LIST.
 *
 * Status + program/KPI filters over the PointsRule CRUD (`listRules`). Each row links to the builder.
 * Matches the targets/schemes admin idiom: hand-rolled table, loading / empty / error states, native
 * confirm() for destructive actions, var(--brand-primary) accent, light mode.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Calculator, AlertCircle, ChevronRight, Search } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { listRules } from '@/lib/points-engine/api';
import type { PointsRuleRow, RuleStatus } from '@/lib/points-engine/types';
import { StatusBadge } from './_components/kit';

const STATUS_FILTERS = ['all', 'draft', 'published', 'archived'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function fmtDate(d: string | null): string {
  return d ? d.slice(0, 10) : '—';
}

export default function PointsRulesPage() {
  const router = useRouter();
  const [rules, setRules] = useState<PointsRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [programQ, setProgramQ] = useState('');
  const [kpiQ, setKpiQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listRules({
      status: statusFilter === 'all' ? undefined : statusFilter,
      program: programQ.trim() || undefined,
      kpiCode: kpiQ.trim() || undefined,
    });
    if (res.success) setRules(res.data);
    else setError(res.error ?? 'Failed to load rules');
    setLoading(false);
  }, [statusFilter, programQ, kpiQ]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<RuleStatus, number> = { draft: 0, published: 0, archived: 0 };
    for (const r of rules) c[r.status] += 1;
    return c;
  }, [rules]);

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Points rules</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Versioned rules that turn achievement into points. Author a draft, simulate, then publish.
          </p>
        </div>
        <Link
          href="/admin/points-engine/rules/new"
          className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New rule
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-full bg-gray-100 p-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                statusFilter === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {s}
              {s !== 'all' && rules.length > 0 ? ` (${counts[s]})` : ''}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={programQ}
            onChange={(e) => setProgramQ(e.target.value)}
            placeholder="Filter by program…"
            className="w-44 rounded-xl border border-gray-200 py-2 pl-9 pr-3 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={kpiQ}
            onChange={(e) => setKpiQ(e.target.value.toUpperCase())}
            placeholder="Filter by KPI code…"
            className="w-44 rounded-xl border border-gray-200 py-2 pl-9 pr-3 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-2 px-5 py-6">
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </div>
            <button onClick={() => void load()} className="text-xs font-semibold text-[var(--brand-primary)] hover:underline">
              Retry
            </button>
          </div>
        ) : rules.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
            <Calculator className="h-10 w-10 text-gray-200" />
            <p className="text-sm font-semibold text-gray-400">No rules match the current filters.</p>
            <Link href="/admin/points-engine/rules/new" className="text-xs font-semibold text-[var(--brand-primary)] hover:underline">
              Create your first rule
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  <th className="py-2.5 pl-5 pr-2">Rule</th>
                  <th className="px-2 py-2.5">Attachment</th>
                  <th className="px-2 py-2.5">Effective</th>
                  <th className="px-2 py-2.5">Output field</th>
                  <th className="px-2 py-2.5">Updated</th>
                  <th className="py-2.5 pl-2 pr-5" />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const open = () => router.push(`/admin/points-engine/rules/${r.id}`);
                  return (
                  <tr
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open rule ${r.ruleId} version ${r.version}`}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        open();
                      }
                    }}
                    className="cursor-pointer border-b border-gray-50 text-sm transition-colors last:border-0 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-primary)]/40"
                  >
                    <td className="py-3 pl-5 pr-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-gray-900">{r.ruleId}</span>
                        <span className="text-[10px] font-semibold text-gray-400">v{r.version}</span>
                        <StatusBadge status={r.status} />
                      </div>
                    </td>
                    <td className="px-2 py-3 text-xs text-gray-600">
                      <span className="font-medium text-gray-700">{r.program ?? 'any program'}</span>
                      <span className="text-gray-400"> × </span>
                      <span className="font-mono">{r.kpiCode}</span>
                    </td>
                    <td className="px-2 py-3 text-xs text-gray-500">
                      {fmtDate(r.effectiveFrom)} → {fmtDate(r.effectiveTo)}
                    </td>
                    <td className="px-2 py-3 font-mono text-xs text-gray-500">{r.output.fieldId}</td>
                    <td className="px-2 py-3 text-xs text-gray-400">{fmtDate(r.updatedAt)}</td>
                    <td className="py-3 pl-2 pr-5 text-right">
                      <ChevronRight className="inline h-4 w-4 text-gray-300" />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
