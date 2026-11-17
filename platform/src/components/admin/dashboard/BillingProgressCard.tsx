'use client';

/**
 * Monthly billing progress — Overview dashboard card (all tenants).
 *
 * 100% wired to GET /api/admin/dashboard/billing-progress (proxy → /v1/admin/dashboard/billing-progress):
 * how far each outlet has billed against its headline-KPI target this month, bucketed 0 → 100%+, with a
 * pace line ("Day 16 of 30 · N outlets behind pace") and the outlets with NO target called out separately.
 * Clicking a bucket / "behind pace" / "no target" opens the outlet list
 * (GET …/billing-progress/outlets, paginated) with a Download Excel button (…/billing-progress/outlets/export,
 * export kind `billing-progress-outlets` — streams instantly, or 202 → Downloads page via useDownloadAction).
 *
 * Program: follows the Overview page's program filter (no dropdown on the card itself).
 * Honest states: no headline KPI → says so (no fake zeros); no sales uploaded yet → says so; fetch failure →
 * an error (the previous filter's numbers are never left on screen under new filters).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Download, Loader2, Receipt, RefreshCw } from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import { fmtKpiNum } from '@/lib/pace';
import { formatInrCompact, isInrUnit } from '@/lib/format-inr';
import { formatISTDate, istMonthKey } from '@/lib/ist-date';
import { type DashboardProgram, PROGRAM_URL_PARAM } from '@/lib/dashboard-program';
import { Modal } from '@/components/ui/modal';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

// TODO(orchestrator): confirm the export kind key. Backend registers it as BILLING_PROGRESS_OUTLETS_KIND_ID in
// api/src/exports/kinds/batch2/billing-progress.kind.ts and serves it at GET admin/dashboard/billing-progress/outlets/export.
export const BILLING_PROGRESS_EXPORT_KIND = 'billing-progress-outlets';

export const BILLING_PROGRESS_URL = '/api/admin/dashboard/billing-progress';
export const BILLING_OUTLETS_URL = '/api/admin/dashboard/billing-progress/outlets';
export const BILLING_OUTLETS_EXPORT_URL = '/api/admin/dashboard/billing-progress/outlets/export';
export const BILLING_OUTLETS_PAGE_SIZE = 25;
/** Month picker: the current month + this many previous months. */
export const BILLING_MONTHS_BACK = 12;

/* ─── API contract ─────────────────────────────────────────────────────────── */

export type BillingBucketKey = 'NOT_STARTED' | 'P0_20' | 'P20_40' | 'P40_60' | 'P60_80' | 'P80_100' | 'ACHIEVED';
export type BillingListKey = BillingBucketKey | 'BEHIND_PACE' | 'NO_TARGET';

export interface BillingBucket {
  key: BillingBucketKey;
  label: string;
  count: number;
  pctOfOutlets: number;
  targetSum: number;
  achievedSum: number;
}

export interface BillingManager { id: string; name: string; levelCode: string; levelName: string }

export interface BillingProgressData {
  month: string;
  kpi: { code: string; label: string; unit: string } | null;
  asOf: string | null;
  daysElapsed: number;
  daysInMonth: number;
  pacePct: number;
  outletsInScope: number;
  outletsWithoutTarget: number;
  totals: { targetSum: number; achievedSum: number };
  behindPace: { count: number; targetSum: number; achievedSum: number };
  buckets: BillingBucket[];
  availablePrograms: string[];
  availableOutletTypes: string[];
  availableManagers: BillingManager[];
}

export interface BillingOutletRow {
  outletCode: string;
  outletName: string;
  program: string | null;
  outletType: string | null;
  soName: string | null;
  asmName: string | null;
  target: number;
  achieved: number;
  pct: number | null;
}

interface BillingOutletsPage { rows: BillingOutletRow[]; total: number; page: number; pageSize: number }

interface Filters { month: string; program: string; outletType: string; managerId: string }

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-11" → "November 2026" (falls back to the raw key). */
export function monthWords(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? '');
  if (!m) return key ?? '';
  const name = MONTH_NAMES[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : key;
}

/** Shift a "YYYY-MM" key by `delta` months. */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** The current IST month + the previous `back` months, newest first. */
export function monthOptions(now: Date = new Date(), back = BILLING_MONTHS_BACK): string[] {
  const cur = istMonthKey(now);
  return Array.from({ length: back + 1 }, (_, i) => shiftMonth(cur, -i));
}

/** Money/quantity for a headline or bucket: INR → compact ₹ (L / Cr); other units → ≤ 2 dp + unit. */
export function fmtBillingAmount(value: number, unit: string | null | undefined): string {
  if (isInrUnit(unit)) return formatInrCompact(Math.round(Number.isFinite(value) ? value : 0));
  return `${fmtKpiNum(value, unit)}${unit ? ` ${unit}` : ''}`;
}

/** Exact figure (table cells / tooltips): INR → ₹ whole rupees with Indian grouping; other units ≤ 2 dp. */
export function fmtBillingExact(value: number, unit: string | null | undefined): string {
  return isInrUnit(unit) ? `₹${fmtKpiNum(value, unit)}` : fmtKpiNum(value, unit);
}

function pctOf(achieved: number, target: number): string {
  if (!(target > 0)) return '—';
  return `${((achieved / target) * 100).toFixed(1)}%`;
}

const fmtInt = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString('en-IN');
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function filterQuery(f: Filters, extra: Record<string, string | number> = {}): string {
  const sp = new URLSearchParams();
  sp.set('month', f.month);
  if (f.program) sp.set(PROGRAM_URL_PARAM, f.program);
  if (f.outletType) sp.set('outletType', f.outletType);
  if (f.managerId) sp.set('managerId', f.managerId);
  for (const [k, v] of Object.entries(extra)) sp.set(k, String(v));
  return sp.toString();
}

/** `{ success, data }` or the bare body. */
function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as { data?: unknown };
  return ('data' in j && j.data && typeof j.data === 'object' ? j.data : json) as T;
}

async function readError(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { error?: unknown; message?: unknown };
    const raw = body?.error ?? body?.message;
    if (typeof raw === 'string' && raw.trim()) return raw;
    if (Array.isArray(raw)) return raw.join(', ');
  } catch { /* not JSON */ }
  return `Request failed (${r.status})`;
}

/** Sequential scale low → high (one hue); "Not started" is the neutral dark anchor so it stands out. */
export const BUCKET_COLORS: Record<BillingBucketKey, string> = {
  NOT_STARTED: '#4b5563',
  P0_20: '#bfdbfe',
  P20_40: '#93c5fd',
  P40_60: '#60a5fa',
  P60_80: '#3b82f6',
  P80_100: '#2563eb',
  ACHIEVED: '#1e40af',
};

/* ─── Card ─────────────────────────────────────────────────────────────────── */

export function BillingProgressCard({ programState }: { programState: DashboardProgram }) {
  // The card has NO program dropdown of its own — it follows the Overview page's program filter.
  const { program, ready: programReady, reconcile } = programState;
  const months = useMemo(() => monthOptions(), []);
  const [month, setMonth] = useState<string>(months[0]);
  const [outletType, setOutletType] = useState('');
  const [managerId, setManagerId] = useState('');

  const [data, setData] = useState<BillingProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Last-known option lists — kept across a failed refetch so the filters stay usable.
  const [opts, setOpts] = useState<{ outletTypes: string[]; managers: BillingManager[] }>({
    outletTypes: [], managers: [],
  });
  const [drill, setDrill] = useState<{ key: BillingListKey; label: string } | null>(null);

  const filters: Filters = useMemo(() => ({ month, program, outletType, managerId }), [month, program, outletType, managerId]);

  useEffect(() => {
    if (!programReady) return;
    let cancelled = false;
    let dropped = false;
    setLoading(true);
    setError(null);
    fetch(`${BILLING_PROGRESS_URL}?${filterQuery(filters)}`, { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        const payload = unwrap<BillingProgressData>(await r.json());
        if (!payload || !Array.isArray(payload.buckets)) throw new Error('Empty or malformed response');
        if (cancelled) return;
        const programs = Array.isArray(payload.availablePrograms) ? payload.availablePrograms : [];
        setOpts({
          outletTypes: Array.isArray(payload.availableOutletTypes) ? payload.availableOutletTypes : [],
          managers: Array.isArray(payload.availableManagers) ? payload.availableManagers : [],
        });
        if (!reconcile(filters.program, programs)) { dropped = true; return; }
        setData(payload);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null); // never leave the previous filters' numbers under the new ones
        setError(err instanceof Error && err.message ? err.message : 'Failed to load billing progress');
      })
      .finally(() => { if (!cancelled && !dropped) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters, programReady, reconcile]);

  const refetching = loading && !!data;
  const kpi = data?.kpi ?? null;
  const unit = kpi?.unit ?? '';
  const titleMonth = monthWords(data?.month ?? month);

  const managerGroups = useMemo(() => {
    const groups = new Map<string, BillingManager[]>();
    for (const m of opts.managers) {
      const g = m.levelName || m.levelCode || 'Managers';
      groups.set(g, [...(groups.get(g) ?? []), m]);
    }
    return [...groups.entries()];
  }, [opts.managers]);

  const openDrill = useCallback((key: BillingListKey, label: string) => setDrill({ key, label }), []);

  const subtitle = !data
    ? null
    : !kpi
      ? null
      : data.asOf
        ? `Against each outlet's ${kpi.label} target · Data as of ${formatISTDate(data.asOf) || data.asOf}`
        : `Against each outlet's ${kpi.label} target · No sales data uploaded for this month yet`;

  const selectCls = 'w-full sm:w-auto min-w-0 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-800 bg-white focus:outline-none focus:border-[var(--brand-primary)]';

  return (
    <section
      className="bg-white rounded-xl border border-gray-200 px-4 sm:px-5 py-4 space-y-4 min-w-0"
      data-testid="billing-progress-card"
      aria-labelledby="billing-progress-title"
      aria-busy={loading || undefined}
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Receipt className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
            <h3 id="billing-progress-title" className="text-sm font-semibold text-gray-800">
              Monthly billing progress — {titleMonth}
            </h3>
          </div>
          {subtitle && (
            <p className="text-xs text-gray-500 mt-0.5 break-words" data-testid="billing-progress-subtitle">{subtitle}</p>
          )}
        </div>
        {refetching && (
          <span className="flex items-center gap-1 text-[11px] text-gray-400" data-testid="billing-progress-refetching">
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            Updating…
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:flex sm:flex-wrap sm:items-end gap-2 sm:gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-500 min-w-0">
          Month
          <select
            data-testid="billing-month"
            className={selectCls}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          >
            {months.map((m) => <option key={m} value={m}>{monthWords(m)}</option>)}
          </select>
        </label>
        {opts.outletTypes.length > 0 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-500 min-w-0">
            Outlet type
            <select
              data-testid="billing-outlet-type"
              className={selectCls}
              value={outletType}
              onChange={(e) => setOutletType(e.target.value)}
            >
              <option value="">All outlet types</option>
              {opts.outletTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        )}
        {opts.managers.length > 0 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-500 min-w-0">
            Manager
            <select
              data-testid="billing-manager"
              className={`${selectCls} sm:max-w-[16rem]`}
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
            >
              <option value="">Everyone</option>
              {managerGroups.map(([group, list]) => (
                <optgroup key={group} label={group}>
                  {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Body */}
      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 py-12 text-gray-400" data-testid="billing-progress-loading">
          <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
          <span className="text-sm">Loading billing progress…</span>
        </div>
      ) : error || !data ? (
        <div role="alert" data-testid="billing-progress-error" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>Couldn&apos;t load billing progress — {error ?? 'No data was returned by the server.'} Please refresh or try again later.</span>
        </div>
      ) : !kpi ? (
        <p className="py-8 text-center text-sm text-gray-500" data-testid="billing-progress-no-kpi">
          No headline target KPI configured for this tenant
        </p>
      ) : (
        <div className={`space-y-4 transition-opacity ${refetching ? 'opacity-60' : ''}`}>
          <BillingBody data={data} unit={unit} kpiLabel={kpi.label} monthLabel={titleMonth} disabled={refetching} onOpen={openDrill} />
        </div>
      )}

      {drill && data && kpi && (
        <BillingDrillDown
          filters={filters}
          listKey={drill.key}
          listLabel={drill.label}
          monthLabel={titleMonth}
          unit={unit}
          onClose={() => setDrill(null)}
        />
      )}
    </section>
  );
}

/* ─── Body (headline + distribution) ───────────────────────────────────────── */

function BillingBody({
  data, unit, kpiLabel, monthLabel, disabled, onOpen,
}: {
  data: BillingProgressData;
  unit: string;
  kpiLabel: string;
  monthLabel: string;
  disabled: boolean;
  onOpen: (key: BillingListKey, label: string) => void;
}) {
  const noTargetLabel = `No ${kpiLabel} target`;
  const noTargetLine = data.outletsWithoutTarget > 0 ? (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onOpen('NO_TARGET', noTargetLabel)}
      data-testid="billing-no-target"
      className="text-left text-xs text-gray-600 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:opacity-60"
    >
      {fmtInt(data.outletsWithoutTarget)} active {plural(data.outletsWithoutTarget, 'outlet has', 'outlets have')} no {kpiLabel} target this month
    </button>
  ) : (
    <p className="text-xs text-gray-500" data-testid="billing-no-target">
      Every active outlet has a {kpiLabel} target this month
    </p>
  );

  if (data.outletsInScope === 0) {
    return (
      <div className="space-y-3" data-testid="billing-progress-empty">
        <p className="py-6 text-center text-sm text-gray-500">
          No outlets have a {kpiLabel} target for {monthLabel} with these filters.
        </p>
        {data.outletsWithoutTarget > 0 && noTargetLine}
      </div>
    );
  }

  const { totals, behindPace } = data;
  const totalCount = data.buckets.reduce((s, b) => s + b.count, 0) || 1;
  const notStarted = data.buckets.find((b) => b.key === 'NOT_STARTED');
  const rest = data.buckets.filter((b) => b.key !== 'NOT_STARTED');

  return (
    <>
      {/* Headline */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5 min-w-0">
          <p className="text-[11px] text-gray-500">Outlets with a target</p>
          <p className="text-xl font-bold text-gray-900" data-testid="billing-outlets-in-scope">{fmtInt(data.outletsInScope)}</p>
        </div>
        <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5 min-w-0 sm:col-span-2">
          <p className="text-[11px] text-gray-500">Billed vs target</p>
          <p className="text-xl font-bold text-gray-900 break-words" data-testid="billing-totals">
            <span title={fmtBillingExact(totals.achievedSum, unit)}>{fmtBillingAmount(totals.achievedSum, unit)}</span>
            <span className="text-sm font-medium text-gray-500">
              {' '}of <span title={fmtBillingExact(totals.targetSum, unit)}>{fmtBillingAmount(totals.targetSum, unit)}</span>
              {' '}({pctOf(totals.achievedSum, totals.targetSum)})
            </span>
          </p>
        </div>
      </div>

      {/* Pace */}
      <p className="text-xs text-gray-600" data-testid="billing-pace">
        Day {fmtInt(data.daysElapsed)} of {fmtInt(data.daysInMonth)} ({data.pacePct}% of month) ·{' '}
        {behindPace.count > 0 ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onOpen('BEHIND_PACE', 'Behind pace')}
            data-testid="billing-behind-pace"
            className="font-semibold text-red-700 underline decoration-dotted underline-offset-2 hover:text-red-900 disabled:opacity-60"
          >
            {fmtInt(behindPace.count)} {plural(behindPace.count, 'outlet', 'outlets')} behind pace
          </button>
        ) : (
          <span className="font-semibold text-emerald-700" data-testid="billing-behind-pace">0 outlets behind pace</span>
        )}
      </p>

      {/* Distribution: stacked bar (visual) + labelled, clickable rows (the accessible source of truth) */}
      <div className="space-y-3">
        <div className="flex h-3 w-full gap-[2px] rounded-full overflow-hidden bg-gray-100" aria-hidden="true" data-testid="billing-stacked-bar">
          {data.buckets.filter((b) => b.count > 0).map((b) => (
            <div
              key={b.key}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(b.count / totalCount) * 100}%`, backgroundColor: BUCKET_COLORS[b.key] ?? '#9ca3af' }}
              title={`${b.label}: ${fmtInt(b.count)} outlets`}
            />
          ))}
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" aria-label="Outlets by billing progress">
          {notStarted && (
            <li className="sm:col-span-2 lg:col-span-3">
              <BucketButton bucket={notStarted} unit={unit} disabled={disabled} onOpen={onOpen} prominent />
            </li>
          )}
          {rest.map((b) => (
            <li key={b.key}>
              <BucketButton bucket={b} unit={unit} disabled={disabled} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      </div>

      {noTargetLine}
    </>
  );
}

function BucketButton({
  bucket, unit, disabled, onOpen, prominent,
}: {
  bucket: BillingBucket;
  unit: string;
  disabled: boolean;
  onOpen: (key: BillingListKey, label: string) => void;
  prominent?: boolean;
}) {
  const target = fmtBillingAmount(bucket.targetSum, unit);
  const billed = fmtBillingAmount(bucket.achievedSum, unit);
  const aria = `${bucket.label}: ${fmtInt(bucket.count)} ${plural(bucket.count, 'outlet', 'outlets')}, ${bucket.pctOfOutlets}% of outlets, target ${target}, billed ${billed}. Show outlets`;
  return (
    <button
      type="button"
      disabled={disabled || bucket.count === 0}
      onClick={() => onOpen(bucket.key, bucket.label)}
      aria-label={aria}
      data-testid={`billing-bucket-${bucket.key}`}
      className={`w-full text-left rounded-lg border px-3 py-2.5 min-w-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] enabled:hover:bg-gray-50 disabled:cursor-default ${
        prominent ? 'border-2 border-gray-700 bg-gray-50' : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: BUCKET_COLORS[bucket.key] ?? '#9ca3af' }} aria-hidden="true" />
          <span className={`truncate ${prominent ? 'text-sm font-bold text-gray-900' : 'text-xs font-semibold text-gray-700'}`}>{bucket.label}</span>
        </span>
        <span className="text-[11px] text-gray-500 shrink-0">{bucket.pctOfOutlets}% of outlets</span>
      </div>
      <p className={`font-bold text-gray-900 mt-1 ${prominent ? 'text-2xl' : 'text-lg'}`}>
        {fmtInt(bucket.count)} <span className="text-xs font-medium text-gray-500">{plural(bucket.count, 'outlet', 'outlets')}</span>
      </p>
      <p className="text-[11px] text-gray-500 break-words">
        Target <span title={fmtBillingExact(bucket.targetSum, unit)}>{target}</span>
        {' · '}Billed <span title={fmtBillingExact(bucket.achievedSum, unit)}>{billed}</span>
      </p>
    </button>
  );
}

/* ─── Drill-down ───────────────────────────────────────────────────────────── */

function BillingDrillDown({
  filters, listKey, listLabel, monthLabel, unit, onClose,
}: {
  filters: Filters;
  listKey: BillingListKey;
  listLabel: string;
  monthLabel: string;
  unit: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<BillingOutletsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const exportAction = useDownloadAction();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = filterQuery(filters, { bucket: listKey, page, pageSize: BILLING_OUTLETS_PAGE_SIZE });
    fetch(`${BILLING_OUTLETS_URL}?${qs}`, { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        const payload = unwrap<BillingOutletsPage>(await r.json());
        if (!payload || !Array.isArray(payload.rows)) throw new Error('Empty or malformed response');
        if (!cancelled) setResult(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult(null);
          setError(err instanceof Error && err.message ? err.message : 'Failed to load outlets');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters, listKey, page]);

  const total = result?.total ?? 0;
  const pageSize = result?.pageSize || BILLING_OUTLETS_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  const runExport = exportAction.run;
  const handleExport = useCallback(() => {
    void runExport(`${BILLING_OUTLETS_EXPORT_URL}?${filterQuery(filters, { bucket: listKey })}`, {
      fallbackFileName: `billing-progress-${listKey.toLowerCase()}-${filters.month}.xlsx`,
      init: { headers: { ...authHeader() } },
    });
  }, [filters, listKey, runExport]);

  const filterBits = [monthLabel];
  if (filters.program) filterBits.push(`Program: ${filters.program}`);
  if (filters.outletType) filterBits.push(`Outlet type: ${filters.outletType}`);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`${listLabel} — ${monthLabel}`}
      description={filterBits.join(' · ')}
      className="max-w-[calc(100vw-1rem)] sm:max-w-4xl p-4 sm:p-6"
    >
      <div className="space-y-3" data-testid="billing-drilldown">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-500" data-testid="billing-drilldown-count">
            {loading && !result ? 'Loading outlets…' : `Showing ${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(total)} ${plural(total, 'outlet', 'outlets')}`}
          </p>
          <button
            type="button"
            onClick={handleExport}
            disabled={exportAction.blocked || total === 0}
            data-testid="billing-download-excel"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            {exportAction.busy ? <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Download className="h-3 w-3" aria-hidden="true" />}
            {downloadButtonLabel(exportAction, 'Download Excel')}
          </button>
        </div>
        <DownloadActionStatus action={exportAction} />

        {error ? (
          <div role="alert" data-testid="billing-drilldown-error" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Couldn&apos;t load the outlet list — {error}</span>
          </div>
        ) : (
          <div className={`overflow-x-auto rounded-lg border border-gray-100 ${loading && result ? 'opacity-60' : ''}`} aria-busy={loading || undefined}>
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th scope="col" className="text-left font-semibold px-3 py-2">Outlet</th>
                  <th scope="col" className="text-left font-semibold px-3 py-2">Program</th>
                  <th scope="col" className="text-left font-semibold px-3 py-2">Type</th>
                  <th scope="col" className="text-left font-semibold px-3 py-2">SO</th>
                  <th scope="col" className="text-left font-semibold px-3 py-2">ASM</th>
                  <th scope="col" className="text-right font-semibold px-3 py-2">Target</th>
                  <th scope="col" className="text-right font-semibold px-3 py-2">Billed</th>
                  <th scope="col" className="text-right font-semibold px-3 py-2">%</th>
                </tr>
              </thead>
              <tbody>
                {loading && !result && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">Loading…</td></tr>
                )}
                {result && result.rows.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">No outlets in this list.</td></tr>
                )}
                {result?.rows.map((r) => (
                  <tr key={r.outletCode} className="border-t border-gray-50">
                    <td className="px-3 py-2 min-w-[10rem]">
                      <span className="font-medium text-gray-800">{r.outletName}</span>
                      <span className="block text-[10px] text-gray-400">{r.outletCode}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-600">{r.program ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{r.outletType ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{r.soName ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{r.asmName ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">{fmtBillingExact(r.target, unit)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-800 whitespace-nowrap">{fmtBillingExact(r.achieved, unit)}</td>
                    <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">{r.pct === null || r.pct === undefined ? '—' : `${r.pct.toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={loading || page <= 1}
              data-testid="billing-drilldown-prev"
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs disabled:opacity-50"
            >
              <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> Previous
            </button>
            <span className="text-xs text-gray-500">Page {page} of {pages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={loading || page >= pages}
              data-testid="billing-drilldown-next"
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs disabled:opacity-50"
            >
              Next <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default BillingProgressCard;
