'use client';

/**
 * Points Engine — COMPUTE → PREVIEW → EXPORT / COMMIT screen (Wave 3).
 *
 * The credits-upload analog (design §14.4): a stepper SELECT → PREVIEW → ACT.
 *  - SELECT: period month-picker + optional program / KPI filters → POST /preview.
 *  - PREVIEW: engineDisabled banner, 4 summary cards + total points, rule versions used,
 *    then ERROR → SKIP → NO_RULE → OK row groups (first ~25 each + "+N more").
 *  - ACT (operator chooses — §12 #6, BOTH shown): EXPORT the credit-upload file + review
 *    report; and — only when the preview has OK rows AND the engine is on — CREDIT IN PORTAL
 *    (POST /commit → a PENDING batch confirmed in Credits & Payouts, the money gate). The
 *    backend additionally gates directCreditEnabled and 403s otherwise; that message is shown.
 *
 * Reads only the scaffolded api module; ApiResponse unwrapped on every call. No new deps.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Coins,
  Download,
  FileSpreadsheet,
  Info,
  Loader2,
  Play,
  RotateCcw,
  Wallet,
  XCircle,
} from 'lucide-react';
import {
  commitCompute,
  downloadExport,
  downloadPayoutReport,
  downloadPreviewReport,
  previewCompute,
} from '@/lib/points-engine/api';
import type {
  ComputeCommitResult,
  ComputePreview,
  ComputePreviewRow,
  PreviewRowStatus,
} from '@/lib/points-engine/types';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useGifsySettings } from '@/lib/gifsy-settings';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ROWS_PER_GROUP = 25;

function getPreviousMonth(): string {
  const now = new Date();
  const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const m = now.getMonth() === 0 ? 12 : now.getMonth();
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  if (!y || !m) return yyyyMm;
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

function num(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-IN');
}

type Step = 'select' | 'preview' | 'act';

interface AppliedFilter {
  period: string;
  program?: string | null;
  kpiCode?: string | null;
}

// ─── Row groups ───────────────────────────────────────────────────────────────

const GROUP_STYLES: Record<
  Exclude<PreviewRowStatus, 'OK'>,
  { card: string; head: string; title: string; detail: string; label: string }
> = {
  ERROR: {
    card: 'border-red-200',
    head: 'bg-red-50 border-red-100 text-red-800',
    title: 'text-gray-800',
    detail: 'text-red-600',
    label: 'Errors',
  },
  SKIP: {
    card: 'border-amber-200',
    head: 'bg-amber-50 border-amber-100 text-amber-800',
    title: 'text-gray-800',
    detail: 'text-amber-700',
    label: 'Skipped',
  },
  NO_RULE: {
    card: 'border-gray-200',
    head: 'bg-gray-50 border-gray-100 text-gray-600',
    title: 'text-gray-800',
    detail: 'text-gray-500',
    label: 'No rule',
  },
};

/** ERROR / SKIP / NO_RULE non-OK groups rendered as a reasoned panel list. */
function NonOkGroup({ status, rows }: { status: Exclude<PreviewRowStatus, 'OK'>; rows: ComputePreviewRow[] }) {
  if (rows.length === 0) return null;
  const s = GROUP_STYLES[status];
  const shown = rows.slice(0, ROWS_PER_GROUP);
  return (
    <div className={`overflow-hidden rounded-xl border bg-white ${s.card}`} data-testid={`group-${status}`}>
      <div className={`flex items-center gap-2 border-b px-4 py-3 ${s.head}`}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <p className="text-xs font-semibold">
          {rows.length.toLocaleString('en-IN')} {s.label.toLowerCase()} row{rows.length !== 1 ? 's' : ''}
        </p>
      </div>
      <div className="max-h-72 divide-y divide-gray-100 overflow-y-auto">
        {shown.map((r, i) => (
          <div key={`${r.outletCode}-${r.kpiCode}-${i}`} className="px-4 py-2.5">
            <p className={`text-xs font-medium ${s.title}`}>
              <span className="font-semibold text-gray-900">{r.outletCode}</span>
              {r.outletName && <span className="text-gray-400"> · {r.outletName}</span>}
              {' · '}
              <span className="font-mono text-gray-500">{r.kpiCode}</span>
              {(r.achievement != null || r.target != null) && (
                <span className="ml-1 text-gray-400">
                  ({num(r.achievement)} / {num(r.target)})
                </span>
              )}
            </p>
            {(r.reason || r.explanation) && (
              <p className={`mt-0.5 text-xs ${s.detail}`}>• {r.reason ?? r.explanation}</p>
            )}
          </div>
        ))}
      </div>
      {rows.length > shown.length && (
        <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-400">
          …and {(rows.length - shown.length).toLocaleString('en-IN')} more — download the review report for the full list.
        </p>
      )}
    </div>
  );
}

/** OK rows rendered as a normal table. */
function OkGroup({ rows, engineDisabled }: { rows: ComputePreviewRow[]; engineDisabled: boolean }) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, ROWS_PER_GROUP);
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white" data-testid="group-OK">
      <div className="flex items-center gap-2 border-b border-emerald-100 bg-emerald-50 px-4 py-3 text-emerald-800">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <p className="text-xs font-semibold">
          {rows.length.toLocaleString('en-IN')} row{rows.length !== 1 ? 's' : ''} to credit
        </p>
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="sticky top-0 bg-gray-50 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              <th className="px-4 py-2.5">Outlet</th>
              <th className="px-2 py-2.5">KPI</th>
              <th className="px-2 py-2.5 text-right">Achievement</th>
              <th className="px-2 py-2.5 text-right">Target</th>
              <th className="px-2 py-2.5 text-right">Points</th>
              <th className="px-4 py-2.5">Explanation</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={`${r.outletCode}-${r.kpiCode}-${i}`} className="border-b border-gray-50 text-sm">
                <td className="px-4 py-2.5">
                  <span className="font-medium text-gray-900">{r.outletCode}</span>
                  {r.outletName && <span className="block text-xs text-gray-400">{r.outletName}</span>}
                </td>
                <td className="px-2 py-2.5 font-mono text-xs text-gray-500">{r.kpiCode}</td>
                <td className="px-2 py-2.5 text-right text-gray-700">{num(r.achievement)}</td>
                <td className="px-2 py-2.5 text-right text-gray-700">{num(r.target)}</td>
                <td className="px-2 py-2.5 text-right font-semibold text-gray-900">{num(r.points)}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500">{r.explanation ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-400">
          Showing the first {shown.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} —
          download the {engineDisabled ? 'review report' : 'credit-upload file or review report'} for all rows.
        </p>
      )}
    </div>
  );
}

/** OK PAYOUT rows rendered as a normal table — the "rows to pay out" report (indigo to parallel the emerald Ok group). */
function PayoutOkGroup({ rows }: { rows: ComputePreviewRow[] }) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, ROWS_PER_GROUP);
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white" data-testid="group-PAYOUT">
      <div className="flex items-center gap-2 border-b border-indigo-100 bg-indigo-50 px-4 py-3 text-indigo-800">
        <Wallet className="h-3.5 w-3.5 shrink-0" />
        <p className="text-xs font-semibold">
          {rows.length.toLocaleString('en-IN')} row{rows.length !== 1 ? 's' : ''} to pay out
        </p>
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="sticky top-0 bg-gray-50 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              <th className="px-4 py-2.5">Outlet</th>
              <th className="px-2 py-2.5">KPI</th>
              <th className="px-2 py-2.5 text-right">Achievement</th>
              <th className="px-2 py-2.5 text-right">Target</th>
              <th className="px-2 py-2.5 text-right">Payout (₹)</th>
              <th className="px-4 py-2.5">Explanation</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={`${r.outletCode}-${r.kpiCode}-${i}`} className="border-b border-gray-50 text-sm">
                <td className="px-4 py-2.5">
                  <span className="font-medium text-gray-900">{r.outletCode}</span>
                  {r.outletName && <span className="block text-xs text-gray-400">{r.outletName}</span>}
                </td>
                <td className="px-2 py-2.5 font-mono text-xs text-gray-500">{r.kpiCode}</td>
                <td className="px-2 py-2.5 text-right text-gray-700">{num(r.achievement)}</td>
                <td className="px-2 py-2.5 text-right text-gray-700">{num(r.target)}</td>
                <td className="px-2 py-2.5 text-right font-semibold text-indigo-700">₹{num(r.payoutRupees)}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500">{r.explanation ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-400">
          Showing the first {shown.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} —
          download the payout report for all rows.
        </p>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────────

export default function PointsComputePage() {
  const [step, setStep] = useState<Step>('select');

  // SELECT inputs
  const [period, setPeriod] = useState<string>(getPreviousMonth());
  const [program, setProgram] = useState('');
  const [kpiCode, setKpiCode] = useState('');

  // ── Filter dropdown options (searchable) — same sources the rule builder's Attachment uses, so the
  //    operator picks from the tenant's real configured programs / KPI catalogue instead of free-typing
  //    (a typo like `unnati` ≠ `Unnati` silently matched nothing before). Blank = no filter (unchanged). ──
  const settings = useGifsySettings();
  const programOptions = settings.outletPrograms ?? [];
  const [kpiCodes, setKpiCodes] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/admin/kpis');
        const json = await res.json();
        if (!cancelled && json?.success && Array.isArray(json.data)) {
          setKpiCodes(
            (json.data as Array<{ code: string; enabled?: boolean }>)
              .filter((k) => k.enabled !== false)
              .map((k) => k.code),
          );
        }
      } catch {
        /* leave empty — the KPI filter falls back to "no options" (operator can clear to run all) */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // PREVIEW
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ComputePreview | null>(null);
  const [applied, setApplied] = useState<AppliedFilter | null>(null);
  // The previewed run's content hash — passed back as `expectedKey` on commit so a run that changed since
  // the preview (achievements/targets/rules edited) is rejected with a 409 instead of crediting stale data.
  const [appliedSourceKey, setAppliedSourceKey] = useState<string | null>(null);

  // EXPORT
  const [exportingFile, setExportingFile] = useState(false);
  const [exportingReport, setExportingReport] = useState(false);
  const [exportingPayout, setExportingPayout] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // COMMIT (direct credit)
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<ComputeCommitResult | null>(null);

  const runPreview = async () => {
    if (!period || previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    setCommitResult(null);
    setCommitError(null);
    setExportMsg(null);
    setExportError(null);

    const filter: AppliedFilter = {
      period,
      program: program.trim() || null,
      kpiCode: kpiCode.trim() || null,
    };
    const res = await previewCompute(filter);
    if (res.success) {
      setPreview(res.data);
      setApplied(filter);
      setAppliedSourceKey(res.data.sourceKey);
      setStep('preview');
    } else {
      setPreviewError(res.error ?? 'Failed to run the preview');
    }
    setPreviewing(false);
  };

  const handleExport = async () => {
    if (!applied || exportingFile) return;
    setExportingFile(true);
    setExportMsg(null);
    setExportError(null);
    const err = await downloadExport(applied);
    if (err) setExportError(err);
    else setExportMsg('Credit-upload file downloaded.');
    setExportingFile(false);
  };

  const handleReport = async () => {
    if (!applied || exportingReport) return;
    setExportingReport(true);
    setExportMsg(null);
    setExportError(null);
    const err = await downloadPreviewReport(applied);
    if (err) setExportError(err);
    else setExportMsg('Review report downloaded.');
    setExportingReport(false);
  };

  const handlePayoutReport = async () => {
    if (!applied || exportingPayout) return;
    setExportingPayout(true);
    setExportMsg(null);
    setExportError(null);
    const err = await downloadPayoutReport(applied);
    if (err) setExportError(err);
    else setExportMsg('Payout report downloaded.');
    setExportingPayout(false);
  };

  const handleCommit = async () => {
    if (!applied || committing) return;
    setCommitting(true);
    setCommitError(null);
    // Pass the previewed run's sourceKey as expectedKey — the backend rejects the commit with a 409 if the
    // computation changed since this preview, and that message surfaces in the commit-error banner below.
    const res = await commitCompute({
      period: applied.period,
      program: applied.program,
      kpiCode: applied.kpiCode,
      expectedKey: appliedSourceKey,
    });
    if (res.success) {
      setCommitResult(res.data);
      setStep('act');
    } else {
      setCommitError(res.error ?? 'Failed to credit the computed points');
    }
    setCommitting(false);
  };

  const startOver = () => {
    setStep('select');
    setPreview(null);
    setApplied(null);
    setAppliedSourceKey(null);
    setPreviewError(null);
    setExportMsg(null);
    setExportError(null);
    setCommitResult(null);
    setCommitError(null);
  };

  // ─── Derived ──────────────────────────────────────────────────────────────
  const errorRows = preview?.rows.filter((r) => r.status === 'ERROR') ?? [];
  const skipRows = preview?.rows.filter((r) => r.status === 'SKIP') ?? [];
  const noRuleRows = preview?.rows.filter((r) => r.status === 'NO_RULE') ?? [];
  const okRows = preview?.rows.filter((r) => r.status === 'OK') ?? [];
  // OK rows split by award type: POINTS rows credit/export; PAYOUT rows are reporting-only (whole-INR).
  const pointsOkRows = okRows.filter((r) => r.awardType !== 'PAYOUT');
  const payoutOkRows = okRows.filter((r) => r.awardType === 'PAYOUT');
  const hasPointsOkRows = pointsOkRows.length > 0;
  const hasPayoutRows = payoutOkRows.length > 0;
  // Direct credit is offered only when the engine is on AND Gifsy has enabled in-portal crediting AND
  // there are POINTS rows to credit — known from the preview BEFORE the click (the backend still enforces it).
  const canDirectCredit = !!preview && !preview.engineDisabled && preview.directCreditEnabled && hasPointsOkRows;
  // Engine on + POINTS OK rows but Gifsy hasn't turned on in-portal crediting → explain, point to Export.
  const directCreditOffByGifsy = !!preview && !preview.engineDisabled && !preview.directCreditEnabled && hasPointsOkRows;
  // The SELECT inputs stay editable; if they drift from the previewed snapshot, block Export/Credit (which
  // act on `applied`) so a visible selection can never contradict what gets exported/credited (money safety).
  const filtersChanged =
    !!applied &&
    (period !== applied.period ||
      (program.trim() || null) !== (applied.program ?? null) ||
      (kpiCode.trim() || null) !== (applied.kpiCode ?? null));

  // ─── Stepper ──────────────────────────────────────────────────────────────
  const stepOrder: Step[] = ['select', 'preview', 'act'];
  const stepIdx = stepOrder.indexOf(step);
  const stepLabel = (s: Step, n: number, title: string) => {
    const idx = stepOrder.indexOf(s);
    const active = step === s;
    const done = idx < stepIdx;
    return (
      <div
        className={`flex items-center gap-2 ${
          active ? 'text-[var(--brand-primary)]' : done ? 'text-emerald-600' : 'text-gray-400'
        }`}
      >
        <div
          className={`flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-bold ${
            active
              ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
              : 'border-current bg-transparent'
          }`}
        >
          {n}
        </div>
        <span className="hidden text-sm font-medium sm:block">{title}</span>
        {n < 3 && <ChevronRight className="hidden h-3.5 w-3.5 text-gray-300 sm:block" />}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Coins className="h-5 w-5 text-[var(--brand-primary)]" />
        <div>
          <h1 className="text-lg font-bold text-gray-900">Compute Points</h1>
          <p className="text-xs text-gray-500">
            Calculate points from your published rules, preview every outlet, then export a credit-upload file or
            credit directly in-portal.
          </p>
        </div>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-5 py-3">
        {stepLabel('select', 1, 'Select period')}
        {stepLabel('preview', 2, 'Preview')}
        {stepLabel('act', 3, 'Export / Credit')}
      </div>

      {/* ─── SELECT ─────────────────────────────────────────────────────────── */}
      <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">Step 1 — Choose what to compute</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="pe-period" className="mb-1 block text-xs font-semibold text-gray-500">
              Period *
            </label>
            <input
              id="pe-period"
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-500">
              Program <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <SearchableSelect
              value={program}
              options={programOptions}
              placeholder="(any)"
              aria-label="Program"
              testIdPrefix="pe-program"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
              onChange={setProgram}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-500">
              KPI code <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <SearchableSelect
              value={kpiCode}
              options={kpiCodes}
              placeholder="(any)"
              aria-label="KPI code"
              testIdPrefix="pe-kpi"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"
              onChange={setKpiCode}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void runPreview()}
            disabled={!period || previewing}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {previewing ? 'Running preview…' : 'Run preview'}
          </button>
          {period && <span className="text-xs text-gray-400">Period: {monthLabel(period)}</span>}
        </div>

        {previewError && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-800">Couldn&apos;t run the preview</p>
              <p className="mt-0.5 text-xs text-red-700">{previewError}</p>
              <button
                onClick={() => void runPreview()}
                className="mt-2 text-xs font-semibold text-red-800 underline"
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── PREVIEW ────────────────────────────────────────────────────────── */}
      {preview && applied && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">
            Step 2 — Preview for {monthLabel(applied.period)}
          </h2>

          {preview.engineDisabled && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4" data-testid="engine-disabled">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div>
                <p className="text-sm font-semibold text-amber-800">The points engine is disabled for this tenant</p>
                <p className="mt-0.5 text-xs text-amber-700">
                  You can review the computed preview and download the review report, but the credit-upload file
                  and in-portal crediting are unavailable until Gifsy enables the engine.
                </p>
              </div>
            </div>
          )}

          {/* Summary cards */}
          {(() => {
            const showPayoutCard = hasPayoutRows || preview.totalPayoutRupees > 0;
            const cards: { label: string; value: string; color: string }[] = [
              { label: 'OK', value: preview.counts.ok.toLocaleString('en-IN'), color: 'text-emerald-600' },
              { label: 'Skipped', value: preview.counts.skip.toLocaleString('en-IN'), color: 'text-amber-600' },
              { label: 'Errors', value: preview.counts.error.toLocaleString('en-IN'), color: 'text-red-600' },
              { label: 'No rule', value: preview.counts.noRule.toLocaleString('en-IN'), color: 'text-gray-500' },
              { label: 'Total points', value: preview.totalPoints.toLocaleString('en-IN'), color: 'text-[var(--brand-primary)]' },
            ];
            if (showPayoutCard) {
              cards.push({
                label: 'Total payout',
                value: `₹${preview.totalPayoutRupees.toLocaleString('en-IN')}`,
                color: 'text-indigo-600',
              });
            }
            return (
              <div className={`grid grid-cols-2 gap-3 ${showPayoutCard ? 'sm:grid-cols-6' : 'sm:grid-cols-5'}`}>
                {cards.map((c) => (
                  <div key={c.label} className="rounded-xl border border-gray-200 bg-white p-3 text-center">
                    <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
                    <p className="mt-0.5 text-xs text-gray-500">{c.label}</p>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Rule versions used */}
          {preview.ruleVersionsUsed.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-gray-500">Rule versions used:</span>
              {preview.ruleVersionsUsed.map((rv) => (
                <span
                  key={`${rv.ruleId}@${rv.version}`}
                  className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-600"
                >
                  {rv.ruleId}@{rv.version}
                </span>
              ))}
            </div>
          )}

          {preview.counts.total === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-gray-200 bg-white py-16 text-center">
              <FileSpreadsheet className="h-10 w-10 text-gray-200" />
              <p className="text-sm font-semibold text-gray-400">Nothing to compute for this selection.</p>
              <p className="text-xs text-gray-300">
                No outlet/KPI rows matched {monthLabel(applied.period)}
                {applied.program ? ` · ${applied.program}` : ''}
                {applied.kpiCode ? ` · ${applied.kpiCode}` : ''}.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* ERROR → SKIP → NO_RULE → OK */}
              <NonOkGroup status="ERROR" rows={errorRows} />
              <NonOkGroup status="SKIP" rows={skipRows} />
              <NonOkGroup status="NO_RULE" rows={noRuleRows} />
              <OkGroup rows={pointsOkRows} engineDisabled={preview.engineDisabled} />
              {hasPayoutRows && <PayoutOkGroup rows={payoutOkRows} />}
            </div>
          )}

          {/* ─── ACT ──────────────────────────────────────────────────────────── */}
          <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-gray-900">Step 3 — Export or credit</h2>

            {filtersChanged && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  You changed the selection since this preview. Run the preview again to export or credit the new
                  selection — the actions below still apply to the previewed one.
                </span>
              </div>
            )}

            {/* Export */}
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                Download the computed points for the offline client-approval flow, then re-upload via Credits &amp;
                Payouts.
              </p>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() => void handleExport()}
                  disabled={exportingFile || preview.engineDisabled || !hasPointsOkRows || filtersChanged}
                  title={
                    preview.engineDisabled
                      ? 'Unavailable while the engine is disabled'
                      : !hasPointsOkRows
                        ? 'No points rows to credit in this preview'
                        : undefined
                  }
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {exportingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Download credit-upload file
                </button>
                <button
                  onClick={() => void handleReport()}
                  disabled={exportingReport || filtersChanged}
                  className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
                >
                  {exportingReport ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                  Download review report
                </button>
                {hasPayoutRows && (
                  <button
                    onClick={() => void handlePayoutReport()}
                    disabled={exportingPayout || filtersChanged}
                    className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
                  >
                    {exportingPayout ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                    Download payout report
                  </button>
                )}
              </div>
              {hasPayoutRows && (
                <p className="text-xs text-gray-500">
                  Payout is computed for reporting only — share it with the client for approval, then upload the
                  final payment status through your existing payout flow. The engine never pays out.
                </p>
              )}
              {exportMsg && (
                <p className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {exportMsg}
                </p>
              )}
              {exportError && (
                <p className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
                  <AlertTriangle className="h-3.5 w-3.5" /> {exportError}
                </p>
              )}
            </div>

            {/* Direct credit */}
            {canDirectCredit && !commitResult && (
              <div className="space-y-3 border-t border-gray-100 pt-4">
                <div className="flex items-start gap-2">
                  <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-[var(--brand-primary)]" />
                  <p className="text-xs text-gray-500">
                    Or credit the {pointsOkRows.length.toLocaleString('en-IN')} OK points row
                    {pointsOkRows.length !== 1 ? 's' : ''} directly. This creates a <strong>pending</strong> batch
                    you then review &amp; confirm in Credits &amp; Payouts — wallets are only credited there.
                  </p>
                </div>
                <button
                  onClick={() => void handleCommit()}
                  disabled={committing || filtersChanged}
                  className="inline-flex items-center gap-2 rounded-xl border-2 border-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--brand-primary)] transition hover:bg-[var(--brand-primary)]/5 disabled:opacity-40"
                >
                  {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                  {committing ? 'Creating batch…' : 'Credit in portal'}
                </button>
                {commitError && (
                  <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
                    <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                    <div>
                      <p className="text-sm font-semibold text-red-800">Couldn&apos;t credit in portal</p>
                      <p className="mt-0.5 text-xs text-red-700">{commitError}</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Direct credit offered by the engine but not turned on by Gifsy for this tenant */}
            {directCreditOffByGifsy && !commitResult && (
              <div className="flex items-start gap-2 border-t border-gray-100 pt-4 text-xs text-gray-500">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <span>
                  In-portal direct crediting isn&apos;t enabled for this tenant. Use the credit-upload file above for
                  the offline approval flow, or ask Gifsy to enable direct crediting.
                </span>
              </div>
            )}

            {/* Commit result */}
            {commitResult && (
              <div className="space-y-3 border-t border-gray-100 pt-4" data-testid="commit-result">
                <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-emerald-900">
                      {commitResult.idempotentHit ? 'Batch already existed' : 'Pending batch created'}
                    </p>
                    <p className="mt-0.5 text-xs text-emerald-800">
                      Batch{' '}
                      <code className="rounded bg-white/70 px-1 font-mono">{commitResult.batchCode}</code> ·{' '}
                      <span className="font-semibold">{commitResult.status}</span> ·{' '}
                      {commitResult.totalPoints.toLocaleString('en-IN')} pts ·{' '}
                      {commitResult.totalOutlets.toLocaleString('en-IN')} outlet
                      {commitResult.totalOutlets !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>

                {commitResult.priorBatchesThisPeriod > 0 && (
                  <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      There {commitResult.priorBatchesThisPeriod === 1 ? 'is' : 'are'} already{' '}
                      {commitResult.priorBatchesThisPeriod} credit batch
                      {commitResult.priorBatchesThisPeriod !== 1 ? 'es' : ''} for this period (review before
                      confirming to avoid double-crediting).
                    </span>
                  </div>
                )}

                <Link
                  href="/admin/credits-payouts/status"
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
                >
                  Review &amp; confirm this batch in Credits &amp; Payouts
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <p className="flex items-start gap-1.5 text-xs text-gray-500">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                  Confirming is the actual wallet credit and happens in Credits &amp; Payouts, not here.
                </p>
              </div>
            )}
          </div>

          {/* Start over */}
          <div className="flex justify-center pt-1">
            <button
              onClick={startOver}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-4 py-2 text-sm text-gray-700 transition hover:bg-gray-50"
            >
              <RotateCcw className="h-4 w-4" />
              Start over
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
