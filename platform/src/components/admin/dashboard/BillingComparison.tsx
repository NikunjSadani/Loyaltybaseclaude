'use client';

/**
 * Billing comparison — a compact row for the "Monthly billing progress" card's headline:
 *   "vs last month (to day 17): ▲ +12.4%"   ·   "vs 3-month average (to day 17): ▼ −3.1%"
 *   "N outlets billing slower than usual (below 80% of their pace last month)" → drill-down modal
 *
 * Wired to GET /api/admin/dashboard/billing-progress/comparison (proxy → /v1/admin/dashboard/billing-progress/comparison)
 * with the SAME filters as the card; the drill-down pages …/comparison/slower-outlets and downloads
 * …/comparison/slower-outlets/export (export kind `billing-comparison-slower`).
 *
 * Honest states:
 *   - tenant without day-level sales data (`reason: NO_DAY_LEVEL_DATA`) or no KPI → renders NOTHING;
 *   - a comparison that isn't available yet → "Comparison with last month available from December 2026";
 *   - the selected month has no day data / the day data doesn't carry the KPI → says so in one line;
 *   - prior month billed nothing → "nothing billed last month to compare" (never a fake ±100%);
 *   - loading → a muted line; error → an alert with Retry (the previous filters' figures are never kept).
 * Direction is carried by an arrow AND a sign AND words for screen readers — never colour alone.
 *
 * Self-contained (no import from BillingProgressCard): embed as
 *   <BillingComparison month={month} program={program} outletType={outletType} managerId={managerId} managerName={managerName} />
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Download, Loader2, RefreshCw } from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import { fmtKpiNum } from '@/lib/pace';
import { formatInrCompact, isInrUnit } from '@/lib/format-inr';
import { PROGRAM_URL_PARAM } from '@/lib/dashboard-program';
import { Modal } from '@/components/ui/modal';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

/** Backend: BILLING_COMPARISON_SLOWER_KIND_ID (api/src/exports/kinds/batch2/billing-comparison.kind.ts). */
export const BILLING_COMPARISON_EXPORT_KIND = 'billing-comparison-slower';
export const BILLING_COMPARISON_URL = '/api/admin/dashboard/billing-progress/comparison';
export const BILLING_SLOWER_URL = '/api/admin/dashboard/billing-progress/comparison/slower-outlets';
export const BILLING_SLOWER_EXPORT_URL = '/api/admin/dashboard/billing-progress/comparison/slower-outlets/export';
export const BILLING_SLOWER_PAGE_SIZE = 25;

/* ─── API contract ─────────────────────────────────────────────────────────── */

export type ComparisonReason = 'NO_DAY_LEVEL_DATA' | 'NO_KPI' | 'NO_DAY_DATA_FOR_MONTH' | 'KPI_NOT_IN_DAY_DATA';

export interface BillingComparisonData {
  month: string;
  kpi: { code: string; label: string; unit: string } | null;
  reason: ComparisonReason | null;
  compareDay: number | null;
  current: { mtd: number | null; outlets: number };
  lastMonth: {
    available: boolean;
    availableFrom: string | null;
    reason?: string | null;
    month: string;
    compareDay: number | null;
    mtd: number | null;
    deltaPct: number | null;
  };
  threeMonthAvg: {
    available: boolean;
    availableFrom: string | null;
    reason?: string | null;
    months: string[];
    compareDays?: Array<number | null>;
    avgMtd: number | null;
    deltaPct: number | null;
  };
  slowerThanUsual: { count: number; thresholdPct: number };
}

export interface SlowerOutletRow {
  outletCode: string;
  outletName: string;
  program: string | null;
  soName: string | null;
  asmName: string | null;
  currentMtd: number;
  lastMonthMtd: number;
  ratioPct: number;
}

interface SlowerPage { rows: SlowerOutletRow[]; total: number; page: number; pageSize: number }

export interface BillingComparisonProps {
  /** YYYY-MM (the card's selected month). */
  month: string;
  /** Trimmed program name; '' = all programs. */
  program?: string;
  /** Outlet type code; '' = all. */
  outletType?: string;
  /** Sales-user id; '' = everyone. */
  managerId?: string;
  /** Display name of the selected manager (for the drill-down subtitle only). */
  managerName?: string | null;
}

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-12" → "December 2026". */
export function comparisonMonthWords(key: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? '');
  if (!m) return key ?? '';
  const name = MONTH_NAMES[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : (key ?? '');
}

/** Compact amount for tooltips: INR → ₹ L/Cr; other units ≤ 2 dp + unit. */
function fmtAmount(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (isInrUnit(unit)) return formatInrCompact(Math.round(value));
  return `${fmtKpiNum(value, unit)}${unit ? ` ${unit}` : ''}`;
}

/** Exact figure for table cells: INR → ₹ whole rupees with Indian grouping; other units ≤ 2 dp. */
function fmtExact(value: number, unit: string): string {
  return isInrUnit(unit) ? `₹${fmtKpiNum(value, unit)}` : fmtKpiNum(value, unit);
}

function unitHeader(unit: string): string {
  if (isInrUnit(unit)) return ' (₹)';
  const u = (unit ?? '').trim();
  return u ? ` (${u})` : '';
}

const fmtInt = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString('en-IN');
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A signed delta as text: "▲ +12.4%", "▼ −3.1%", "no change". `words` = the screen-reader phrasing. */
export function deltaText(pct: number): { arrow: string; text: string; words: string; dir: 'up' | 'down' | 'flat' } {
  const abs = Math.abs(pct).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (pct > 0) return { arrow: '▲', text: `+${abs}%`, words: `up ${abs}%`, dir: 'up' };
  if (pct < 0) return { arrow: '▼', text: `−${abs}%`, words: `down ${abs}%`, dir: 'down' };
  return { arrow: '', text: 'no change', words: 'no change', dir: 'flat' };
}

interface Filters { month: string; program: string; outletType: string; managerId: string }

function filterQuery(f: Filters, extra: Record<string, string | number> = {}): string {
  const sp = new URLSearchParams();
  sp.set('month', f.month);
  if (f.program) sp.set(PROGRAM_URL_PARAM, f.program);
  if (f.outletType) sp.set('outletType', f.outletType);
  if (f.managerId) sp.set('managerId', f.managerId);
  for (const [k, v] of Object.entries(extra)) sp.set(k, String(v));
  return sp.toString();
}

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

/* ─── Component ────────────────────────────────────────────────────────────── */

export function BillingComparison({ month, program = '', outletType = '', managerId = '', managerName = null }: BillingComparisonProps) {
  const filters: Filters = useMemo(() => ({ month, program, outletType, managerId }), [month, program, outletType, managerId]);
  const [data, setData] = useState<BillingComparisonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [drillOpen, setDrillOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null); // never show the previous filters' comparison under new filters
    fetch(`${BILLING_COMPARISON_URL}?${filterQuery(filters)}`, { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        const payload = unwrap<BillingComparisonData>(await r.json());
        if (!payload || !payload.lastMonth || !payload.threeMonthAvg) throw new Error('Empty or malformed response');
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error && err.message ? err.message : 'Failed to load the comparison');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters, attempt]);

  const wrap = (children: React.ReactNode, busy = false) => (
    <div
      className="flex flex-col gap-1 text-xs text-gray-600 min-w-0"
      data-testid="billing-comparison"
      aria-busy={busy || undefined}
    >
      {children}
    </div>
  );

  if (loading) {
    return wrap(
      <p className="flex items-center gap-1.5 text-gray-400" role="status" data-testid="billing-comparison-loading">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
        Loading comparison with last month…
      </p>,
      true,
    );
  }

  if (error || !data) {
    return wrap(
      <div role="alert" data-testid="billing-comparison-error" className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-red-700">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">Couldn&apos;t load the comparison with last month — {error ?? 'No data was returned by the server.'}</span>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          data-testid="billing-comparison-retry"
          className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2 py-0.5 font-semibold text-red-700 hover:bg-red-50"
        >
          <RefreshCw className="w-3 h-3" aria-hidden="true" /> Retry
        </button>
      </div>,
    );
  }

  // Not a day-level tenant (or no KPI): the card shows no comparison at all.
  if (data.reason === 'NO_DAY_LEVEL_DATA' || data.reason === 'NO_KPI' || !data.kpi) return null;

  const unit = data.kpi.unit ?? '';
  const monthLabel = comparisonMonthWords(data.month);

  if (data.reason === 'NO_DAY_DATA_FOR_MONTH') {
    return wrap(
      <p data-testid="billing-comparison-no-month-data" className="text-gray-500">
        No day-by-day sales for {monthLabel} yet, so it can&apos;t be compared with earlier months.
      </p>,
    );
  }
  if (data.reason === 'KPI_NOT_IN_DAY_DATA') {
    return wrap(
      <p data-testid="billing-comparison-kpi-missing" className="text-gray-500">
        The day-by-day sales data doesn&apos;t include {data.kpi.label}, so it can&apos;t be compared with earlier months.
      </p>,
    );
  }

  const D = data.compareDay;
  const lm = data.lastMonth;
  const avg = data.threeMonthAvg;
  const lmDay = lm.compareDay !== null && lm.compareDay !== D ? `to day ${D}; day ${lm.compareDay} last month` : `to day ${D}`;
  const avgDays = (avg.compareDays ?? []).filter((d): d is number => typeof d === 'number');
  const avgShort = avgDays.some((d) => d !== D);
  const avgDay = avgShort ? `to day ${D}, or the last day of a shorter month` : `to day ${D}`;

  return wrap(
    <>
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-x-4 gap-y-1">
        <ComparisonLine
          testId="billing-vs-last-month"
          label={`vs last month (${lmDay})`}
          available={lm.available}
          deltaPct={lm.deltaPct}
          unavailableText={
            lm.availableFrom
              ? `Comparison with last month available from ${comparisonMonthWords(lm.availableFrom)}`
              : 'Comparison with last month not available'
          }
          zeroBaseText="nothing billed last month to this day to compare"
          title={lm.available ? `This month ${fmtAmount(data.current.mtd, unit)} · ${comparisonMonthWords(lm.month)} ${fmtAmount(lm.mtd, unit)}` : undefined}
        />
        <ComparisonLine
          testId="billing-vs-3-month-avg"
          label={`vs 3-month average (${avgDay})`}
          available={avg.available}
          deltaPct={avg.deltaPct}
          unavailableText={
            avg.availableFrom
              ? `3-month average available from ${comparisonMonthWords(avg.availableFrom)}`
              : '3-month average not available'
          }
          zeroBaseText="nothing billed in the last 3 months to this day to compare"
          title={avg.available ? `This month ${fmtAmount(data.current.mtd, unit)} · 3-month average ${fmtAmount(avg.avgMtd, unit)}` : undefined}
        />
      </div>
      {lm.available && (
        data.slowerThanUsual.count > 0 ? (
          <button
            type="button"
            onClick={() => setDrillOpen(true)}
            data-testid="billing-slower-than-usual"
            className="self-start text-left font-semibold text-amber-800 underline decoration-dotted underline-offset-2 hover:text-amber-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] rounded"
          >
            {fmtInt(data.slowerThanUsual.count)} {plural(data.slowerThanUsual.count, 'outlet', 'outlets')} billing slower than usual
            {' '}(below {data.slowerThanUsual.thresholdPct}% of their pace last month)
          </button>
        ) : (
          <p className="text-gray-500" data-testid="billing-slower-than-usual">
            No outlets billing slower than usual (below {data.slowerThanUsual.thresholdPct}% of their pace last month)
          </p>
        )
      )}
      {drillOpen && (
        <SlowerDrillDown
          filters={filters}
          monthLabel={monthLabel}
          compareDay={D}
          lastMonthDay={lm.compareDay}
          thresholdPct={data.slowerThanUsual.thresholdPct}
          managerName={managerName}
          unit={unit}
          onClose={() => setDrillOpen(false)}
        />
      )}
    </>,
  );
}

function ComparisonLine({
  testId, label, available, deltaPct, unavailableText, zeroBaseText, title,
}: {
  testId: string;
  label: string;
  available: boolean;
  deltaPct: number | null;
  unavailableText: string;
  zeroBaseText: string;
  title?: string;
}) {
  if (!available) {
    return <p className="text-gray-500" data-testid={testId}>{unavailableText}</p>;
  }
  if (deltaPct === null || deltaPct === undefined || !Number.isFinite(deltaPct)) {
    return (
      <p data-testid={testId}>
        {label}: <span className="text-gray-500">{zeroBaseText}</span>
      </p>
    );
  }
  const d = deltaText(deltaPct);
  const cls = d.dir === 'up' ? 'text-emerald-700' : d.dir === 'down' ? 'text-red-700' : 'text-gray-700';
  return (
    <p data-testid={testId} title={title}>
      {label}:{' '}
      <span className={`font-semibold whitespace-nowrap ${cls}`} data-dir={d.dir} data-testid={`${testId}-delta`}>
        <span aria-hidden="true">{d.arrow ? `${d.arrow} ` : ''}{d.text}</span>
        <span className="sr-only">{d.words}</span>
      </span>
    </p>
  );
}

/* ─── Drill-down ───────────────────────────────────────────────────────────── */

function SlowerDrillDown({
  filters, monthLabel, compareDay, lastMonthDay, thresholdPct, managerName, unit, onClose,
}: {
  filters: Filters;
  monthLabel: string;
  compareDay: number | null;
  lastMonthDay: number | null;
  thresholdPct: number;
  managerName: string | null;
  unit: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<SlowerPage | null>(null);
  const [known, setKnown] = useState<{ total: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const exportAction = useDownloadAction();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${BILLING_SLOWER_URL}?${filterQuery(filters, { page, pageSize: BILLING_SLOWER_PAGE_SIZE })}`, { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        const payload = unwrap<SlowerPage>(await r.json());
        if (!payload || !Array.isArray(payload.rows)) throw new Error('Empty or malformed response');
        if (cancelled) return;
        setResult(payload);
        setKnown({ total: payload.total, pageSize: payload.pageSize || BILLING_SLOWER_PAGE_SIZE });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult(null);
          setError(err instanceof Error && err.message ? err.message : 'Failed to load outlets');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters, page, attempt]);

  const total = known?.total ?? 0;
  const pageSize = known?.pageSize ?? BILLING_SLOWER_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const shownPage = result?.page ?? page;
  const shownSize = result?.pageSize || pageSize;
  const from = !result || result.total === 0 ? 0 : (shownPage - 1) * shownSize + 1;
  const to = result ? Math.min(result.total, shownPage * shownSize) : 0;

  const runExport = exportAction.run;
  const handleExport = useCallback(() => {
    void runExport(`${BILLING_SLOWER_EXPORT_URL}?${filterQuery(filters)}`, {
      fallbackFileName: `billing-slower-than-usual-${filters.month}.xlsx`,
      init: { headers: { ...authHeader() } },
    });
  }, [filters, runExport]);

  const bits = [monthLabel];
  if (filters.program) bits.push(`Program: ${filters.program}`);
  if (filters.outletType) bits.push(`Outlet type: ${filters.outletType}`);
  if (filters.managerId) bits.push(`Manager: ${managerName ?? 'selected manager'} (and team)`);
  bits.push(`Below ${thresholdPct}% of their own billing last month to the same day`);

  const u = unitHeader(unit);
  const wide = 'hidden sm:table-cell';
  const th = 'font-semibold px-3 py-2';

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Billing slower than usual — ${monthLabel}`}
      description={bits.join(' · ')}
      className="max-w-[calc(100vw-1rem)] sm:max-w-4xl p-4 sm:p-6"
    >
      <div className="space-y-3" data-testid="billing-slower-drilldown">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {error ? (
            <span />
          ) : (
            <p className="text-xs text-gray-500" data-testid="billing-slower-count">
              {loading && !result
                ? 'Loading outlets…'
                : `Showing ${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(result?.total ?? total)} ${plural(result?.total ?? total, 'outlet', 'outlets')}`}
            </p>
          )}
          <button
            type="button"
            onClick={handleExport}
            disabled={exportAction.blocked}
            data-testid="billing-slower-download"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            {exportAction.busy ? <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Download className="h-3 w-3" aria-hidden="true" />}
            {downloadButtonLabel(exportAction, 'Download Excel')}
          </button>
        </div>
        <DownloadActionStatus action={exportAction} />

        {error ? (
          <div role="alert" data-testid="billing-slower-error" className="flex flex-wrap items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-xs text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">Couldn&apos;t load the outlet list — {error}</span>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              disabled={loading}
              data-testid="billing-slower-retry"
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
                  <th scope="col" className={`text-right ${th} whitespace-nowrap`}>% of last month</th>
                  <th scope="col" className={`text-right ${th} whitespace-nowrap`}>This month{compareDay ? ` (to day ${compareDay})` : ''}{u}</th>
                  <th scope="col" className={`text-right ${th} whitespace-nowrap`}>Last month{lastMonthDay ? ` (to day ${lastMonthDay})` : ''}{u}</th>
                  <th scope="col" className={`text-left ${th}`}>SO</th>
                  <th scope="col" className={`text-left ${th} ${wide}`}>ASM</th>
                  <th scope="col" className={`text-left ${th} ${wide}`}>Program</th>
                </tr>
              </thead>
              <tbody>
                {loading && !result && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">Loading…</td></tr>
                )}
                {result && result.rows.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">No outlets in this list.</td></tr>
                )}
                {result?.rows.map((r) => (
                  <tr key={r.outletCode} className="border-t border-gray-50">
                    <td className="px-3 py-2 min-w-[8rem] sm:min-w-[10rem]">
                      <span className="font-medium text-gray-800">{r.outletName}</span>
                      <span className="block text-[10px] text-gray-400">{r.outletCode}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">{`${r.ratioPct.toFixed(1)}%`}</td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-800 whitespace-nowrap">{fmtExact(r.currentMtd, unit)}</td>
                    <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">{fmtExact(r.lastMonthMtd, unit)}</td>
                    <td className="px-3 py-2 text-gray-600">{r.soName ?? '—'}</td>
                    <td className={`px-3 py-2 text-gray-600 ${wide}`}>{r.asmName ?? '—'}</td>
                    <td className={`px-3 py-2 text-gray-600 ${wide}`}>{r.program ?? '—'}</td>
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
              data-testid="billing-slower-prev"
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs disabled:opacity-50"
            >
              <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> Previous
            </button>
            <span className="text-xs text-gray-500">Page {shownPage} of {pages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={loading || page >= pages}
              data-testid="billing-slower-next"
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

export default BillingComparison;
