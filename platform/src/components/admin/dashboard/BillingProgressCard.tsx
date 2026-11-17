'use client';

/**
 * Monthly billing progress — Overview dashboard card (all tenants).
 *
 * 100% wired to GET /api/admin/dashboard/billing-progress (proxy → /v1/admin/dashboard/billing-progress):
 * how far each outlet has billed against its target for ONE KPI this month (the tenant's primary KPI, or the
 * platform fallback), bucketed 0 → 100%+, with a pace line paced to the DATA date ("Day 12 of 30 · N outlets
 * behind pace" + what "behind pace" means), and every outlet that isn't bucketed called out: no target,
 * not covered by the KPI's applies-to scope, and target rows for outlets outside the live roster.
 * Clicking a bucket / "behind pace" / "no target" / "not covered" opens the outlet list
 * (GET …/billing-progress/outlets, paginated) with a Download Excel button (…/billing-progress/outlets/export,
 * export kind `billing-progress-outlets` — streams instantly, or 202 → Downloads page via useDownloadAction).
 *
 * Program: follows the Overview page's program filter (no dropdown on the card itself); the subtitle names it.
 * Honest states: no enabled KPI → the card is hidden; no sales uploaded yet → says so (no fake zeros, no red
 * "behind pace"); future month → empty state; past month → "missed target"; fetch failure → an error (the previous
 * filter's numbers are never left on screen under new filters).
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

/** Backend: BILLING_PROGRESS_OUTLETS_KIND_ID (api/src/exports/kinds/batch2/billing-progress.kind.ts). */
export const BILLING_PROGRESS_EXPORT_KIND = 'billing-progress-outlets';

export const BILLING_PROGRESS_URL = '/api/admin/dashboard/billing-progress';
export const BILLING_OUTLETS_URL = '/api/admin/dashboard/billing-progress/outlets';
export const BILLING_OUTLETS_EXPORT_URL = '/api/admin/dashboard/billing-progress/outlets/export';
export const BILLING_OUTLETS_PAGE_SIZE = 25;
/** Month picker: the current month + this many previous months. */
export const BILLING_MONTHS_BACK = 12;

/* ─── API contract ─────────────────────────────────────────────────────────── */

export type BillingBucketKey = 'NOT_STARTED' | 'P0_20' | 'P20_40' | 'P40_60' | 'P60_80' | 'P80_100' | 'ACHIEVED';
export type BillingListKey = BillingBucketKey | 'BEHIND_PACE' | 'NO_TARGET' | 'NOT_COVERED';

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
  monthStatus?: 'PAST' | 'CURRENT' | 'FUTURE';
  /** null = no pace (no sales yet, or a future month). */
  daysElapsed: number | null;
  daysInMonth: number;
  pacePct: number | null;
  /** The IST date pace is measured to (YYYY-MM-DD). */
  paceAsOf?: string | null;
  /** Past month whose data reaches its last day ("missed target"); false = data stops early. */
  fullMonth?: boolean;
  /** Outlets with a positive target (KYC-pending included). */
  outletsInScope: number;
  outletsWithoutTarget: number;
  outletsNotCovered?: number;
  targetsOutsideRoster?: number;
  /** Σ over the outlets WITH a target only. */
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
  /** e.g. "Not counted — outside this target’s scope" (NOT_COVERED rows). */
  note?: string | null;
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

/** Exact figure (table cells / tooltips / aria): INR → ₹ whole rupees with Indian grouping; other units ≤ 2 dp. */
export function fmtBillingExact(value: number, unit: string | null | undefined): string {
  return isInrUnit(unit) ? `₹${fmtKpiNum(value, unit)}` : fmtKpiNum(value, unit);
}

/** Column-header unit: INR → "(₹)", another unit → "(<unit>)", none → "". */
export function unitHeader(unit: string | null | undefined): string {
  if (isInrUnit(unit)) return ' (₹)';
  const u = (unit ?? '').trim();
  return u ? ` (${u})` : '';
}

/**
 * Achieved ÷ target, 1 dp — FLOORED below 100 (99.96 → 99.9) so an unmet total never reads "100.0%";
 * the same rule the outlet rows use (backend `displayPct`).
 */
export function pctOf(achieved: number, target: number): string {
  if (!(target > 0)) return '—';
  const raw = (achieved / target) * 100;
  const met = target - achieved < 0.005;
  const shown = met ? Math.max(100, Math.floor(raw * 10) / 10) : Math.min(99.9, Math.floor(raw * 10) / 10);
  return `${shown.toFixed(1)}%`;
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

/**
 * Colours: "Not started" = a clearly distinct LIGHT grey (always drawn with a border / stripe so it reads on
 * white); the middle bands = a blue ramp light → dark, every step ≥ 3:1 against white (WCAG non-text);
 * Achieved = green. The text labels stay the source of truth.
 */
export const BUCKET_COLORS: Record<BillingBucketKey, string> = {
  NOT_STARTED: '#e5e7eb',
  // Each step ≥ 3:1 vs white AND ≥ 1.25:1 vs its neighbour (60–79% and 80–99% clearly apart).
  P0_20: '#3b82f6',
  P20_40: '#2563eb',
  P40_60: '#1d4ed8',
  P60_80: '#1e3a8a',
  P80_100: '#172554',
  ACHIEVED: '#15803d',
};
const NOT_STARTED_BORDER = '#9ca3af';
const NOT_STARTED_STRIPES = `repeating-linear-gradient(45deg, ${BUCKET_COLORS.NOT_STARTED} 0 4px, #d1d5db 4px 6px)`;

/** Inline style for a bucket swatch / bar segment (Not started gets its stripe + border). */
function bucketStyle(key: BillingBucketKey): React.CSSProperties {
  if (key === 'NOT_STARTED') {
    return { background: NOT_STARTED_STRIPES, border: `1px solid ${NOT_STARTED_BORDER}` };
  }
  return { backgroundColor: BUCKET_COLORS[key] ?? '#6b7280' };
}

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
  // The last GOOD response said the tenant has no enabled KPI → the card stays hidden, even while a refetch is
  // loading or fails (no "Couldn't load" flash for a card that has nothing to show).
  const [noKpi, setNoKpi] = useState(false);

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
        setNoKpi(!payload.kpi);
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
  const managerName = managerId ? opts.managers.find((m) => m.id === managerId)?.name ?? null : null;

  const openDrill = useCallback((key: BillingListKey, label: string) => setDrill({ key, label }), []);

  // F3 / D6: the tenant has no enabled KPI at all → nothing to report; the card is hidden (no fake zeros, and no
  // error / loading flash on a later refetch).
  if (noKpi) return null;

  const subtitleParts = [
    kpi ? `Against each outlet's ${kpi.label} target` : null,
    program ? `Program: ${program}` : null,
    data?.asOf ? `Data as of ${formatISTDate(data.asOf) || data.asOf}` : null,
  ].filter((p): p is string => !!p);
  const subtitle = subtitleParts.length ? subtitleParts.join(' · ') : null;

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
      ) : error || !data || !kpi ? (
        <div role="alert" data-testid="billing-progress-error" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>Couldn&apos;t load billing progress — {error ?? 'No data was returned by the server.'} Please refresh or try again later.</span>
        </div>
      ) : (
        <div className={`space-y-4 transition-opacity ${refetching ? 'opacity-60' : ''}`}>
          <BillingBody
            data={data}
            unit={unit}
            kpiLabel={kpi.label}
            monthLabel={titleMonth}
            filtered={!!(program || outletType || managerId)}
            disabled={refetching}
            onOpen={openDrill}
          />
        </div>
      )}

      {drill && data && kpi && (
        <BillingDrillDown
          filters={filters}
          listKey={drill.key}
          listLabel={drill.label}
          monthLabel={titleMonth}
          managerName={managerName}
          unit={unit}
          onClose={() => setDrill(null)}
        />
      )}
    </section>
  );
}

/* ─── Body (headline + distribution) ───────────────────────────────────────── */

function BillingBody({
  data, unit, kpiLabel, monthLabel, filtered, disabled, onOpen,
}: {
  data: BillingProgressData;
  unit: string;
  kpiLabel: string;
  monthLabel: string;
  filtered: boolean;
  disabled: boolean;
  onOpen: (key: BillingListKey, label: string) => void;
}) {
  // "Missed target" only when the month is over AND the data reaches its end; otherwise pace to the data date.
  const isPast = data.monthStatus === 'PAST' && data.fullMonth !== false;
  const partialPast = data.monthStatus === 'PAST' && data.fullMonth === false;
  const notCovered = data.outletsNotCovered ?? 0;
  const outsideRoster = data.targetsOutsideRoster ?? 0;

  const linkCls = 'text-left text-xs text-gray-600 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:opacity-60';
  const noTargetLabel = `No ${kpiLabel} target`;
  const noTargetLine = data.outletsWithoutTarget > 0 ? (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onOpen('NO_TARGET', noTargetLabel)}
      data-testid="billing-no-target"
      className={linkCls}
    >
      {fmtInt(data.outletsWithoutTarget)} active {plural(data.outletsWithoutTarget, 'outlet has', 'outlets have')} no {kpiLabel} target this month
    </button>
  ) : (
    <p className="text-xs text-gray-500" data-testid="billing-no-target">
      Every active outlet has a {kpiLabel} target this month
    </p>
  );
  const notCoveredLine = notCovered > 0 ? (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onOpen('NOT_COVERED', `Not covered by the ${kpiLabel} target`)}
      data-testid="billing-not-covered"
      className={linkCls}
    >
      {fmtInt(notCovered)} {plural(notCovered, "outlet isn't", "outlets aren't")} covered by the {kpiLabel} target
    </button>
  ) : null;
  const outsideRosterLine = outsideRoster > 0 ? (
    <p className="text-xs text-amber-800" data-testid="billing-outside-roster">
      {fmtInt(outsideRoster)} target {plural(outsideRoster, 'row', 'rows')} for this month {plural(outsideRoster, 'belongs', 'belong')} to
      outlets that aren&apos;t in the live roster (deleted, parked or not interested) and aren&apos;t counted here.
      {filtered ? ' (tenant-wide)' : ''}
    </p>
  ) : null;
  const kycNote = (
    <p className="text-[11px] text-gray-500" data-testid="billing-kyc-note">Includes outlets whose KYC is still pending.</p>
  );
  const sideLines = (
    <div className="flex flex-col items-start gap-1">
      {noTargetLine}
      {notCoveredLine}
      {outsideRosterLine}
      {kycNote}
    </div>
  );

  // Future month — nothing has happened yet.
  if (data.monthStatus === 'FUTURE') {
    return (
      <div className="space-y-3" data-testid="billing-future-month">
        <p className="py-6 text-center text-sm text-gray-500">{monthLabel} hasn&apos;t started yet.</p>
      </div>
    );
  }

  if (data.outletsInScope === 0) {
    return (
      <div className="space-y-3" data-testid="billing-progress-empty">
        <p className="py-6 text-center text-sm text-gray-500">
          No outlets have a {kpiLabel} target for {monthLabel} with these filters.
        </p>
        {sideLines}
      </div>
    );
  }

  const { totals, behindPace } = data;
  const headlineCount = (
    <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5 min-w-0">
      <p className="text-[11px] text-gray-500">Outlets with a target</p>
      <p className="text-xl font-bold text-gray-900" data-testid="billing-outlets-in-scope">{fmtInt(data.outletsInScope)}</p>
    </div>
  );

  // F2: no sales uploaded for the month — show the target, not fake zeros or a red "behind pace".
  if (!data.asOf) {
    return (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {headlineCount}
          <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5 min-w-0 sm:col-span-2">
            <p className="text-[11px] text-gray-500">Target (outlets with a target)</p>
            <p className="text-xl font-bold text-gray-900 break-words" data-testid="billing-target-total">
              <span title={fmtBillingExact(totals.targetSum, unit)}>{fmtBillingAmount(totals.targetSum, unit)}</span>
            </p>
          </div>
        </div>
        <p className="rounded-lg border border-dashed border-gray-300 px-3 py-4 text-center text-sm text-gray-600" data-testid="billing-no-sales">
          No sales uploaded for {monthLabel} yet
        </p>
        {sideLines}
      </>
    );
  }

  const totalCount = data.buckets.reduce((s, b) => s + b.count, 0) || 1;
  const notStarted = data.buckets.find((b) => b.key === 'NOT_STARTED');
  const rest = data.buckets.filter((b) => b.key !== 'NOT_STARTED');
  const behindWord = isPast ? 'missed target' : 'behind pace';
  const behindListLabel = isPast ? 'Missed target' : 'Behind pace';
  const hasPace = data.pacePct !== null && data.pacePct !== undefined && data.daysElapsed !== null && data.daysElapsed !== undefined;

  return (
    <>
      {/* Headline */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {headlineCount}
        <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5 min-w-0 sm:col-span-2">
          <p className="text-[11px] text-gray-500" data-testid="billing-totals-label">Billed vs target (outlets with a target)</p>
          <p className="text-xl font-bold text-gray-900 break-words" data-testid="billing-totals">
            <span title={fmtBillingExact(totals.achievedSum, unit)}>{fmtBillingAmount(totals.achievedSum, unit)}</span>
            <span className="text-sm font-medium text-gray-500">
              {' '}of <span title={fmtBillingExact(totals.targetSum, unit)}>{fmtBillingAmount(totals.targetSum, unit)}</span>
              {' '}({pctOf(totals.achievedSum, totals.targetSum)})
            </span>
          </p>
        </div>
      </div>

      {/* Pace (to the data date) */}
      {hasPace && (
        <div className="space-y-0.5">
          <p className="text-xs text-gray-600" data-testid="billing-pace">
            {isPast
              ? 'Full month · '
              : partialPast && data.paceAsOf
                ? `Data up to ${formatISTDate(data.paceAsOf) || data.paceAsOf} (${data.pacePct}% of month) · `
                : `Day ${fmtInt(data.daysElapsed as number)} of ${fmtInt(data.daysInMonth)} (${data.pacePct}% of month) · `}
            {behindPace.count > 0 ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onOpen('BEHIND_PACE', behindListLabel)}
                data-testid="billing-behind-pace"
                className="font-semibold text-red-700 underline decoration-dotted underline-offset-2 hover:text-red-900 disabled:opacity-60"
              >
                {fmtInt(behindPace.count)} {plural(behindPace.count, 'outlet', 'outlets')} {behindWord}
              </button>
            ) : (
              <span className="font-semibold text-emerald-700" data-testid="billing-behind-pace">0 outlets {behindWord}</span>
            )}
          </p>
          {!isPast && data.paceAsOf && (
            <p className="text-[11px] text-gray-500" data-testid="billing-pace-caption">
              Behind pace = billed less than {data.pacePct}% of target by {formatISTDate(data.paceAsOf) || data.paceAsOf}
            </p>
          )}
        </div>
      )}

      {/* Distribution: stacked bar (visual) + labelled, clickable rows (the accessible source of truth) */}
      <div className="space-y-3">
        <div className="flex h-3 w-full gap-[2px] rounded-full overflow-hidden bg-gray-100" aria-hidden="true" data-testid="billing-stacked-bar">
          {data.buckets.filter((b) => b.count > 0).map((b) => (
            <div
              key={b.key}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(b.count / totalCount) * 100}%`, ...bucketStyle(b.key) }}
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

      {sideLines}
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
  // Screen readers get the EXACT figures (the compact L / Cr text is for the eye). A zero-count bucket is
  // disabled, so it doesn't invite "Show outlets".
  const aria = `${bucket.label}: ${fmtInt(bucket.count)} ${plural(bucket.count, 'outlet', 'outlets')}, ${bucket.pctOfOutlets}% of outlets, target ${fmtBillingExact(bucket.targetSum, unit)}, billed ${fmtBillingExact(bucket.achievedSum, unit)}${bucket.count > 0 ? '. Show outlets' : ''}`;
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
          <span
            className="w-2.5 h-2.5 rounded-sm shrink-0"
            style={bucketStyle(bucket.key)}
            data-testid={`billing-swatch-${bucket.key}`}
            aria-hidden="true"
          />
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
  filters, listKey, listLabel, monthLabel, managerName, unit, onClose,
}: {
  filters: Filters;
  listKey: BillingListKey;
  listLabel: string;
  monthLabel: string;
  managerName: string | null;
  unit: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<BillingOutletsPage | null>(null);
  // Last known total / page size — paging keeps working after a failed page load.
  const [known, setKnown] = useState<{ total: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
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
        if (cancelled) return;
        setResult(payload);
        setKnown({ total: payload.total, pageSize: payload.pageSize || BILLING_OUTLETS_PAGE_SIZE });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult(null);
          setError(err instanceof Error && err.message ? err.message : 'Failed to load outlets');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters, listKey, page, attempt]);

  const total = known?.total ?? 0;
  const pageSize = known?.pageSize ?? BILLING_OUTLETS_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // The range describes the rows ON SCREEN — i.e. the page the server returned, not the one requested.
  const shownPage = result?.page ?? page;
  const shownSize = result?.pageSize || pageSize;
  const from = !result || result.total === 0 ? 0 : (shownPage - 1) * shownSize + 1;
  const to = result ? Math.min(result.total, shownPage * shownSize) : 0;

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
  if (filters.managerId) filterBits.push(`Manager: ${managerName ?? 'selected manager'} (and team)`);

  const u = unitHeader(unit);
  // Phone (< sm): Outlet, %, Billed, Target (+ SO) — Program / Type / ASM only from sm up.
  const wide = 'hidden sm:table-cell';
  const th = 'font-semibold px-3 py-2';

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
          {error ? (
            <span />
          ) : (
            <p className="text-xs text-gray-500" data-testid="billing-drilldown-count">
              {loading && !result
                ? 'Loading outlets…'
                : `Showing ${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(result?.total ?? total)} ${plural(result?.total ?? total, 'outlet', 'outlets')}`}
            </p>
          )}
          <button
            type="button"
            onClick={handleExport}
            disabled={exportAction.blocked}
            data-testid="billing-download-excel"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            {exportAction.busy ? <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Download className="h-3 w-3" aria-hidden="true" />}
            {downloadButtonLabel(exportAction, 'Download Excel')}
          </button>
        </div>
        <DownloadActionStatus action={exportAction} />

        {error ? (
          <div role="alert" data-testid="billing-drilldown-error" className="flex flex-wrap items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">Couldn&apos;t load the outlet list — {error}</span>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              disabled={loading}
              data-testid="billing-drilldown-retry"
              className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" /> Retry
            </button>
          </div>
        ) : (
          <div className={`overflow-x-auto rounded-lg border border-gray-100 ${loading && result ? 'opacity-60' : ''}`} aria-busy={loading || undefined}>
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th scope="col" className={`text-left ${th}`}>Outlet</th>
                  <th scope="col" className={`text-right ${th}`}>%</th>
                  <th scope="col" className={`text-right ${th} whitespace-nowrap`}>Billed{u}</th>
                  <th scope="col" className={`text-right ${th} whitespace-nowrap`}>Target{u}</th>
                  <th scope="col" className={`text-left ${th}`}>SO</th>
                  <th scope="col" className={`text-left ${th} ${wide}`}>ASM</th>
                  <th scope="col" className={`text-left ${th} ${wide}`}>Program</th>
                  <th scope="col" className={`text-left ${th} ${wide}`}>Type</th>
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
                    <td className="px-3 py-2 min-w-[8rem] sm:min-w-[10rem]">
                      <span className="font-medium text-gray-800">{r.outletName}</span>
                      <span className="block text-[10px] text-gray-400">{r.outletCode}</span>
                      {r.note && (
                        <span className="block text-[10px] text-amber-700" data-testid={`billing-row-note-${r.outletCode}`}>{r.note}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">{r.pct === null || r.pct === undefined ? '—' : `${r.pct.toFixed(1)}%`}</td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-800 whitespace-nowrap">{fmtBillingExact(r.achieved, unit)}</td>
                    <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">{fmtBillingExact(r.target, unit)}</td>
                    <td className="px-3 py-2 text-gray-600">{r.soName ?? '—'}</td>
                    <td className={`px-3 py-2 text-gray-600 ${wide}`}>{r.asmName ?? '—'}</td>
                    <td className={`px-3 py-2 text-gray-600 ${wide}`}>{r.program ?? '—'}</td>
                    <td className={`px-3 py-2 text-gray-600 ${wide}`}>{r.outletType ?? '—'}</td>
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
            <span className="text-xs text-gray-500">Page {shownPage} of {pages}</span>
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
