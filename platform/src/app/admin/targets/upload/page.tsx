'use client';

/**
 * Admin Target Upload page — FE-A (Targets / Stream T).
 *
 * Data source:
 *   Server-side xlsx (the client-side parsing path is REMOVED — backend parses now):
 *     Template download: GET /api/admin/targets/template?months=YYYY-MM,YYYY-MM
 *                        → RAW xlsx binary (NOT JSON-wrapped) → browser download
 *     Upload = PREVIEW then CONFIRM (owner decision 2026-11-25, approved for ALL clients incl. Deoleo — the API
 *     refuses an upload without a preview):
 *       1. POST /api/admin/targets/upload?preview=1 (FormData "file") → validates, writes NOTHING →
 *          { preview: true, previewToken, previewExpiresAt, willSaveCount, newCount, overwriteCount, perMonth,
 *            overwriteExamples, notApplied[{category,count,fingerprint,sample}], + summary / rows / focusCheck }
 *       2. "Confirm & apply" → POST /api/admin/targets/upload?confirmToken=<previewToken>&ack=CAT:count:fingerprint,…
 *          with the SAME file bytes (kept in memory from step 1) → { batchId, status: 'APPLIED', savedCount, … }.
 *          The whole file is saved in ONE transaction (all or nothing). Refusals: 412 (what is not applied changed)
 *          and 410 (preview expired) → the page re-checks the same bytes and re-shows the boxes; 409 (already applied /
 *          different file) → the preview is closed; 500 / 503 (nothing saved) → Confirm can be retried.
 *       "Cancel" discards the preview; nothing was written.
 *
 * The client-side xlsx parsing path is REMOVED. The backend parses now.
 * UI shell / styling is preserved; only the data layer changes.
 */

import { useState, useRef, useEffect } from 'react';
import {
  Upload, Download, ChevronDown, ChevronUp,
  CheckCircle2, FileSpreadsheet,
  AlertTriangle, Info,
} from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import {
  readJsonSafe, responseErrorMessage, networkErrorMessage, MAYBE_SAVED_NOTE, NOTHING_SAVED_NOTE,
} from '@/lib/safe-response';
import { buildMonthRange, formatMonth } from '@/lib/targets';
import { formatISTDateTime } from '@/lib/ist-date';
import DownloadErrorReportButton from '@/components/admin/DownloadErrorReportButton';
import { IgnoredOutOfScopeNotice } from '@/components/admin/ignored-out-of-scope-notice';
import { TargetFocusCheckNotice } from '@/components/admin/target-focus-check-notice';
import type { TargetUploadFocusCheck } from '@/lib/sales-import/types';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';
import { UploadTruncationNote, TRUNCATION_NEXT } from '@/components/admin/UploadTruncationNote';
import { normalizeRowsEcho } from '@/lib/upload-rows-echo';
import { TargetUploadHistory } from '@/components/admin/target-upload-history';
import { TargetHistoryCard } from '@/components/admin/target-history';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single parsed row as returned by the backend */
interface UploadRow {
  rowIndex:  number;
  outletCode?: string;
  outletId?:   string;
  month?:      string;
  /** Backend RowStatus: accepted · rejected_outlet · rejected_kpi · skipped_blank. */
  status:      string;
  remarks?:    string;
  [key: string]: unknown;
}

/** Fields shared by the preview and the applied result. */
interface UploadSummaryData {
  month:         string;
  monthsInBatch: string[];
  writableMonths?:       string[];
  skippedLockedMonths?:  string[];
  totalRows:     number;
  acceptedCount: number;
  rejectedCount: number;
  /** Outlet-months created vs existing ones replaced (absent on older API builds). */
  newCount?:       number;
  /** Existing outlet-months where at least one stored value actually CHANGES (the OVERWRITE acknowledgement). */
  overwriteCount?: number;
  /** Existing outlet-months that already hold exactly these values — not rewritten, no effect, no tick. */
  unchangedCount?: number;
  perMonth?:       { month: string; newCount: number; overwriteCount: number; unchangedCount?: number }[];
  /** APPLIES-TO D1: values ignored because the KPI does not apply to that outlet (absent on older API builds). */
  ignoredOutOfScope?: number;
  /** FOCUS-FROM-TARGETS §7: early, NON-blocking check of the focus product names (absent on older API builds). */
  focusCheck?:   TargetUploadFocusCheck;
  /**
   * Memory-safety (2026-11-13): the API no longer echoes every parsed row. It returns the
   * REJECTED rows (problemRows) and the saved rows whose values were partly ignored
   * (warningRows), each capped at 500 with the true totals; blank template rows are counted.
   */
  problemRows:          UploadRow[];
  problemRowCount:      number;
  problemRowsTruncated: boolean;
  warningRows:          UploadRow[];
  warningRowCount:      number;
  warningRowsTruncated: boolean;
  skippedBlankCount?:   number;
  /** NO SILENT FAILURE: every category NOT applied as typed, present ones only (absent on older API builds). */
  notApplied?:          NotAppliedItem[];
}

type NotAppliedCategory = 'REJECTED_ROWS' | 'OVERWRITE' | 'LOCKED_MONTHS' | 'BLANK_ROWS' | 'IGNORED_VALUES';
interface NotAppliedItem {
  category: NotAppliedCategory;
  count: number;
  /** Binds the tick to exactly these items — sent back on Confirm; the server refuses (412) if they changed. */
  fingerprint?: string;
  /** A few of the items ("Row 7 — OUT123", "OUT123 · 2026-12"). */
  sample?: string[];
}

/** The `ack` query value: each ticked category with the count + fingerprint it was shown with. */
function ackParam(items: NotAppliedItem[], ticked: Set<NotAppliedCategory>): string {
  return items
    .filter(c => ticked.has(c.category))
    .map(c => `${c.category}:${c.count}:${c.fingerprint ?? ''}`)
    .join(',');
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** The required "I understand…" line per category (preview), and the plain done-screen line (applied). */
const NOT_APPLIED_COPY: Record<NotAppliedCategory, { ack: (n: number) => string; done: (n: number) => string }> = {
  REJECTED_ROWS: {
    ack:  n => `I understand ${plural(n, 'rejected row', 'rejected rows')} will not be saved`,
    done: n => `${plural(n, 'rejected row was', 'rejected rows were')} not saved`,
  },
  OVERWRITE: {
    ack:  n => `I understand ${plural(n, 'existing outlet-month target', 'existing outlet-month targets')} will be replaced`,
    done: n => `${plural(n, 'existing outlet-month target was', 'existing outlet-month targets were')} replaced`,
  },
  LOCKED_MONTHS: {
    ack:  n => `I understand ${plural(n, 'outlet-month target', 'outlet-month targets')} in past (locked) months will not be saved`,
    done: n => `${plural(n, 'outlet-month target', 'outlet-month targets')} in past (locked) months not saved`,
  },
  BLANK_ROWS: {
    ack:  n => `I understand ${plural(n, 'blank row', 'blank rows')} will not be saved`,
    done: n => `${plural(n, 'blank row was', 'blank rows were')} not saved`,
  },
  IGNORED_VALUES: {
    ack:  n => `I understand ${plural(n, 'value', 'values')} for KPIs that don't apply to the outlet will be ignored`,
    done: n => `${plural(n, 'value was', 'values were')} ignored (KPI doesn't apply to the outlet)`,
  },
};

/** Step 1 — the preview (nothing written). */
interface PreviewResult extends UploadSummaryData {
  preview:       true;
  previewToken:  string;
  /** ISO time after which the preview can no longer be confirmed (absent on older API builds). */
  previewExpiresAt?: string;
  /** Outlet-months the apply would write if confirmed now (new + changed; unchanged ones are not rewritten). */
  willSaveCount: number;
  /** A few unchanged outlet-months ("OUT123 · 2026-12"). */
  unchangedSample?: string[];
  /** Of the unchanged ones: whose stored outlet name is refreshed from the file (target values untouched). */
  outletNameUpdatedCount?: number;
  overwriteExamples?: {
    outletCode: string;
    outletName: string;
    month:      string;
    changes:    { kpiCode: string; label: string; from: unknown; to: unknown }[];
  }[];
  overwriteExamplesSampled?: number;
}

/** Step 2 — what was applied. */
interface UploadResult extends UploadSummaryData {
  batchId:       string;
  /** Ground truth: outlet-month targets actually written to the backend this upload. */
  savedCount?:   number;
  /** Set when the targets were saved but the sales team could not be notified. */
  notificationWarning?: string;
}

type UploadResponse = (UploadResult | PreviewResult) & { rows?: UploadRow[] };

// ── Helpers ───────────────────────────────────────────────────────────────────

const isPreview = (d: UploadResponse): d is PreviewResult & { rows?: UploadRow[] } =>
  (d as PreviewResult).preview === true;

/** "12.5" / "—" for an old → new example value (null = not stored / removed). */
function exampleValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return typeof v === 'number' ? v.toLocaleString('en-IN') : String(v);
}

/** Why "Confirm & apply" is disabled, or null when there is something to apply. */
function nothingToApplyReason(p: PreviewResult): string | null {
  if (p.willSaveCount > 0) return null;
  if (p.acceptedCount === 0) {
    return 'Nothing to apply — no row in this file was accepted. Fix the rejected rows (or use the right template) and pick the file again.';
  }
  if ((p.skippedLockedMonths?.length ?? 0) > 0 && (p.writableMonths?.length ?? 0) === 0) {
    return 'Nothing to apply — every month in this file is in the past, and past months are locked.';
  }
  if ((p.unchangedCount ?? 0) > 0) {
    return 'Nothing to apply — every outlet-month in this file already has exactly these target values.';
  }
  return 'Nothing to apply — no accepted row has a value for the current or a future month.';
}

/** Blank template rows: the API count, else what is left of Total after Accepted + Rejected (older API). */
function blankRowCount(r: Pick<UploadSummaryData,'totalRows' | 'acceptedCount' | 'rejectedCount' | 'skippedBlankCount'>): number {
  return r.skippedBlankCount ?? Math.max(0, r.totalRows - r.acceptedCount - r.rejectedCount);
}


// ── Page ──────────────────────────────────────────────────────────────────────

export default function TargetUploadPage() {
  // Month range for template
  const monthOptions = buildMonthRange(12);
  // Default both ends to the CURRENT month (monthOptions[0]) — a single-month
  // template is the common case; the admin widens the range when needed.
  const [fromMonth, setFromMonth] = useState(monthOptions[0]?.value ?? '');
  const [toMonth,   setToMonth]   = useState(monthOptions[0]?.value ?? '');

  // Upload state
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const [fileName,    setFileName]    = useState('');
  /** previewing = step 1 in flight · applying = step 2 in flight. */
  const [busy,        setBusy]        = useState<'idle' | 'previewing' | 'applying'>('idle');
  const [uploadError, setUploadError] = useState('');
  const [preview,     setPreview]     = useState<PreviewResult | null>(null);
  const [result,      setResult]      = useState<UploadResult | null>(null);
  /** The preview the shown result was applied from — to say so when the final numbers differ. */
  const [appliedFrom, setAppliedFrom] = useState<PreviewResult | null>(null);
  /** The "I understand…" boxes ticked on the current preview (one required per notApplied category). */
  const [acks,        setAcks]        = useState<Set<NotAppliedCategory>>(new Set());
  /** Bumped after an apply so the Upload history reloads. */
  const [historyKey,  setHistoryKey]  = useState(0);
  /** The previewed file's BYTES (snapshotted at pick time) — confirm re-posts exactly these. */
  const pendingFileRef = useRef<File | null>(null);
  /** Synchronous double-click guard for Confirm (state updates are async). */
  const applyingRef    = useRef(false);
  /** Bumped by Cancel / a new pick so a late response from a superseded request is ignored. */
  const requestSeq     = useRef(0);

  // Template download state
  // One shared button state per download (useDownloadAction): "Preparing…", queued (202 → Downloads page,
  // button stays disabled until the message is dismissed) or a plain error under the buttons.
  const templateAction = useDownloadAction();
  const finalAction    = useDownloadAction();

  // KPI count hint (fetched once on mount)
  const [kpiCount, setKpiCount] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/admin/kpis', { headers: authHeader() })
      .then(r => r.json())
      .then((j: { success: boolean; data?: unknown[] }) => {
        if (j.success && Array.isArray(j.data)) setKpiCount(j.data.filter((k: unknown) => (k as { enabled?: boolean }).enabled).length);
      })
      .catch(() => {});
  }, []);

  // ── Month helpers ──────────────────────────────────────────────────────────

  function selectedMonths(): string[] {
    const from = monthOptions.findIndex(m => m.value === fromMonth);
    const to   = monthOptions.findIndex(m => m.value === toMonth);
    if (from < 0 || to < 0 || to < from) return [];
    return monthOptions.slice(from, to + 1).map(m => m.value);
  }

  function handleFromChange(val: string) {
    setFromMonth(val);
    const fromIdx = monthOptions.findIndex(m => m.value === val);
    const toIdx   = monthOptions.findIndex(m => m.value === toMonth);
    if (toIdx < fromIdx) setToMonth(val);
  }

  // Quarter-aware presets
  const PRESETS = (() => {
    const now  = new Date();
    const cm   = now.getMonth() + 1;
    const cy   = now.getFullYear();
    const cq   = Math.ceil(cm / 3);
    const curr = monthOptions[0]?.value ?? '';

    const tqEndM  = cq * 3;
    const tqEnd   = `${cy}-${String(tqEndM).padStart(2, '0')}`;

    const nq      = cq === 4 ? 1 : cq + 1;
    const ny      = cq === 4 ? cy + 1 : cy;
    const nqStart = `${ny}-${String((nq - 1) * 3 + 1).padStart(2, '0')}`;
    const nqEnd   = `${ny}-${String(nq * 3).padStart(2, '0')}`;

    const mo = (i: number) => monthOptions[i]?.value ?? curr;

    return [
      { label: 'This Quarter', from: curr,    to: tqEnd,  key: 'tq'  },
      { label: 'Next Quarter', from: nqStart, to: nqEnd,  key: 'nq'  },
      { label: '6 months',     from: curr,    to: mo(5),  key: '6m'  },
      { label: '12 months',    from: curr,    to: mo(11), key: '12m' },
    ];
  })();

  const activePreset = PRESETS.find(p => p.from === fromMonth && p.to === toMonth)?.key ?? null;

  const chosenMonths   = selectedMonths();
  const toOptions      = monthOptions.filter(m => m.value >= fromMonth);
  const monthSpanLabel = chosenMonths.length > 0
    ? `${monthOptions.find(m => m.value === chosenMonths[0])?.label} → ${monthOptions.find(m => m.value === chosenMonths[chosenMonths.length - 1])?.label}`
    : '—';

  // ── Template download ──────────────────────────────────────────────────────

  async function handleDownloadTemplate() {
    const months = selectedMonths();
    if (months.length === 0) return;

    const qs = months.join(',');
    // 200 → the template saves straight away; 202 (a long range) → prepared in the background
    // and shown on the Downloads page.
    await templateAction.run(`/api/admin/targets/template?months=${encodeURIComponent(qs)}`, {
      fallbackFileName: `targets_template_${months[0]}_to_${months[months.length - 1]}.xlsx`,
    });
  }

  // ── Download Final Targets (export stored targets for the From month) ───────

  async function handleDownloadFinal() {
    if (!fromMonth) return;
    await finalAction.run(`/api/admin/targets/export?month=${encodeURIComponent(fromMonth)}`, {
      fallbackFileName: `final_targets_${fromMonth}.xlsx`,
    });
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  /**
   * POST the file; `query` picks the step. null = superseded (Cancel / another file) — ignore. A failure carries the
   * HTTP status (null = network) so the caller can react to the kind of refusal.
   */
  async function postUpload(
    file: File, query: string, savedNote: string, seq: number,
  ): Promise<{ ok: true; data: UploadResponse } | { ok: false; status: number | null; error: string } | null> {
    const formData = new FormData();
    formData.append('file', file);

    let res: Response;
    try {
      res = await fetch(`/api/admin/targets/upload?${query}`, {
        method:  'POST',
        headers: authHeader(), // Do NOT add Content-Type — let the browser set multipart boundary
        body:    formData,
      });
    } catch {
      if (seq !== requestSeq.current) return null;
      return { ok: false, status: null, error: networkErrorMessage(savedNote) };
    }
    const json = await readJsonSafe<{ success: boolean; data?: UploadResponse; error?: string }>(res);
    if (seq !== requestSeq.current) return null; // superseded (Cancel / another file) — ignore
    if (!json) {
      // Non-JSON (proxy truncation / plain-text 5xx / edge 413): readable + honest, never a raw SyntaxError.
      return { ok: false, status: res.status, error: responseErrorMessage(res, json, savedNote) };
    }
    if (!res.ok || !json.success) {
      return { ok: false, status: res.status, error: json.error ?? `Upload failed (HTTP ${res.status})` };
    }
    return { ok: true, data: json.data! };
  }

  /**
   * PREVIEW `file` (already snapshotted): validates on the server, writes nothing. `notice` (a refused Confirm that
   * re-checks the file) is kept above the fresh preview so the admin sees why the boxes must be ticked again.
   */
  async function runPreview(file: File, seq: number, notice = '') {
    try {
      const out = await postUpload(file, 'preview=1', NOTHING_SAVED_NOTE, seq);
      if (!out) return;
      if (!out.ok) {
        pendingFileRef.current = null;
        setUploadError(notice ? `${notice} ${out.error}` : out.error);
        return;
      }
      const normalized = normalizeRowsEcho(out.data) as unknown as UploadResponse;
      if (isPreview(normalized)) {
        setAcks(new Set());
        setPreview(normalized);
        setUploadError(notice);
      } else {
        // An older API build ignores ?preview and APPLIES — never present that as a preview.
        pendingFileRef.current = null;
        setResult(normalized as UploadResult);
        setHistoryKey(k => k + 1);
      }
    } catch {
      // Not a network error (that is handled above) — e.g. an unexpected response shape.
      if (seq === requestSeq.current) {
        setUploadError('Something went wrong showing the upload result. Refresh and check the targets before uploading again.');
      }
    } finally {
      if (seq === requestSeq.current) setBusy('idle');
    }
  }

  // Step 1 — pick a file → PREVIEW (validates on the server, writes nothing).
  async function handleFile(picked: File) {
    const seq = ++requestSeq.current;
    setFileName(picked.name);
    setBusy('previewing');
    setUploadError('');
    setResult(null);
    setAppliedFrom(null);
    setPreview(null);
    setAcks(new Set());
    applyingRef.current = false;

    // Snapshot the bytes NOW so "Confirm & apply" posts exactly what was previewed, even if the file on disk is
    // edited in between (the server also checks the bytes against the preview token).
    let file = picked;
    if (typeof picked.arrayBuffer === 'function') {
      try {
        file = new File([await picked.arrayBuffer()], picked.name, { type: picked.type });
      } catch {
        if (seq === requestSeq.current) {
          setUploadError(`Couldn't read "${picked.name}". Close it in Excel (or pick it again) and retry. ${NOTHING_SAVED_NOTE}`);
          setBusy('idle');
        }
        return;
      }
    }
    pendingFileRef.current = file;
    await runPreview(file, seq);
  }

  // Step 2 — "Confirm & apply": re-post the SAME bytes with the preview token and the ticked boxes (each bound to the
  // count + items it was shown with). The server saves the whole file in ONE transaction (all or nothing) and refuses a
  // second apply of the same preview, so a double-click / retry can never apply twice.
  async function handleConfirm() {
    const file = pendingFileRef.current;
    if (!preview || !file || applyingRef.current) return;
    // Every not-applied category must be ticked (the button is disabled otherwise; the server re-checks → 400).
    if ((preview.notApplied ?? []).some(c => !acks.has(c.category))) return;
    applyingRef.current = true;
    const seq = ++requestSeq.current;
    setBusy('applying');
    setUploadError('');
    try {
      const out = await postUpload(
        file,
        `confirmToken=${encodeURIComponent(preview.previewToken)}&ack=${encodeURIComponent(ackParam(preview.notApplied ?? [], acks))}`,
        MAYBE_SAVED_NOTE,
        seq,
      );
      if (!out) { applyingRef.current = false; return; }
      if (!out.ok) {
        applyingRef.current = false;
        // A refused / failed attempt is recorded — show it in the history straight away.
        setHistoryKey(k => k + 1);
        if (out.status === 412 || out.status === 410) {
          // What will not be applied changed since the preview (412), or the preview expired (410): nothing was saved.
          // Check the SAME bytes again so the boxes show the up-to-date counts (unticked) and a fresh confirmation.
          const recheck = ++requestSeq.current;
          setPreview(null);
          setAcks(new Set());
          setBusy('previewing');
          await runPreview(file, recheck, `${out.error} The file has been checked again below — read the preview and tick the boxes again.`);
          return;
        }
        if (out.status === 409) {
          // Already applied, or not the previewed file: this preview is finished — never offer to apply it again.
          setPreview(null);
          pendingFileRef.current = null;
          setFileName('');
        }
        // 500 / 503 / network: nothing (or, for a lost reply, possibly everything) was saved — the preview stays and
        // Confirm & apply can be pressed again safely (an applied preview is refused, never applied twice).
        setUploadError(out.error);
        return;
      }
      const applied = normalizeRowsEcho(out.data) as unknown as UploadResult;
      setAppliedFrom(preview);
      setResult(applied);
      setHistoryKey(k => k + 1);
      setPreview(null);
      pendingFileRef.current = null;
    } catch {
      applyingRef.current = false;
      setUploadError('Something went wrong showing the upload result. Refresh and check the targets before uploading again.');
    } finally {
      if (seq === requestSeq.current) setBusy('idle');
    }
  }

  // "Cancel" — discard the preview (nothing was written).
  function handleCancel() {
    requestSeq.current++;
    pendingFileRef.current = null;
    applyingRef.current = false;
    setPreview(null);
    setResult(null);
    setAppliedFrom(null);
    setAcks(new Set());
    setUploadError('');
    setFileName('');
    setBusy('idle');
  }


  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so the same file can be re-picked
    e.target.value = '';
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const [kpiHintOpen, setKpiHintOpen] = useState(false);

  return (
    <div className="space-y-5 pb-10">

      {/* ── Section 1: KPI hint ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setKpiHintOpen(o => !o)}
          className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gray-100">
              <Info className="w-4 h-4 text-gray-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">About this page</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {kpiCount !== null
                  ? `${kpiCount} enabled KPI${kpiCount !== 1 ? 's' : ''} will appear as columns in the template`
                  : 'KPI columns are driven by the KPI catalogue'}
              </p>
            </div>
          </div>
          {kpiHintOpen
            ? <ChevronUp   className="w-4 h-4 text-gray-400" />
            : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>

        {kpiHintOpen && (
          <div className="border-t border-gray-100 px-6 py-4">
            <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-500" />
              <span>
                The Excel template is built from the tenant&apos;s enabled KPIs and active outlet roster.
                To add or change KPIs, visit{' '}
                <a href="/admin/targets" className="underline font-semibold">KPI Management</a>.
                Upload is parsed server-side — the backend validates outlet codes and KPI columns.
                Blank cells are skipped (not stored as 0).
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Section 2: Download Template ───────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-green-50">
            <FileSpreadsheet className="w-4 h-4 text-green-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Step 1 — Download Template</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Generate a blank Excel pre-filled with the outlet roster and KPI columns, then upload it below.
            </p>
          </div>
        </div>

        {/* Preset chips */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 font-semibold mr-1">Quick select:</span>
          {PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => { setFromMonth(p.from); setToMonth(p.to); }}
              className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                activePreset === p.key
                  ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* From / To / Download */}
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">From</label>
            <select
              value={fromMonth}
              onChange={e => handleFromChange(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-gray-400"
            >
              {monthOptions.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">To</label>
            <select
              value={toMonth}
              onChange={e => setToMonth(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-gray-400"
            >
              {toOptions.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleDownloadTemplate}
            disabled={chosenMonths.length === 0 || templateAction.blocked}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {templateAction.busy
              ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              : <Download className="w-4 h-4" />}
            {downloadButtonLabel(templateAction, 'Download Template')}
          </button>
          <button
            onClick={handleDownloadFinal}
            disabled={!fromMonth || finalAction.blocked}
            title="Export the stored (final) targets for the From month"
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 text-sm font-semibold rounded-xl hover:border-gray-400 disabled:opacity-40 transition-colors"
          >
            {finalAction.busy
              ? <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
              : <Download className="w-4 h-4" />}
            {downloadButtonLabel(finalAction, 'Download Final Targets')}
          </button>
        </div>

        {/* Summary line */}
        {chosenMonths.length > 0 && (
          <p className="text-xs text-gray-500">
            <span className="font-semibold text-gray-700">{monthSpanLabel}</span>
            {' '}· {chosenMonths.length} month{chosenMonths.length !== 1 ? 's' : ''}
            {kpiCount !== null && ` · ${kpiCount} KPI column${kpiCount !== 1 ? 's' : ''} per month`}
          </p>
        )}

        {/* Queued / error messages — directly below the download buttons. */}
        <DownloadActionStatus action={templateAction} />
        <DownloadActionStatus action={finalAction} />
      </div>

      {/* ── Section 3: Upload ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-50">
            <Upload className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Step 2 — Upload Filled Template</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Pick your completed Excel. It is checked first and you see a preview (new vs overwritten targets,
              rejected rows) — nothing is saved until you click <span className="font-semibold">Confirm &amp; apply</span>.
            </p>
          </div>
        </div>

        {/* Re-upload advisory: an upload REPLACES each outlet-month's stored target values with the
            columns present, and the template/export carry only currently-enabled KPIs. */}
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Uploading <strong>replaces</strong> each outlet&rsquo;s target values for the month with the
            columns in this file. The template and the Final Targets export include only
            <strong> currently-enabled KPIs</strong> — if a KPI was disabled after targets were uploaded,
            re-uploading removes its stored targets for that month.
          </span>
        </div>

        {/* Drop zone — picking a file only PREVIEWS it; nothing is saved until "Confirm & apply". */}
        <div
          onDrop={busy === 'idle' ? handleDrop : e => e.preventDefault()}
          onDragOver={e => e.preventDefault()}
          onClick={() => { if (busy === 'idle') fileInputRef.current?.click(); }}
          aria-disabled={busy !== 'idle'}
          className={`border-2 border-dashed border-gray-200 rounded-2xl px-8 py-10 text-center transition-colors ${
            busy === 'idle' ? 'cursor-pointer hover:border-[var(--brand-primary)] hover:bg-green-50/30' : 'cursor-not-allowed opacity-60'
          }`}
        >
          <FileSpreadsheet className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          {fileName
            ? <p className="text-sm font-medium text-gray-700">{fileName}</p>
            : (
              <>
                <p className="text-sm text-gray-400">Drop your Excel here or <span className="text-[var(--brand-primary)] font-medium underline">browse</span></p>
                <p className="text-xs text-gray-300 mt-1">Accepts .xlsx and .xls · you&apos;ll see a preview before anything is saved</p>
              </>
            )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileInputChange}
            disabled={busy !== 'idle'}
            className="hidden"
          />
        </div>

        {busy === 'previewing' && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <div className="w-4 h-4 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
            Checking the file… nothing is saved at this step.
          </div>
        )}

        {uploadError && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{uploadError}</span>
          </div>
        )}
      </div>

      {/* ── Section 4a: Preview (nothing written) ──────────────────────────── */}
      {preview && (() => {
        const blockReason = nothingToApplyReason(preview);
        const overwrite   = preview.overwriteCount;
        const applying    = busy === 'applying';
        const toAck       = preview.notApplied ?? [];
        const unacked     = toAck.filter(c => !acks.has(c.category));
        const toggleAck   = (c: NotAppliedCategory) => setAcks(prev => {
          const next = new Set(prev);
          if (next.has(c)) next.delete(c); else next.add(c);
          return next;
        });
        return (
        <div data-testid="target-upload-preview" className="bg-white rounded-2xl border border-blue-200 shadow-sm px-6 py-5 space-y-4">
          <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3.5">
            <Info className="w-5 h-5 mt-0.5 shrink-0 text-blue-600" />
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-blue-900">Preview — nothing has been saved yet</p>
              <p className="text-xs text-blue-800">
                {preview.willSaveCount > 0
                  ? <>If you confirm, {preview.willSaveCount.toLocaleString('en-IN')} outlet-month target{preview.willSaveCount !== 1 ? 's' : ''} will be saved
                      {preview.newCount !== undefined && overwrite !== undefined
                        ? ` (${preview.newCount.toLocaleString('en-IN')} new, ${overwrite.toLocaleString('en-IN')} replacing existing targets)`
                        : ''}.
                      Check the numbers below, then click <span className="font-semibold">Confirm &amp; apply</span>.</>
                  : 'Nothing in this file can be saved — see the reason below.'}
              </p>
            </div>
          </div>

          {/* Overwrite warning — prominent: these outlet-months' stored values are REPLACED. */}
          {(overwrite ?? 0) > 0 && (
            <div data-testid="target-upload-overwrite" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 space-y-2">
              <p className="text-sm font-semibold text-amber-800 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {overwrite!.toLocaleString('en-IN')} outlet-month{overwrite !== 1 ? 's' : ''} will be overwritten
              </p>
              <p className="text-xs text-amber-700">
                These outlets already have targets for that month. Confirming replaces their stored values with the
                values in this file (a KPI left blank in the file is removed for that outlet-month).
              </p>
              {preview.perMonth && preview.perMonth.length > 0 && (
                <ul className="text-xs text-amber-800 space-y-0.5">
                  {preview.perMonth.map(m => (
                    <li key={m.month}>
                      <span className="font-semibold">{formatMonth(m.month)}</span>: {m.newCount.toLocaleString('en-IN')} new · {m.overwriteCount.toLocaleString('en-IN')} overwritten
                      {(m.unchangedCount ?? 0) > 0 ? ` · ${m.unchangedCount!.toLocaleString('en-IN')} unchanged` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {preview.overwriteExamples && preview.overwriteExamples.length > 0 && (
                <div className="pt-1">
                  <p className="text-[11px] font-semibold text-amber-800">
                    Examples of values that will change (from the first {preview.overwriteExamplesSampled ?? preview.overwriteExamples.length} overwritten outlet-months checked):
                  </p>
                  <ul className="mt-1 space-y-1">
                    {preview.overwriteExamples.map(ex => (
                      <li key={`${ex.month}-${ex.outletCode}`} className="text-[11px] text-amber-800">
                        <span className="font-mono font-semibold">{ex.outletCode}</span>
                        {ex.outletName && ex.outletName !== ex.outletCode ? ` (${ex.outletName})` : ''} · {formatMonth(ex.month)}:{' '}
                        {ex.changes.map((c, i) => (
                          <span key={c.kpiCode}>
                            {i > 0 ? '; ' : ''}{c.label} {exampleValue(c.from)} → {c.to === null ? 'removed' : exampleValue(c.to)}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.overwriteExamples && preview.overwriteExamples.length === 0 && (preview.overwriteExamplesSampled ?? 0) > 0 && (
                <p className="text-[11px] text-amber-700">
                  The first {preview.overwriteExamplesSampled} overwritten outlet-months checked already have exactly these values.
                </p>
              )}
            </div>
          )}

          {/* Unchanged outlet-months: shown, but no tick — they already hold exactly these values and are not rewritten. */}
          {(preview.unchangedCount ?? 0) > 0 && (
            <div data-testid="target-upload-unchanged" className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 space-y-1">
              <p className="text-sm font-semibold text-gray-800">
                {preview.unchangedCount!.toLocaleString('en-IN')} outlet-month{preview.unchangedCount !== 1 ? 's' : ''} unchanged (no effect)
              </p>
              <p className="text-xs text-gray-600">
                These outlets already have exactly these target values for that month, so they are left as they are —
                no target value is saved or replaced.
                {(preview.outletNameUpdatedCount ?? 0) > 0 && (
                  <> Only the outlet name is updated for {plural(preview.outletNameUpdatedCount!, 'of them', 'of them')} (the
                    name in this file differs from the stored one).</>
                )}
              </p>
              {preview.unchangedSample && preview.unchangedSample.length > 0 && (
                <p className="text-[11px] text-gray-500">
                  {preview.unchangedCount! > preview.unchangedSample.length ? 'For example: ' : ''}{preview.unchangedSample.join('; ')}
                  {preview.unchangedCount! > preview.unchangedSample.length
                    ? ` … and ${(preview.unchangedCount! - preview.unchangedSample.length).toLocaleString('en-IN')} more` : ''}
                </p>
              )}
            </div>
          )}

          <UploadSummary data={preview} mode="preview" badge="Not saved yet" errorReportName="target-upload-preview-errors.xlsx" />

          {/* NO SILENT FAILURE (owner rule 2026-11-25): everything that will NOT be applied as typed must be
              explicitly acknowledged — one required box per category present — before Confirm is enabled. */}
          {!blockReason && toAck.length > 0 && (
            <fieldset data-testid="target-upload-acks" className="rounded-xl border border-gray-300 bg-gray-50 px-4 py-3 space-y-2">
              <legend className="px-1 text-xs font-semibold text-gray-800">
                Before applying, confirm you have read what will not be applied as typed:
              </legend>
              {toAck.map(c => (
                <label key={c.category} className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acks.has(c.category)}
                    onChange={() => toggleAck(c.category)}
                    disabled={applying}
                  />
                  <span>
                    {NOT_APPLIED_COPY[c.category]?.ack(c.count) ?? `I understand ${c.count} ${c.category}`}
                    {c.sample && c.sample.length > 0 && (
                      <span className="block text-[11px] text-gray-500">
                        {c.count > c.sample.length ? 'For example: ' : ''}{c.sample.join('; ')}
                        {c.count > c.sample.length ? ` … and ${(c.count - c.sample.length).toLocaleString('en-IN')} more` : ''}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!!blockReason || applying || unacked.length > 0}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {applying
                ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                : <CheckCircle2 className="w-4 h-4" />}
              {applying ? 'Applying…' : 'Confirm & apply'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={applying}
              className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-semibold rounded-xl hover:border-gray-400 disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
            {blockReason && <p data-testid="confirm-disabled-reason" className="text-xs text-gray-600">{blockReason}</p>}
            {!blockReason && unacked.length > 0 && (
              <p data-testid="confirm-disabled-reason" className="text-xs text-gray-600">
                Tick {unacked.length === 1
                  ? (toAck.length === 1 ? 'the box' : 'the remaining box')
                  : `the ${unacked.length} remaining boxes`} above to enable Confirm &amp; apply.
              </p>
            )}
            {applying && <p className="text-xs text-gray-500">Saving the targets — keep this page open.</p>}
          </div>
          {preview.previewExpiresAt && !Number.isNaN(new Date(preview.previewExpiresAt).getTime()) && (
            <p data-testid="target-upload-expiry" className="text-[11px] text-gray-500">
              This preview can be confirmed until {formatISTDateTime(preview.previewExpiresAt)} IST. After that, pick the file again.
              The whole file is saved together or not at all.
            </p>
          )}
        </div>
        );
      })()}

      {/* ── Section 4b: Applied result ─────────────────────────────────────── */}
      {result && (() => {
        // Ground truth of what persisted (backend `savedCount`; falls back to
        // acceptedCount for older API builds). This drives the explicit "saved to
        // the backend" confirmation the admin needs.
        const savedCount   = result.savedCount ?? result.acceptedCount;
        const savedMonths  = (result.writableMonths && result.writableMonths.length > 0)
          ? result.writableMonths.length
          : result.monthsInBatch.length;
        // The apply re-validates against the CURRENT outlets/targets — say so when it differs from the preview.
        const differs = appliedFrom !== null && (
          savedCount !== appliedFrom.willSaveCount
          || (result.newCount !== undefined && appliedFrom.newCount !== undefined && result.newCount !== appliedFrom.newCount)
          || (result.overwriteCount !== undefined && appliedFrom.overwriteCount !== undefined && result.overwriteCount !== appliedFrom.overwriteCount)
        );
        return (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
          {/* Prominent submit confirmation — the admin's proof the upload reached the backend. */}
          {savedCount > 0 && (
            <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3.5">
              <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0 text-emerald-600" />
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-emerald-800">
                  Targets submitted successfully
                </p>
                <p className="text-xs text-emerald-700">
                  {savedCount.toLocaleString()} outlet-month target{savedCount !== 1 ? 's' : ''} saved
                  to the system{savedMonths > 0 ? ` across ${savedMonths} month${savedMonths !== 1 ? 's' : ''}` : ''}
                  {result.newCount !== undefined && result.overwriteCount !== undefined
                    ? ` (${result.newCount.toLocaleString()} new, ${result.overwriteCount.toLocaleString()} overwritten)`
                    : ''}
                  {(result.unchangedCount ?? 0) > 0
                    ? ` · ${result.unchangedCount!.toLocaleString()} unchanged outlet-month${result.unchangedCount !== 1 ? 's' : ''} left as they were`
                    : ''}
                  {result.rejectedCount > 0 ? ` · ${result.rejectedCount} row${result.rejectedCount !== 1 ? 's' : ''} rejected (see below)` : ''}
                  {(result.skippedBlankCount ?? 0) > 0 ? ` · ${result.skippedBlankCount} blank row${result.skippedBlankCount !== 1 ? 's' : ''} skipped` : ''}.
                  You can confirm anytime with <span className="font-semibold">Download Final Targets</span> above.
                </p>
              </div>
            </div>
          )}

          {differs && appliedFrom && (
            <div data-testid="target-upload-differs" className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                The final result differs from the preview — outlets or stored targets changed between the preview and
                the apply. Preview: {appliedFrom.willSaveCount.toLocaleString()} to save
                {appliedFrom.newCount !== undefined && appliedFrom.overwriteCount !== undefined
                  ? ` (${appliedFrom.newCount.toLocaleString()} new, ${appliedFrom.overwriteCount.toLocaleString()} overwritten)` : ''}.
                {' '}Saved: {savedCount.toLocaleString()}
                {result.newCount !== undefined && result.overwriteCount !== undefined
                  ? ` (${result.newCount.toLocaleString()} new, ${result.overwriteCount.toLocaleString()} overwritten)` : ''}.
                {' '}The numbers below are what was actually saved.
              </span>
            </div>
          )}

          {result.notificationWarning && (
            <div role="status" className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{result.notificationWarning}</span>
            </div>
          )}

          {/* What was NOT applied as typed — never silent on the done screen either. */}
          {result.notApplied && result.notApplied.length > 0 && (
            <div data-testid="target-upload-not-applied" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-xs font-semibold text-amber-800">Not applied as typed:</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-amber-800 space-y-0.5">
                {result.notApplied.map(c => (
                  <li key={c.category}>{NOT_APPLIED_COPY[c.category]?.done(c.count) ?? `${c.count} ${c.category}`}</li>
                ))}
              </ul>
            </div>
          )}

          <UploadSummary
            data={result}
            mode="result"
            badge={result.batchId ? `Batch ${result.batchId.slice(-8)}` : 'Saved'}
            errorReportName={`target-upload-errors-${result.batchId || 'batch'}.xlsx`}
          />
        </div>
        );
      })()}

      {/* ── Section 5: Upload history ──────────────────────────────────────── */}
      <TargetUploadHistory refreshKey={historyKey} />

      {/* ── Section 6: per-outlet target change history ───────────────────── */}
      <TargetHistoryCard />
    </div>
  );
}

// ── Shared summary (preview + applied result) ────────────────────────────────

function UploadSummary({ data, mode, badge, errorReportName }: {
  data: UploadSummaryData;
  mode: 'preview' | 'result';
  badge: string;
  errorReportName: string;
}) {
  const isPreviewMode = mode === 'preview';
  const title = isPreviewMode ? 'Preview' : 'Upload Result';
  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-900">{title}</p>
        <span className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${
          isPreviewMode ? 'text-blue-700 bg-blue-50 border-blue-200' : 'text-emerald-600 bg-emerald-50 border-emerald-200'
        }`}>
          {isPreviewMode ? <Info className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          {badge}
        </span>
      </div>

      {/* Month chips */}
      <div className="flex flex-wrap gap-1.5">
        {data.monthsInBatch.map(m => (
          <span key={m} className="text-[10px] font-semibold px-2 py-0.5 bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] rounded-full">
            {formatMonth(m)}
          </span>
        ))}
      </div>

      {/* Summary stat cards */}
      {/* Total = Accepted + Rejected + Blank (L1) — blank template rows are counted, not saved. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatCard label="Total rows"  value={data.totalRows}     color="gray"  />
        <StatCard label="Accepted"    value={data.acceptedCount} color="green" />
        <StatCard label="Rejected"    value={data.rejectedCount} color={data.rejectedCount > 0 ? 'red' : 'gray'} />
        <StatCard label="Blank"       value={blankRowCount(data)} color="gray" />
        <StatCard label="Months"      value={data.monthsInBatch.length} color="gray" />
      </div>

      <IgnoredOutOfScopeNotice
        count={data.ignoredOutOfScope}
        rows={data.warningRows
          .map(r => ({ rowIndex: r.rowIndex, outletCode: r.outletCode ?? r.outletId, remarks: r.remarks }))}
      />

      <TargetFocusCheckNotice check={data.focusCheck} />

      {/* Past-month lock notice */}
      {data.skippedLockedMonths && data.skippedLockedMonths.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <p className="text-xs font-semibold text-amber-700">
            {data.skippedLockedMonths.length} past month{data.skippedLockedMonths.length !== 1 ? 's' : ''} {isPreviewMode ? 'will be skipped' : 'skipped'} (locked) — targets for a month already in the past can&apos;t be edited.
          </p>
          <p className="text-[11px] text-amber-600 mt-0.5">
            Not saved: {data.skippedLockedMonths.join(', ')}
          </p>
        </div>
      )}

      {/* Rejected rows — the "first N of M" note sits ABOVE the short scroll box; the download is below it. */}
      {data.problemRows.length > 0 && (
        <div className="space-y-2">
          <UploadTruncationNote
            shown={data.problemRows.length}
            total={data.problemRowCount}
            truncated={data.problemRowsTruncated}
            noun="rejected rows"
            next={isPreviewMode ? TRUNCATION_NEXT.PREVIEW : TRUNCATION_NEXT.PARTIAL_SAVE}
          />
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1 max-h-44 overflow-y-auto">
            <p className="text-xs font-semibold text-amber-700 mb-2">Rejected rows ({data.problemRowCount.toLocaleString('en-IN')})</p>
            {data.problemRows
              .map((r, i) => (
                <p key={i} className="text-xs text-amber-700">
                  <span className="font-mono font-semibold">
                    Row {r.rowIndex ?? i + 1}
                    {r.outletCode ? ` — ${r.outletCode}` : r.outletId ? ` — ${r.outletId}` : ''}:{' '}
                  </span>
                  {r.remarks ?? String(r.status)}
                </p>
              ))}
          </div>
          <DownloadErrorReportButton
            columns={['Row', 'Outlet Code', 'Month', 'Status']}
            rows={data.problemRows
              .map(r => ({
                Row:          r.rowIndex,
                'Outlet Code': r.outletCode ?? r.outletId ?? '',
                Month:        r.month ?? '',
                Status:       r.status,
                __errors:     [r.remarks ?? String(r.status)],
              }))}
            errorsByRow={(row) => (row.__errors as string[]) ?? []}
            filename={errorReportName}
            sheetName="Upload Report"
            errorHeader="Remarks"
            truncation={{ shown: data.problemRows.length, total: data.problemRowCount, truncated: data.problemRowsTruncated, noun: 'problems' }}
          />
        </div>
      )}

      {data.acceptedCount === 0 && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-sm text-amber-700">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          No rows were accepted. Check that the file uses the correct template and outlet codes match the roster.
        </div>
      )}
    </>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

const STAT_COLORS = {
  gray:  'bg-gray-50   border-gray-200  text-gray-800',
  green: 'bg-green-50  border-green-200 text-green-700',
  amber: 'bg-amber-50  border-amber-200 text-amber-700',
  red:   'bg-red-50    border-red-200   text-red-700',
} as const;

function StatCard({ label, value, color }: { label: string; value: number; color: keyof typeof STAT_COLORS }) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-center ${STAT_COLORS[color]}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs font-medium mt-0.5 opacity-70">{label}</p>
    </div>
  );
}
