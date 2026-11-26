'use client';

/**
 * Points Engine — RULE LIST.
 *
 * Status + program/KPI filters over the PointsRule CRUD (`listRules`). Each row links to the builder.
 * RULE column = the rule's display NAME ("Unnamed rule" + ruleId when it has none; ruleId small for Gifsy admins);
 * OUTPUT FIELD = the credit field NAME (an unknown / inactive field is flagged in red, never a bare id). Row actions:
 * Rename (display-only — no new version, audited) and Duplicate (opens the builder as a NEW rule pre-filled).
 * Matches the targets/schemes admin idiom: hand-rolled table, loading / empty / error states, native
 * confirm() for destructive actions, var(--brand-primary) accent, light mode.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Calculator, AlertCircle, ChevronRight, Search, Pencil, CopyPlus, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { listRules, renameRule } from '@/lib/points-engine/api';
import { useAdminSession } from '@/lib/admin-session';
import type { PointsRuleRow, RuleStatus } from '@/lib/points-engine/types';
import {
  StatusBadge, ruleTitle, creditFieldLabel, ruleNameIssue, duplicateRuleNameWarning, cleanRuleName,
  RULE_NAME_PLACEHOLDER, inputCls, programCell, sortRules, type RuleSortKey, BLANK_LABEL, SUB_BLANK,
} from './_components/kit';

type CreditFieldLite = { id: string; name: string; isActive: boolean };

const STATUS_FILTERS = ['all', 'draft', 'published', 'archived'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function fmtDate(d: string | null): string {
  return d ? d.slice(0, 10) : '—';
}

export default function PointsRulesPage() {
  const router = useRouter();
  const session = useAdminSession();
  const isGifsyAdmin = session?.role === 'GIFSY_ADMIN';
  const [rules, setRules] = useState<PointsRuleRow[]>([]);

  // Credit fields — resolve each rule's output field id → NAME (null until loaded, so nothing flashes as "not found").
  const [creditFields, setCreditFields] = useState<CreditFieldLite[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/admin/credits/fields');
        const json = await res.json();
        if (!cancelled && json?.success && Array.isArray(json.data)) {
          setCreditFields((json.data as CreditFieldLite[]).map((f) => ({ id: f.id, name: f.name, isActive: f.isActive })));
        }
      } catch {
        /* fields unavailable → the raw id is shown (with a hint) rather than a wrong "not found" */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Rename dialog (inline row editor). Display-only: no new version; applies to every version of the rule.
  const [renameFor, setRenameFor] = useState<PointsRuleRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const startRename = (r: PointsRuleRow) => {
    setRenameFor(r);
    setRenameValue(r.name ?? '');
    setRenameError(null);
    setNotice(null);
  };
  /** Save a new name, or `clear` → "Remove name" (null). Renames every version, audited; no new version. */
  const submitRename = async (clear = false) => {
    if (!renameFor) return;
    if (!clear) {
      const issue = ruleNameIssue(renameValue, true);
      if (issue) { setRenameError(issue); return; }
    }
    setRenameBusy(true);
    setRenameError(null);
    const res = await renameRule(renameFor.id, clear ? '' : cleanRuleName(renameValue));
    if (res.success) {
      const newName = res.data.name ?? null;
      setRules((rs) => rs.map((x) => (x.ruleId === renameFor.ruleId ? { ...x, name: newName } : x)));
      setNotice(`Renamed to “${newName ?? 'Unnamed rule'}” — every version updated; rule logic and version unchanged.`);
      setRenameFor(null);
    } else {
      setRenameError(res.error ?? 'Rename failed');
    }
    setRenameBusy(false);
  };
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

  // Sub-programme filter (client-side, case-insensitive contains; "all" matches rules with no sub-programme) + sort.
  // '' = every rule; SUB_BLANK = rules with NO sub-programme (they apply to all); otherwise an exact value.
  const [subQ, setSubQ] = useState('');
  const [sortKey, setSortKey] = useState<RuleSortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const toggleSort = (k: RuleSortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };
  const shown = useMemo(() => {
    const filtered =
      subQ === '' ? rules
        : subQ === SUB_BLANK ? rules.filter((r) => !r.programCategory?.trim())
          : rules.filter((r) => (r.programCategory ?? '').trim() === subQ);
    return sortRules(filtered, sortKey, sortDir);
  }, [rules, subQ, sortKey, sortDir]);
  const subOptions = useMemo(
    () => [...new Set(rules.map((r) => (r.programCategory ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rules],
  );
  const sortHeader = (k: RuleSortKey, label: string, cls: string) => (
    <th className={cls} aria-sort={sortKey === k ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-gray-600"
        aria-label={`Sort by ${label}`}
      >
        {label}
        {sortKey === k ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
      </button>
    </th>
  );

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
              {/* Counts are derived from the server-FILTERED rows, so they're only meaningful for a status
                 when that status is the one loaded (or when "all" is active). Showing them on inactive tabs
                 would misleadingly read "(0)". */}
              {s !== 'all' && (statusFilter === 'all' || statusFilter === s) && rules.length > 0
                ? ` (${counts[s]})`
                : ''}
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
        <select
          value={subQ}
          onChange={(e) => setSubQ(e.target.value)}
          aria-label="Filter by sub-programme"
          className="w-52 rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
        >
          <option value="">Any sub-programme</option>
          <option value={SUB_BLANK}>{BLANK_LABEL}</option>
          {subOptions.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </div>

      {notice && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700" role="status">{notice}</div>
      )}
      {renameFor && (
        <div className="space-y-2 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm" data-testid="rename-panel">
          <p className="text-sm font-semibold text-gray-900">
            Rename <span className="font-mono text-xs text-gray-500">{renameFor.ruleId}</span>
          </p>
          <p className="text-xs text-gray-500">The name is shown in lists, previews and reports. Renaming applies to EVERY version of this rule, does not create a new version, never changes what the rule pays, and is recorded in the audit log.</p>
          <input
            value={renameValue}
            autoFocus
            aria-label="New rule name"
            placeholder={RULE_NAME_PLACEHOLDER}
            onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitRename(); if (e.key === 'Escape') setRenameFor(null); }}
            className={inputCls}
          />
          {(() => {
            const w = duplicateRuleNameWarning(renameValue, renameFor.ruleId, rules);
            return w ? <p className="text-xs text-amber-700" role="status">{w}</p> : null;
          })()}
          {renameError && <p className="text-xs text-red-600" role="alert">{renameError}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void submitRename()}
              disabled={renameBusy}
              className="rounded-xl bg-[var(--brand-primary)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {renameBusy ? 'Saving…' : 'Save name'}
            </button>
            {cleanRuleName(renameFor.name) !== '' && (
              <button
                type="button"
                onClick={() => { if (confirm('Remove the name from every version of this rule? It will show as “Unnamed rule”.')) void submitRename(true); }}
                disabled={renameBusy}
                className="rounded-xl border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
              >
                Remove name
              </button>
            )}
            <button
              type="button"
              onClick={() => setRenameFor(null)}
              className="rounded-xl border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

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
        ) : shown.length === 0 ? (
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
                  {sortHeader('status', 'Status', 'px-2 py-2.5')}
                  {sortHeader('program', 'Program', 'px-2 py-2.5')}
                  {sortHeader('subProgram', 'Sub-programme', 'px-2 py-2.5')}
                  {sortHeader('kpi', 'KPI', 'px-2 py-2.5')}
                  <th className="px-2 py-2.5">Effective</th>
                  <th className="px-2 py-2.5">Output field</th>
                  <th className="px-2 py-2.5">Updated</th>
                  <th className="py-2.5 pl-2 pr-5" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const open = () => router.push(`/admin/points-engine/rules/${r.id}`);
                  return (
                  <tr
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open rule ${ruleTitle(r).unnamed ? r.ruleId : ruleTitle(r).title} version ${r.version}`}
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
                      {(() => {
                        const t = ruleTitle(r);
                        return (
                          <>
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-sm font-semibold ${t.unnamed ? 'italic text-gray-400' : 'text-gray-900'}`}
                                data-testid="rule-name"
                              >
                                {t.title}
                              </span>
                              <span className="text-[10px] font-semibold text-gray-400">v{r.version}</span>
                            </div>
                            {(t.unnamed || isGifsyAdmin) && (
                              <span className="font-mono text-[10px] text-gray-400" data-testid="rule-id-small">{r.ruleId}</span>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-2 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-2 py-3 text-xs font-medium text-gray-700" data-testid="rule-program">{programCell(r.program)}</td>
                    <td className="px-2 py-3 text-xs text-gray-600" data-testid="rule-subprogram">{programCell(r.programCategory)}</td>
                    <td className="px-2 py-3 text-xs text-gray-600" data-testid="rule-kpi">
                      <span className="font-mono">{r.kpiCode}</span>
                      {r.evaluationBasis === 'QUARTER' && (
                        <span className="ml-1.5 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">Quarterly</span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-xs text-gray-500">
                      {fmtDate(r.effectiveFrom)} → {fmtDate(r.effectiveTo)}
                    </td>
                    <td className="px-2 py-3 text-xs" data-testid="rule-output-field">
                      {creditFields ? (
                        (() => {
                          const fl = creditFieldLabel(r.output?.fieldId, creditFields);
                          return (
                            <span className={fl.problem ? 'font-semibold text-red-600' : 'text-gray-700'}>{fl.label}</span>
                          );
                        })()
                      ) : (
                        <span className="font-mono text-gray-400" title="Credit field names could not be loaded">{r.output?.fieldId}</span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-xs text-gray-400">{fmtDate(r.updatedAt)}</td>
                    <td className="py-3 pl-2 pr-5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Rename rule ${r.ruleId}`}
                          title="Rename (no new version)"
                          onClick={(e) => { e.stopPropagation(); startRename(r); }}
                          onKeyDown={(e) => e.stopPropagation()}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Duplicate rule ${r.ruleId}`}
                          title="Duplicate as a new rule"
                          onClick={(e) => { e.stopPropagation(); router.push(`/admin/points-engine/rules/new?from=${encodeURIComponent(r.id)}`); }}
                          onKeyDown={(e) => e.stopPropagation()}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                        >
                          <CopyPlus className="h-3.5 w-3.5" />
                        </button>
                        <ChevronRight className="inline h-4 w-4 text-gray-300" />
                      </div>
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
