'use client';

/**
 * /admin/sales-import/[id] — one import (SALES-IMPORT-PIPELINE-PLAN §11 F-4).
 *
 * QUEUED/PROCESSING → polls GET :id every 2 s (stale responses dropped via a request sequence; stops on unmount, on
 * a terminal status and on 401/403/404). UPLOADING → polls slowly (the upload may still be running in another tab).
 * NEEDS_MAPPING → detected heading row + sample rows + link to Settings. FAILED → message + Reprocess.
 * READY → the per-month preview: tick OPEN months, acknowledge partial / older-data warnings, Apply (sends the
 * definitions hash + processing version; ANY 4xx refreshes the preview). Cancel = QUEUED or stalled PROCESSING.
 * Actions that change data are shown only to users holding targets:upload (usePermissions).
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle, ArrowLeft, Ban, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, Info, Lock, RefreshCw, Trash2, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { downloadBlob } from '@/lib/download';
import { fetchDownload, salesImportApi } from '@/lib/sales-import/api';
import {
  STATUS_CHIP, STATUS_LABEL, WARNING_SHORT, applyBlockers, dateTimeLabel, dayLabel, focusBlockedMonths,
  focusFingerprintsFor, formatBytes, formatCases, formatCount, formatKpiValue, formatRupees, formatSigned,
  isActiveStatus, isPartialMonth, monthLabel, sentence, warningText,
} from '@/lib/sales-import/format';
import { getUploadState, subscribeUpload } from '@/lib/sales-import/upload-store';
import { failureReason, noAnswerReason, outcomeUnknown, reasonOr } from '@/lib/request-outcome';
import {
  JOB_QUEUED_TOO_LONG_MS, clearUnknown, jobEnded, jobHeadline, loadUnknown, lookUp, monthProgressText, monthResult,
  newRequestId, resolveSubmit, resultsSummary, saveUnknown, useJobFollower, whenLabel, type SubmitOutcome, type UnknownLock,
} from '@/lib/sales-import/apply-job';
import { usePermissions } from '@/lib/use-permissions';
import {
  SALES_IMPORT_ABANDONED_UPLOAD_HOURS, SALES_IMPORT_MAX_DIM_VALUE_CHARS, SALES_IMPORT_STALE_HEARTBEAT_MINUTES,
  type ApplyMonthResult, type ApplyRequest, type MonthPreview, type SalesApplyJobDto, type SalesDimensionMapping,
  type SalesImportDetail, type SalesImportPreview,
} from '@/lib/sales-import/types';
import {
  MonthReconciliationPanel, reconciliationNeedsAttention, useDimensionLabels, useOutletTypeNames, type OutletTypeNames,
} from '../_components/month-reconciliation-panel';
import { DayDataNotice } from '../_components/day-data-notice';

const POLL_MS = 2000;
const UPLOADING_POLL_MS = 5000;
const QUEUED_TOO_LONG_MS = 2 * 60 * 1000;

/** A failed request that will not get better by polling again. */
function finalErrorText(status: number | undefined): string | null {
  if (status === 401) return 'Your session has expired. Sign in again to see this import.';
  if (status === 403) return 'You don’t have access to this import.';
  if (status === 404) return 'This import was not found. It may have been deleted.';
  return null;
}

/** The pre-release synchronous apply answer ({ results }) — still accepted while a deploy is in progress. */
function legacyResults(data: unknown): ApplyMonthResult[] | null {
  const r = (data as { results?: unknown } | null)?.results;
  return Array.isArray(r) ? (r as ApplyMonthResult[]) : null;
}

// ── Polling the import ───────────────────────────────────────────────────────

function useImportDetail(importId: string | undefined) {
  const [detail, setDetail] = useState<SalesImportDetail | null>(null);
  const [error, setError] = useState<{ text: string; final: boolean } | null>(null);
  const [queuedTooLong, setQueuedTooLong] = useState(false);
  const [tick, setTick] = useState(0);
  const seqRef = useRef(0);
  // Prefer the server's `queuedAt`; fall back to when THIS page first saw the import queued (a lower bound,
  // never shown too early) if the server did not send one.
  const queuedSinceRef = useRef<number | null>(null);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!importId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // The first load is the person opening/refreshing the page; every timer-driven re-load after it is an
    // automatic poll → sent as a background request (the Usage Report does not count it as activity).
    let polls = 0;
    const load = async () => {
      const seq = ++seqRef.current;
      const r = await (polls++ === 0 ? salesImportApi.get(importId) : salesImportApi.get(importId, { background: true }));
      if (cancelled || seq !== seqRef.current) return; // stale response
      if (!r.success) {
        const final = finalErrorText(r.status);
        setError({ text: final ?? failureReason(r), final: final !== null });
        // Keep polling through a transient error; 401/403/404 are final.
        if (!final) timer = setTimeout(load, POLL_MS * 2);
        return;
      }
      setError(null);
      setDetail(r.data);
      if (r.data.status === 'QUEUED') {
        const now = Date.now();
        if (queuedSinceRef.current === null) queuedSinceRef.current = now;
        const serverQueued = r.data.queuedAt ? Date.parse(r.data.queuedAt) : NaN;
        const since = Number.isFinite(serverQueued) ? serverQueued : queuedSinceRef.current;
        setQueuedTooLong(now - since > QUEUED_TOO_LONG_MS);
      } else {
        queuedSinceRef.current = null;
        setQueuedTooLong(false);
      }
      if (isActiveStatus(r.data.status)) timer = setTimeout(load, POLL_MS);
      else if (r.data.status === 'UPLOADING') timer = setTimeout(load, UPLOADING_POLL_MS);
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [importId, tick]);

  return { detail, error, queuedTooLong, refresh };
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Banner({ tone, children, testId }: { tone: 'amber' | 'red' | 'blue' | 'green'; children: React.ReactNode; testId?: string }) {
  const cls = {
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    red: 'bg-red-50 border-red-200 text-red-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    green: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  }[tone];
  // Only errors are announced on appearance (role=alert). Other banners have no live role: a conditionally mounted
  // role=status is not reliably read out (audit L9) — PreviewSection's always-present live region announces changes.
  return <div role={tone === 'red' ? 'alert' : undefined} data-testid={testId} className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

async function download(url: string, filename: string, onError: (m: string) => void) {
  const r = await fetchDownload(url);
  if (r.success) downloadBlob(r.data, filename);
  else onError(`The download failed: ${failureReason(r)}.`);
}

// ── Processing state ─────────────────────────────────────────────────────────

function ProcessingCard({ d, queuedTooLong }: { d: SalesImportDetail; queuedTooLong: boolean }) {
  const pct = d.progressPct === null ? null : Math.max(0, Math.min(100, Math.round(d.progressPct)));
  return (
    <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-3" data-testid="sales-import-processing">
      <div className="flex items-center gap-2 text-sm text-gray-700">
        <Spinner size="sm" />
        {d.status === 'QUEUED' ? 'Waiting for the processor to start…' : 'Reading the file…'}
      </div>
      {pct !== null && (
        <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Processing progress">
          <div className="h-full bg-[var(--brand-primary)] transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="text-xs text-gray-500">
        {pct !== null ? `${pct}% of ${formatBytes(d.sizeBytes)} read · ` : ''}{formatCount(d.rowsRead)} rows read
        {d.rowsSkipped > 0 ? ` · ${formatCount(d.rowsSkipped)} skipped` : ''}. You can leave this page and come back.
      </p>
      {d.stalled && (
        <Banner tone="amber" testId="sales-import-stalled">
          The processor has not reported progress for more than {SALES_IMPORT_STALE_HEARTBEAT_MINUTES} minutes. It is
          picked up again automatically; you can also cancel it, or press Reprocess to start it again.
        </Banner>
      )}
      {queuedTooLong && !d.stalled && (
        <Banner tone="amber" testId="sales-import-queued-long">
          This file has been waiting for more than 2 minutes. If it does not start soon, contact Gifsy support.
        </Banner>
      )}
    </section>
  );
}

function UploadingCard({ d }: { d: SalesImportDetail }) {
  const up = useSyncExternalStore(subscribeUpload, getUploadState, getUploadState);
  const mine = up.importId === d.id;
  if (mine && up.phase === 'uploading') {
    return (
      <Banner tone="blue" testId="sales-import-uploading-here">
        This file is still uploading in this browser tab ({Math.round(up.progress * 100)}%). Keep the tab open — this page
        updates when the upload finishes.
      </Banner>
    );
  }
  if (mine && up.phase === 'failed') {
    return (
      <Banner tone="amber" testId="sales-import-uploading-failed">
        The upload of this file stopped part-way ({sentence(up.error)}).{' '}
        <Link href="/admin/sales-import" className="underline font-medium">Go to Sales Import to resume it</Link>.
      </Banner>
    );
  }
  return (
    <Banner tone="amber" testId="sales-import-uploading">
      This file has not finished uploading ({formatCount(d.partsReceived)} of {formatCount(d.partCount)} parts received).
      If it is still uploading in another tab or window, keep that open — this page updates when it finishes. If the
      upload stopped, delete this import and upload the file again; unfinished uploads are removed automatically after
      {` ${SALES_IMPORT_ABANDONED_UPLOAD_HOURS}`} hours.
    </Banner>
  );
}

function NeedsMappingCard({ d, onReprocess, busy, canAct, canConfigure }: {
  d: SalesImportDetail; onReprocess(): void; busy: boolean; canAct: boolean; canConfigure: boolean;
}) {
  const [header, ...samples] = d.detectedHeaders ?? [];
  const width = Math.max(header?.length ?? 0, ...samples.map((r) => r.length));
  return (
    <section className="bg-white rounded-xl border border-amber-200 p-6 space-y-3" data-testid="sales-import-needs-mapping">
      <h2 className="text-sm font-semibold text-gray-900">The portal could not find the columns it needs</h2>
      {d.error && <p className="text-sm text-amber-800">{d.error}</p>}
      <p className="text-sm text-gray-600">
        Below is the row the portal took as the heading row{samples.length ? ', followed by the first rows of data' : ''}.
        {canConfigure && canAct
          ? ' Tell the portal which column is the outlet code, invoice date, amount, cases and product details, then press Reprocess.'
          : canConfigure
            ? ' Tell the portal which column is the outlet code, invoice date, amount, cases and product details; someone who can upload sales files then reprocesses it.'
            : ' Ask someone who can change the Sales Import settings to set up the column mapping for this file.'}
      </p>
      {header && (
        <div className="overflow-x-auto border border-gray-100 rounded-lg">
          <table className="text-xs">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th scope="row" className="px-2 py-1 text-left font-medium text-gray-500">Headings</th>
                {Array.from({ length: width }, (_, j) => (
                  <th key={j} scope="col" className="px-2 py-1 text-left font-semibold whitespace-nowrap text-gray-800">{header[j] ?? ''}</th>
                ))}
              </tr>
            </thead>
            {samples.length > 0 && (
              <tbody>
                {samples.map((r, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <th scope="row" className="px-2 py-1 text-left font-normal text-gray-400">Row {i + 1}</th>
                    {Array.from({ length: width }, (_, j) => <td key={j} className="px-2 py-1 whitespace-nowrap text-gray-700">{r[j] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      )}
      <div className="flex gap-2">
        {canConfigure && (
          <Link href={`/admin/sales-import/settings?fromImport=${encodeURIComponent(d.id)}`}
            className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg bg-[var(--brand-primary)] text-white hover:opacity-90">
            Set up column mapping
          </Link>
        )}
        {canAct && d.canReprocess && (
          <Button variant="outline" onClick={onReprocess} loading={busy}><RefreshCw className="w-4 h-4" /> Reprocess</Button>
        )}
      </div>
    </section>
  );
}

// ── Month preview table ──────────────────────────────────────────────────────

/** "Last applied: up to 31 Oct" under the file's own dates; amber when this file's data ends earlier. */
function LastAppliedRange({ m }: { m: MonthPreview }) {
  if (!m.lastApplied) return <span className="block text-[11px] text-gray-400">Never applied from a sales file</span>;
  const older = m.warnings.includes('OLDER_THAN_LAST_APPLIED');
  const until = m.lastApplied.lastInvoiceDate;
  return (
    <span className={`block text-[11px] ${older ? 'text-amber-700 font-medium' : 'text-gray-500'}`} data-testid={`last-applied-${m.month}`}>
      {older && <AlertTriangle className="inline w-3 h-3 mr-0.5 -mt-0.5" />}
      Applied now: {until ? `up to ${dayLabel(until)}` : 'an earlier file'}
    </span>
  );
}

function MonthRow({
  m, selected, onToggle, partialAck, onPartialAck, importId, onDownloadError, canAct, dims, typeNames, onRefresh,
}: {
  m: MonthPreview; selected: boolean; onToggle(): void; partialAck: boolean; onPartialAck(v: boolean): void;
  importId: string; onDownloadError(msg: string): void; canAct: boolean;
  dims: SalesDimensionMapping[];
  typeNames: OutletTypeNames;
  /** Re-fetch the preview (after Accept / Undo of a focus product name); true when it landed. */
  onRefresh(): Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const partial = isPartialMonth(m);
  const label = monthLabel(m.month);
  const attention = reconciliationNeedsAttention(m.reconciliation);
  const showDetail = open || m.warnings.length > 0 || attention;
  const detailId = `month-detail-${m.month}`;
  // Fallback only (older server without MonthFocusKpi.measure / targets.kpis[].measure).
  const measures = Object.fromEntries(m.kpis.map((k) => [k.kpiCode, k.measure]));
  // After Accept / Undo the row opens fully, so the replacing chip (and its Undo / Accept button) stays on screen
  // even when the month no longer needs attention — keyboard focus is put back on it.
  const refreshOpen = useCallback(async () => { setOpen(true); return onRefresh(); }, [onRefresh]);
  return (
    <>
      <tr className="border-b border-gray-100 align-top" data-testid={`month-row-${m.month}`}>
        <td className="px-3 py-2">
          <input
            type="checkbox"
            aria-label={`Apply ${label}`}
            checked={selected}
            disabled={!m.canApply || !canAct}
            onChange={onToggle}
            title={m.canApply ? undefined : m.blockedReason}
            className="w-4 h-4"
          />
        </td>
        <td className="px-3 py-2">
          <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 font-medium text-gray-900"
            aria-expanded={showDetail} aria-controls={showDetail ? detailId : undefined}>
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {label}
          </button>
          <span className={`mt-1 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
            m.monthState === 'CLOSED' ? 'bg-gray-100 text-gray-600 border-gray-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
            {m.monthState === 'CLOSED' && <Lock className="w-3 h-3" />}{m.monthState === 'CLOSED' ? 'Closed' : 'Open'}
          </span>
          {!m.canApply && m.blockedReason && <p className="mt-1 text-xs text-gray-500 max-w-[14rem]">{m.blockedReason}</p>}
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-gray-600">
          This file: {dayLabel(m.firstDate)} – {dayLabel(m.lastDate)}
          <LastAppliedRange m={m} />
        </td>
        <td className="px-3 py-2 text-right text-gray-600">{formatCount(m.lines)}</td>
        <td className="px-3 py-2 text-right text-gray-600">{formatCount(m.matchedOutlets)}</td>
        <td className="px-3 py-2 text-right text-gray-600">
          {m.unmatchedCustomers > 0 ? (
            <button type="button" className="text-[var(--brand-primary)] underline"
              aria-label={`Download the ${formatCount(m.unmatchedCustomers)} customers not in the programme`}
              onClick={() => download(salesImportApi.unmatchedCsvUrl(importId), `unmatched-${m.month}.csv`, onDownloadError)}>
              {formatCount(m.unmatchedCustomers)}
            </button>
          ) : '0'}
        </td>
        <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">{formatRupees(m.matchedAmountRupees)}</td>
        <td className="px-3 py-2 text-right text-gray-700">{formatCases(m.matchedQuantity)}</td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {m.warnings.map((w) => (
              <span key={w} className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">
                {WARNING_SHORT[w]}
              </span>
            ))}
          </div>
        </td>
      </tr>
      {showDetail && (
        <tr className="border-b border-gray-100 bg-gray-50/50" id={detailId} data-testid={detailId}>
          <td />
          <td colSpan={8} className="px-3 py-3 space-y-3">
            <MonthReconciliationPanel month={m.month} reconciliation={m.reconciliation} measures={measures} dims={dims}
              typeNames={typeNames} canAct={canAct} monthOpen={m.monthState === 'OPEN'} expanded={open}
              onRefresh={refreshOpen} />
            {m.warnings.length > 0 && (
              <ul className="space-y-1" data-testid={`month-warnings-${m.month}`}>
                {m.warnings.map((w) => (
                  <li key={w} className="text-xs text-amber-800 flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{warningText(w, m)}</li>
                ))}
              </ul>
            )}
            {partial && m.canApply && canAct && (
              <label className="flex items-start gap-2 text-xs text-gray-800">
                <input type="checkbox" className="mt-0.5" checked={partialAck} onChange={(e) => onPartialAck(e.target.checked)}
                  aria-label={`I understand this replaces the whole of ${label} with this partial file`} />
                <span>I understand this replaces the <strong>whole of {label}</strong> with this partial file ({dayLabel(m.firstDate)} – {dayLabel(m.lastDate)}).</span>
              </label>
            )}
            {open && (
              <div className="space-y-2">
                {m.kpis.length === 0 ? (
                  <p className="text-xs text-gray-500">No KPIs are set up for Sales Import yet. Add them under Settings.</p>
                ) : (
                  <table className="text-xs w-full max-w-3xl">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th className="py-1 pr-3 font-medium">KPI</th>
                        <th className="py-1 pr-3 font-medium text-right">From this file</th>
                        <th className="py-1 pr-3 font-medium text-right">Stored now</th>
                        <th className="py-1 pr-3 font-medium text-right">Change</th>
                        <th className="py-1 pr-3 font-medium text-right">Outlets &gt; 0</th>
                        <th className="py-1 font-medium text-right">Negative</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.kpis.map((k) => (
                        <tr key={k.kpiCode} className="border-t border-gray-100">
                          <td className="py-1 pr-3 text-gray-800">{k.label || k.kpiCode}</td>
                          <td className="py-1 pr-3 text-right">{formatKpiValue(k.newTotal, k.measure)}</td>
                          <td className="py-1 pr-3 text-right text-gray-500">{formatKpiValue(k.currentTotal, k.measure)}</td>
                          <td className={`py-1 pr-3 text-right ${k.delta < 0 ? 'text-red-600' : k.delta > 0 ? 'text-emerald-700' : 'text-gray-500'}`}>
                            {formatSigned(k.delta, (n) => formatKpiValue(n, k.measure))}
                          </td>
                          <td className="py-1 pr-3 text-right">{formatCount(k.outletsNonZero)}</td>
                          <td className={`py-1 text-right ${k.outletsNegative > 0 ? 'text-amber-700' : ''}`}>{formatCount(k.outletsNegative)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="text-xs text-gray-500">
                  {formatCount(m.zeroFillOutlets)} programme outlets have no lines in the file for {label} and will be set to 0.
                  Customers not in the programme: {formatCount(m.unmatchedCustomers)} ({formatRupees(m.unmatchedAmountRupees)}, ignored).
                  {m.lastApplied
                    ? ` Last applied ${dateTimeLabel(m.lastApplied.at)} by ${m.lastApplied.byName}${m.lastApplied.lastInvoiceDate ? ` (sales up to ${dayLabel(m.lastApplied.lastInvoiceDate)})` : ''}.`
                    : ' Never applied from a sales file.'}
                </p>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function PreviewSection({
  importId, onReprocess, reprocessing, canAct, canReprocess, onApplied, canReprocessAsNew = false, onReprocessAsNew,
  reprocessingAsNew = false, onActiveJob,
}: {
  importId: string; onReprocess(): void; reprocessing: boolean; canAct: boolean; canReprocess: boolean;
  /** Applied import whose mapping changed: re-read the stored file as a NEW import. */
  canReprocessAsNew?: boolean; onReprocessAsNew?(): void; reprocessingAsNew?: boolean;
  /** After an apply attempt that changed (or may have changed) server state: refresh the import detail too. */
  onApplied(): void;
  /** An Apply of THIS import is queued / running (or null when none): the page holds Reprocess / Cancel / Delete. */
  onActiveJob?(why: string | null): void;
}) {
  const [preview, setPreview] = useState<SalesImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [partialAcks, setPartialAcks] = useState<Set<string>>(new Set());
  const [olderAck, setOlderAck] = useState(false);
  /** The Apply POST is in flight. */
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ApplyMonthResult[] | null>(null);
  /** The background job of THIS import shown on the page (this click's, or one found running on load / by another admin). */
  const [jobId, setJobId] = useState<string | null>(null);
  /** Looking the click up by its requestId after no clear answer. */
  const [checking, setChecking] = useState(false);
  /**
   * No clear answer and the lookup failed too: whether the click was recorded is unknown → Apply disabled until Check
   * again settles it. `notRecorded`: the lookup says the click recorded nothing → Try again (same requestId: harmless).
   */
  const unknownKey = `sales-import-apply-unknown:${importId}`;
  // B-L8: an unknown outcome survives a reload (Apply stays held until Check again settles it).
  const [unknown, setUnknownState] = useState<UnknownLock | null>(() => (typeof window === 'undefined' ? null : loadUnknown(unknownKey)));
  const setUnknown = useCallback((u: UnknownLock | null) => {
    setUnknownState(u);
    if (u) saveUnknown(unknownKey, u); else clearUnknown(unknownKey);
  }, [unknownKey]);
  /** Where focus goes after a confirm, so keyboard / screen-reader users land on the outcome (B-L10). */
  const outcomeRef = useRef<HTMLDivElement | null>(null);
  const focusOutcome = () => { setTimeout(() => outcomeRef.current?.focus(), 0); };
  const [notRecorded, setNotRecorded] = useState(false);
  /** The last request sent (with its requestId) — Try again resends exactly it, so the server can never queue it twice. */
  const lastSent = useRef<ApplyRequest | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const dims = useDimensionLabels();
  const typeNames = useOutletTypeNames();

  /**
   * Loads the preview: the preview when THIS load landed, 'stale' when a newer load superseded it (not a failure — L8),
   * null when it failed.
   */
  const loadPreview = useCallback(async (): Promise<SalesImportPreview | 'stale' | null> => {
    const seq = ++seqRef.current;
    setLoading(true);
    const r = await salesImportApi.preview(importId);
    if (!mountedRef.current || seq !== seqRef.current) return 'stale';
    setLoading(false);
    if (r.success) {
      setError(null);
      setPreview(r.data);
      // Drop selections that are no longer applicable after a refresh.
      const ok = new Set(r.data.months.filter((m) => m.canApply).map((m) => m.month));
      setSelected((prev) => new Set([...prev].filter((m) => ok.has(m))));
      return r.data;
    }
    setError(finalErrorText(r.status) ?? failureReason(r));
    return null;
  }, [importId]);
  /** For the month rows (Accept / Undo of a focus name): true unless the reload FAILED (a superseded one is fine). */
  const reloadPreview = useCallback(async () => (await loadPreview()) !== null, [loadPreview]);

  useEffect(() => { void loadPreview(); }, [loadPreview, tick]);

  /** A followed job ended: its months become result cards (this import's), and the preview / import are re-read. */
  const onJobEnded = useCallback((job: SalesApplyJobDto) => {
    if (!mountedRef.current) return;
    if (job.importId === importId && job.kind === 'APPLY') {
      const res = job.months.map((m) => monthResult(job, m.month)).filter((x): x is ApplyMonthResult => x !== null);
      setResults(res);
      setSelected(new Set(res.filter((x) => !x.ok).map((x) => x.month)));
      setPartialAcks(new Set());
      setOlderAck(false);
    }
    onApplied();
    void loadPreview();
  }, [importId, loadPreview, onApplied]);
  const { jobs, problems, follow } = useJobFollower(onJobEnded);

  // Refresh-safe / several admins: any month with an Apply / Recalculate queued or running is followed until it ends;
  // a job of THIS import is shown as this page's progress (whoever started it).
  useEffect(() => {
    if (!preview) return;
    for (const m of preview.months) {
      const a = m.activeJob;
      if (!a) continue;
      follow(a.jobId);
      // B-L5: a LATER job on this import (after the shown one ended) becomes the one shown.
      if (a.importId === importId && a.kind === 'APPLY') setJobId((cur) => (cur && cur !== a.jobId && !jobEnded(jobs[cur]) ? cur : a.jobId));
    }
  }, [preview, importId, follow, jobs]);

    const refetch = useCallback(() => setTick((t) => t + 1), []);

  // A-L6 / B-M8: tell the page an Apply of this import is queued / running, so it holds Reprocess / Cancel / Delete.
  const activeOfThis = preview?.months.find((m) => m.activeJob && m.activeJob.importId === importId)?.activeJob ?? null;
  const shownRunning = !!(jobId && jobs[jobId] && !jobEnded(jobs[jobId]));
  const holdWhy = activeOfThis || shownRunning
    ? `An apply of this file is ${activeOfThis ? `running (started by ${activeOfThis.requestedBy} at ${whenLabel(activeOfThis.createdAt)})` : 'running'} — wait for it to finish.`
    : null;
  useEffect(() => { onActiveJob?.(holdWhy); }, [holdWhy, onActiveJob]);

  if (error && !preview) {
    return (
      <Banner tone="red">
        Couldn&apos;t load the preview: {reasonOr(error, 'no reason was given')}{' '}
        <Button size="sm" variant="outline" className="ml-2" onClick={refetch}>Retry</Button>
      </Banner>
    );
  }
  if (!preview) return <div className="py-6 flex items-center gap-2 text-sm text-gray-500"><Spinner size="sm" /> Building the preview…</div>;

  const months = preview.months;
  const noKpis = months.length > 0 && months.every((m) => m.kpis.length === 0);
  const blockers = [
    ...(noKpis ? ['No KPIs are set up for Sales Import yet, so there is nothing to apply. Add them under Settings first.'] : []),
    ...applyBlockers(months, selected, partialAcks, olderAck),
  ];
  // Months held back by focus-product problems cannot be ticked; say why next to Apply even when nothing is ticked —
  // under their own "Not available:" heading, so they never read as the reason a ticked good month can't be applied.
  const heldBack = focusBlockedMonths(months, selected).filter((b) => !blockers.includes(b));
  const showBlockers = (selected.size > 0 || noKpis) && blockers.length > 0;
  const anyOlder = months.some((m) => selected.has(m.month) && m.warnings.includes('OLDER_THAN_LAST_APPLIED'));
  const kpiNames = Array.from(new Set(months.flatMap((m) => m.kpis.map((k) => k.label || k.kpiCode))));
  /** The job this page shows (this import's) and whether it is still going. */
  const job = jobId ? jobs[jobId] ?? null : null;
  const jobRunning = !!job && !jobEnded(job);
  /** Apply is held while a request is out, its outcome is being checked or unknown, or this import's job still runs. */
  const busy = applying || checking || !!unknown || jobRunning;
  const queuedTooLong = !!job && job.status === 'QUEUED' && job.attempts === 0 && Date.now() - Date.parse(job.createdAt) > JOB_QUEUED_TOO_LONG_MS;
  const progressLines = job ? job.months.map((m) => monthProgressText(job, m.month, monthLabel(m.month))) : [];
  const problem = jobId ? problems[jobId] ?? null : null;
  // B-H1: coming back after a job ended — its result cards come from each month's latest finished job of this import.
  const lastResults = months
    .filter((m) => m.lastJob && m.lastJob.importId === importId && m.lastJob.kind === 'APPLY' && !m.activeJob)
    .map((m) => ({ month: m.month, job: m.lastJob! }));
  /** Why Apply is disabled — read out with the button (aria-describedby, audit L9). */
  const applyWhy = unknown ? 'Apply is held until the page can confirm whether the last apply was recorded.'
    : jobRunning ? 'Apply is held while this file is being applied.'
      : checking ? 'Checking what happened to the last apply.'
        : blockers.length > 0 ? blockers.join(' ') : '';
  /** One always-present polite live region (L9): what changed, for screen-reader users. */
  const liveText = unknown ? '' : checking ? 'Checking what happened to the apply…'
    : jobRunning ? progressLines.join('. ')
      : results ? `Apply finished. ${resultsSummary(results, monthLabel)}.` : notice ?? '';

  function toggle(month: string) {
    setResults(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month); else next.add(month);
      return next;
    });
  }

  async function apply() {
    if (!preview || blockers.length > 0 || busy || !canAct) return;
    const picked = months.filter((m) => selected.has(m.month));
    const names = picked.map((m) => monthLabel(m.month)).join(', ');
    const ok = window.confirm(
      `Apply ${names}?\n\n` +
      `For each month, the Sales Import KPIs${kpiNames.length ? ` (${kpiNames.join(', ')})` : ''} are fully replaced ` +
      'for every programme outlet. Outlets with no sales in the file get 0. Other KPIs are not touched. ' +
      'It runs in the background: you can leave this page.',
    );
    if (!ok) return;
    const partialMonths = picked.filter(isPartialMonth).map((m) => m.month);
    const fingerprints = focusFingerprintsFor(months, selected);
    await send({
      months: picked.map((m) => m.month),
      expectedDefinitionsHash: preview.definitionsHash,
      processingVersion: preview.processingVersion,
      ...(partialMonths.length ? { acknowledgePartialMonths: partialMonths } : {}),
      ...(anyOlder ? { acknowledgeOlderThanLastApplied: true } : {}),
      ...(Object.keys(fingerprints).length ? { expectedFocusFingerprints: fingerprints } : {}),
      requestId: newRequestId(),
    });
  }

  /** Send (or resend — same requestId) an apply request and act on what it led to. */
  async function send(req: ApplyRequest) {
    lastSent.current = req;
    setApplying(true);
    setNotice(null);
    setResults(null);
    setUnknown(null);
    setNotRecorded(false);
    const r = await salesImportApi.apply(importId, req);
    if (!mountedRef.current) return;
    if (!r.success && !outcomeUnknown(r)) {
      setApplying(false);
      await refused(r.status, failureReason(r));
      focusOutcome();
      return;
    }
    if (!r.success) setChecking(true);
    const out = await resolveSubmit(r, req.requestId!, legacyResults);
    if (!mountedRef.current) return;
    setApplying(false);
    setChecking(false);
    await settle(out, req.requestId!);
  }

  async function settle(out: SubmitOutcome, requestId: string) {
    focusOutcome();
    if (out.kind === 'job') {
      setUnknown(null);
      // Clear the ticks FIRST: an already-finished job ends inside follow() and re-ticks its failed months.
      setSelected(new Set());
      setPartialAcks(new Set());
      setOlderAck(false);
      setJobId(out.job.id);
      onApplied();
      follow(out.job.id, out.job);
      if (out.afterNoAnswer) setNotice('The server’s first reply didn’t come through, but the apply was recorded — its progress is shown below. Don’t apply again.');
    } else if (out.kind === 'legacy') {
      // An API from before background jobs (a deploy in progress) answered synchronously.
      setResults(out.results);
      setSelected(new Set(out.results.filter((x) => !x.ok).map((x) => x.month)));
      setPartialAcks(new Set());
      setOlderAck(false);
      onApplied();
      refetch();
    } else if (out.kind === 'refused') {
      await refused(out.status, out.reason);
    } else if (out.kind === 'not-recorded') {
      setNotRecorded(true);
      setNotice(`Nothing was applied: ${out.reason}, and nothing was recorded for this click. Try again.`);
    } else {
      setUnknown({ requestId, reason: out.reason, months: lastSent.current?.months ?? [] });
    }
  }

  async function refused(status: number | undefined, reason: string) {
    if (status === 401) { setNotice('Nothing was applied: your session has expired. Sign in again, then apply.'); return; }
    if (status === 403) { setNotice('Nothing was applied: you don’t have permission to apply sales files.'); return; }
    // Any refusal (definitions / processing version changed, a month closed or being applied, an ack now needed…) means
    // the preview on screen may be out of date → reload it (and the import). Only claim "refreshed" when it landed.
    onApplied();
    const refreshed = (await loadPreview()) !== null;
    setNotice(refreshed
      ? `Nothing was applied: ${reason}. The preview has been refreshed — check it and apply again.`
      : `Nothing was applied: ${reason}. The preview could not be refreshed — press Refresh preview before applying again.`);
  }

  /** Check again after an unknown outcome: look the click up by its requestId. */
  async function checkAgain() {
    if (!unknown) return;
    setChecking(true);
    const out = await lookUp(unknown.requestId, unknown.reason);
    if (!mountedRef.current) return;
    setChecking(false);
    await settle(out, unknown.requestId);
  }

    return (
    <section className="space-y-4" data-testid="sales-import-preview">
      {preview.mappingChanged && (
        <Banner tone="red" testId="sales-import-mapping-changed">
          The column mapping was changed after this file was processed, so no month can be applied from it.{' '}
          {canAct && canReprocess && 'Reprocess the file to read it with the current mapping.'}
          {canAct && !canReprocess && canReprocessAsNew &&
            'Months were already applied from it, so it is kept as the record of what was written; read the same file again as a new import to use the current mapping.'}
          {!canAct && 'Someone who can upload sales files needs to read it again with the current mapping.'}
          {canAct && canReprocess && (
            <Button size="sm" variant="outline" className="ml-2" onClick={onReprocess} loading={reprocessing}>
              <RefreshCw className="w-3.5 h-3.5" /> Reprocess
            </Button>
          )}
          {canAct && !canReprocess && canReprocessAsNew && onReprocessAsNew && (
            <Button size="sm" variant="outline" className="ml-2" onClick={onReprocessAsNew} loading={reprocessingAsNew}
              data-testid="sales-import-reprocess-as-new-banner">
              <Copy className="w-3.5 h-3.5" /> Read again as a new import
            </Button>
          )}
        </Banner>
      )}
      {preview.rosterOutletsAddedSinceProcessing > 0 && (
        <Banner tone="blue" testId="sales-import-roster-added">
          <span className="inline-flex items-start gap-1.5">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {formatCount(preview.rosterOutletsAddedSinceProcessing)} outlet{preview.rosterOutletsAddedSinceProcessing === 1 ? ' was' : 's were'} added
              to the programme after this file was processed. They are included: the figures below and the apply use
              today&apos;s outlet list.
            </span>
          </span>
        </Banner>
      )}
      {error && (
        <Banner tone="red" testId="sales-import-preview-error">
          Couldn&apos;t refresh the preview: {reasonOr(error, 'no reason was given')}. The figures below may be out of date.{' '}
          <Button size="sm" variant="outline" className="ml-2" onClick={refetch}>Retry</Button>
        </Banner>
      )}
      <p className="sr-only" aria-live="polite" data-testid="sales-import-live">{liveText}</p>
      <div ref={outcomeRef} tabIndex={-1} className="space-y-4 outline-none" data-testid="sales-import-outcome">
      {checking && (
        <Banner tone="blue" testId="sales-import-apply-checking">
          <span className="inline-flex items-center gap-2">
            <Spinner size="sm" /> No clear answer from the server. Checking what happened…
          </span>
        </Banner>
      )}
      {!checking && unknown && (
        <Banner tone="red" testId="sales-import-apply-unknown">
          We couldn&apos;t confirm whether this apply was recorded: {unknown.reason}, and checking also failed. Don&apos;t
          apply again yet — press Check again.{' '}
          <Button size="sm" variant="outline" className="ml-2" onClick={() => { void checkAgain(); }}>Check again</Button>
        </Banner>
      )}
      {notice && (
        <Banner tone="amber" testId="sales-import-apply-notice">
          {notice}
          {notRecorded && lastSent.current && (
            <Button size="sm" variant="outline" className="ml-2" onClick={() => { void send(lastSent.current!); }}>Try again</Button>
          )}
        </Banner>
      )}
      {job && (jobRunning || job.importId !== importId) && (
        <section className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 space-y-1" data-testid="sales-import-job"
          aria-label="Apply progress">
          <p className="font-semibold flex items-center gap-2">
            {jobRunning && <Spinner size="sm" />}
            {jobHeadline(job)}
          </p>
          <p className="text-xs">
            Started by {job.requestedBy} at {whenLabel(job.createdAt)}. You can leave this page — it carries on, and this
            page shows the result when you come back. Don&apos;t apply these months again meanwhile.
          </p>
          <ul className="text-xs list-disc pl-4" data-testid="sales-import-job-months">
            {progressLines.map((l) => <li key={l}>{l}</li>)}
          </ul>
          {queuedTooLong && (
            <p className="text-xs text-amber-800" data-testid="sales-import-job-queued-long">
              The processor has not started yet. It is started again automatically within 10 minutes — don&apos;t apply
              again. If it is still queued after that, contact Gifsy support.
            </p>
          )}
          {problem && (
            <p role={problem.final ? 'alert' : undefined} className="text-xs text-amber-800" data-testid="sales-import-job-lost-contact">
              {problem.text}
            </p>
          )}
        </section>
      )}
      </div>
      {downloadError && <Banner tone="red">{downloadError}</Banner>}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
        <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Months in this file</h2>
            <p className="text-xs text-gray-500 mt-0.5 max-w-3xl">
              Tick the months to update. Each ticked month is replaced completely by this file. Only open months can be
              ticked; a closed month needs Gifsy to reopen it. Open months can still change, so compute points only after
              closing the month under <Link href="/admin/sales-import/months" className="underline">Months</Link>.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={refetch} loading={loading} aria-label="Refresh preview" data-testid="sales-import-refresh-preview">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh preview
          </Button>
        </div>
        {months.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500">No usable invoice lines were found in this file.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 bg-gray-50 border-b border-gray-200">
                <th className="px-3 py-2 w-8"><span className="sr-only">Apply</span></th>
                <th className="px-3 py-2 font-medium">Month</th>
                <th className="px-3 py-2 font-medium">Sales dates</th>
                <th className="px-3 py-2 font-medium text-right">Lines</th>
                <th className="px-3 py-2 font-medium text-right">Outlets found</th>
                <th className="px-3 py-2 font-medium text-right">Not in programme</th>
                <th className="px-3 py-2 font-medium text-right">₹ (outlets found)</th>
                <th className="px-3 py-2 font-medium text-right">Cases</th>
                <th className="px-3 py-2 font-medium">Warnings</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <MonthRow
                  key={m.month}
                  m={m}
                  importId={importId}
                  canAct={canAct}
                  selected={selected.has(m.month)}
                  onToggle={() => toggle(m.month)}
                  partialAck={partialAcks.has(m.month)}
                  onPartialAck={(v) => setPartialAcks((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(m.month); else next.delete(m.month);
                    return next;
                  })}
                  onDownloadError={setDownloadError}
                  dims={dims}
                  typeNames={typeNames}
                  onRefresh={reloadPreview}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canAct && anyOlder && (
        <label className="flex items-start gap-2 text-sm text-gray-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <input type="checkbox" className="mt-1" checked={olderAck} onChange={(e) => setOlderAck(e.target.checked)}
            aria-label="I want to apply this older file over the newer one" />
          <span>
            For a ticked month, this file&apos;s sales stop earlier than the file applied now. Applying rolls that month
            back to this file&apos;s older data. I want to apply it anyway.
          </span>
        </label>
      )}

      {canAct ? (
        <div className="flex flex-wrap items-start gap-3">
          <Button variant="primary" onClick={apply} loading={applying} data-testid="sales-import-apply"
            disabled={blockers.length > 0 || busy} aria-describedby={applyWhy ? 'sales-import-apply-why' : undefined}>
            Apply {selected.size > 0 ? `${selected.size} month${selected.size > 1 ? 's' : ''}` : ''}
          </Button>
          {applyWhy && <span id="sales-import-apply-why" className="sr-only">{applyWhy}</span>}
          {showBlockers && (
            <ul className="text-xs text-gray-600 list-disc pl-4" data-testid="sales-import-apply-blockers">
              {blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          )}
          {heldBack.length > 0 && (
            <div className="text-xs text-gray-600 min-w-0" data-testid="sales-import-unavailable-months">
              <p className="font-medium text-gray-700">Not available:</p>
              <ul className="list-disc pl-4">
                {heldBack.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-gray-500" data-testid="sales-import-apply-denied">
          You can view this preview, but you don&apos;t have permission to apply sales files.
        </p>
      )}

      {!results && !jobRunning && lastResults.length > 0 && (
        <div className="space-y-2" data-testid="sales-import-last-results">
          <p className="text-xs font-medium text-gray-700">Last apply from this file</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {lastResults.map(({ month, job: lj }) => {
              const ok = lj.status === 'DONE' && lj.result?.ok !== false;
              return (
                <div key={month} className={`rounded-xl border px-4 py-3 text-sm ${ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}
                  data-testid={`last-result-${month}`}>
                  <p className="font-semibold flex items-center gap-1.5">
                    {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                    {monthLabel(month)}: {ok ? 'applied' : 'not applied'}
                  </p>
                  <p className="text-xs text-gray-700 mt-1">
                    By {lj.requestedBy}, {lj.finishedAt ? `finished ${whenLabel(lj.finishedAt)}` : `started ${whenLabel(lj.createdAt)}`}.
                    {ok
                      ? (lj.result?.outletsWritten !== undefined ? ` ${formatCount(lj.result.outletsWritten)} outlets updated, ${formatCount(lj.result.outletsZeroFilled ?? 0)} set to 0.` : '')
                      : ` ${lj.result?.error ?? 'No reason was given.'}`}
                  </p>
                  {ok && <DayDataNotice month={month} dayData={lj.result?.dayData} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {results && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="sales-import-apply-results">
          {results.map((r) => (
            <div key={r.month} className={`rounded-xl border px-4 py-3 text-sm ${r.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
              <p className="font-semibold flex items-center gap-1.5">
                {r.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                {monthLabel(r.month)}: {r.ok ? 'applied' : 'not applied'}
              </p>
              {r.ok && !r.applyId && r.outletsWritten === undefined ? (
                <p className="text-xs text-gray-700 mt-1">Applied. Targets cards and dashboards now show these numbers.</p>
              ) : r.ok ? (
                <>
                  <p className="text-xs text-gray-700 mt-1">
                    {formatCount(r.outletsWritten ?? 0)} outlets updated, {formatCount(r.outletsZeroFilled ?? 0)} set to 0. Targets
                    cards and dashboards now show these numbers.
                  </p>
                  <DayDataNotice month={r.month} dayData={r.dayData} />
                </>
              ) : (
                <p className="text-xs text-red-700 mt-1">{r.error ?? 'Unknown error'}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SalesImportDetailPage() {
  const params = useParams();
  const router = useRouter();
  const importId = (Array.isArray(params.id) ? params.id[0] : params.id) as string | undefined;
  const { detail: d, error, queuedTooLong, refresh } = useImportDetail(importId);
  const { ready, has } = usePermissions();
  const canAct = ready && has('targets:upload');
  const canConfigure = ready && has('targets:manage_config');
  const [busy, setBusy] = useState<'reprocess' | 'reprocess-new' | 'delete' | 'cancel' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** A-L6 / B-M8: why Reprocess / Read again / Cancel / Delete are held (an apply of this file is queued or running). */
  const [heldWhy, setHeldWhy] = useState<string | null>(null);

  async function reprocess() {
    if (!importId || busy) return;
    setBusy('reprocess');
    setActionError(null);
    const r = await salesImportApi.reprocess(importId);
    setBusy(null);
    if (!r.success) {
      setActionError(outcomeUnknown(r)
        ? `We couldn’t confirm whether the file was sent for reprocessing: ${noAnswerReason(r)}. The page has been refreshed — check the status above before pressing Reprocess again.`
        : `Not reprocessed: ${reasonOr(r.error, 'the server refused it without a reason')}.`);
      refresh();
      return;
    }
    refresh();
  }

  async function reprocessAsNew() {
    if (!importId || busy) return;
    if (!window.confirm(
      'Read this file again as a NEW import with the current column mapping?\n\nThis import stays as the record of ' +
      'what was already applied. The new import is processed and previewed separately; nothing is applied until you ' +
      'apply it.',
    )) return;
    setBusy('reprocess-new');
    setActionError(null);
    const r = await salesImportApi.reprocessAsNew(importId);
    setBusy(null);
    if (!r.success) {
      setActionError(outcomeUnknown(r)
        ? `We couldn’t confirm whether a new import was started: ${noAnswerReason(r)}. Check All imports for a new import of this file before trying again.`
        : `Not started: ${reasonOr(r.error, 'the server refused it without a reason')}.`);
      refresh();
      return;
    }
    // B-M1: a success whose body was empty carries no id — say so instead of crashing.
    if (!r.data?.id) { setActionError('A new import was started, but its link was not received. Open All imports to find it.'); refresh(); return; }
    router.push(`/admin/sales-import/${r.data.id}`);
  }

  async function cancel() {
    if (!importId || busy) return;
    if (!window.confirm('Cancel processing this file? Nothing from it will be imported. You can upload it again later.')) return;
    setBusy('cancel');
    setActionError(null);
    const r = await salesImportApi.cancel(importId);
    setBusy(null);
    if (!r.success) {
      setActionError(outcomeUnknown(r)
        ? `We couldn’t confirm whether processing was cancelled: ${noAnswerReason(r)}. The page has been refreshed — check the status above before trying again.`
        : `Not cancelled: ${reasonOr(r.error, 'the server refused it without a reason')}.`);
    }
    refresh();
  }

  async function remove() {
    if (!importId || busy) return;
    if (!window.confirm('Delete this import? The uploaded file and its preview are removed. Imports that were already applied cannot be deleted.')) return;
    setBusy('delete');
    setActionError(null);
    const r = await salesImportApi.remove(importId);
    setBusy(null);
    if (!r.success) {
      setActionError(outcomeUnknown(r)
        ? `We couldn’t confirm whether this import was deleted: ${noAnswerReason(r)}. The page has been refreshed — if the import still shows, try again.`
        : `Not deleted: ${reasonOr(r.error, 'the server refused it without a reason')}.`);
      refresh();
      return;
    }
    router.push('/admin/sales-import');
  }

  if (!d) {
    if (error) {
      return (
        <div className="space-y-3">
          <Banner tone="red">{error.text}</Banner>
          {!error.final && <p className="text-xs text-gray-500">Still trying…</p>}
          <Link href="/admin/sales-import" className="text-sm text-[var(--brand-primary)] underline">Back to imports</Link>
        </div>
      );
    }
    return <div className="py-10 flex justify-center"><Spinner size="lg" /></div>;
  }

  const purged = Boolean(d.purgedAt);

  return (
    <div className="space-y-5 pb-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/sales-import" className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1">
            <ArrowLeft className="w-3.5 h-3.5" /> All imports
          </Link>
          <h1 className="text-lg font-semibold text-gray-900 break-all mt-1">{d.originalFilename}</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            <span className={`mr-2 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_CHIP[d.status]}`}>{STATUS_LABEL[d.status]}</span>
            {formatBytes(d.sizeBytes)} · uploaded by {d.uploadedBy} · {dateTimeLabel(d.createdAt)}
            {d.status === 'READY' && ` · ${formatCount(d.rowsRead)} rows read, ${formatCount(d.rowsSkipped)} skipped`}
          </p>
        </div>
        {canAct && (
          <div className="flex gap-2">
            {d.canCancel && (
              <Button size="sm" variant="outline" onClick={cancel} loading={busy === 'cancel'} data-testid="sales-import-cancel" disabled={!!heldWhy} aria-describedby={heldWhy ? 'sales-import-held-why' : undefined}>
                <Ban className="w-3.5 h-3.5" /> Cancel processing
              </Button>
            )}
            {d.canReprocessAsNew && (
              <Button size="sm" variant="outline" onClick={reprocessAsNew} loading={busy === 'reprocess-new'} data-testid="sales-import-reprocess-as-new" disabled={!!heldWhy} aria-describedby={heldWhy ? 'sales-import-held-why' : undefined}>
                <Copy className="w-3.5 h-3.5" /> Read again as a new import
              </Button>
            )}
            {d.canReprocess && d.status !== 'NEEDS_MAPPING' && (
              <Button size="sm" variant="outline" onClick={reprocess} loading={busy === 'reprocess'} disabled={!!heldWhy} aria-describedby={heldWhy ? 'sales-import-held-why' : undefined}>
                <RefreshCw className="w-3.5 h-3.5" /> Reprocess
              </Button>
            )}
            {d.canDelete && (
              <Button size="sm" variant="ghost" onClick={remove} loading={busy === 'delete'} className="text-red-600" disabled={!!heldWhy} aria-describedby={heldWhy ? 'sales-import-held-why' : undefined}>
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <Banner tone={error.final ? 'red' : 'amber'}>
          {error.final ? error.text : `Lost contact with the server (${error.text}). Still trying…`}
        </Banner>
      )}
      {actionError && <Banner tone="red">{actionError}</Banner>}
      {canAct && heldWhy && (
        <p id="sales-import-held-why" className="text-xs text-gray-600" data-testid="sales-import-held-why">
          Reprocess, Cancel and Delete are not available: {heldWhy}
        </p>
      )}

      {d.reprocessedFromId && (
        <Banner tone="blue" testId="sales-import-reprocessed-from">
          This import re-reads the file of an earlier, already-applied import with the current column mapping.{' '}
          <Link href={`/admin/sales-import/${d.reprocessedFromId}`} className="underline">Open the original import</Link>.
        </Banner>
      )}

      {d.duplicateOfId && d.duplicateOfId !== d.reprocessedFromId && (
        <Banner tone="blue" testId="sales-import-duplicate">
          <span className="inline-flex items-center gap-1.5"><Copy className="w-4 h-4" /> This is the same file as an earlier upload.</span>{' '}
          <Link href={`/admin/sales-import/${d.duplicateOfId}`} className="underline">Open the earlier import</Link>.
          Applying it gives the numbers of that earlier file. If a newer file has been applied since, applying this one
          would roll those months back — compare &ldquo;This file&rdquo; with &ldquo;Applied now&rdquo; for each month below.
        </Banner>
      )}

      {purged && d.status !== 'CANCELLED' && (
        <Banner tone="amber" testId="sales-import-purged">
          This file&apos;s data was removed on {dateTimeLabel(d.purgedAt)} (files are kept for a limited time), so it can
          no longer be previewed, applied or reprocessed. Upload the file again if you need it.
        </Banner>
      )}

      {d.status === 'UPLOADING' && <UploadingCard d={d} />}
      {isActiveStatus(d.status) && <ProcessingCard d={d} queuedTooLong={queuedTooLong} />}
      {d.status === 'NEEDS_MAPPING' && (
        <NeedsMappingCard d={d} onReprocess={reprocess} busy={busy === 'reprocess'} canAct={canAct} canConfigure={canConfigure} />
      )}
      {d.status === 'FAILED' && (
        <Banner tone="red" testId="sales-import-failed">
          Processing failed: {sentence(d.error) || 'unknown error'}.{' '}
          {canAct && d.canReprocess
            ? 'Fix the file or the column mapping, then press Reprocess.'
            : 'Ask someone who can upload sales files to fix the file or the column mapping and reprocess it.'}
        </Banner>
      )}
      {d.status === 'CANCELLED' && (
        <Banner tone="amber" testId="sales-import-cancelled">
          This import was cancelled or deleted{purged ? ', and its file was removed' : ''}. Nothing from it was imported.
        </Banner>
      )}

      {(d.errorSamples?.length ?? 0) > 0 && (
        <details className="bg-white rounded-xl border border-gray-200 px-4 py-3">
          <summary className="text-sm font-medium text-gray-800 cursor-pointer">
            {formatCount(d.rowsSkipped)} rows were skipped — show examples
          </summary>
          <table className="text-xs mt-2">
            <thead><tr className="text-left text-gray-500"><th className="pr-4">Row</th><th className="pr-4">Column</th><th>Reason</th></tr></thead>
            <tbody>
              {d.errorSamples!.slice(0, 20).map((e, i) => (
                <tr key={i}><td className="pr-4">{e.row}</td><td className="pr-4">{e.column ?? '—'}</td><td>{e.reason}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-gray-500 mt-2" data-testid="skip-reasons-note">
            A row is skipped when it has no outlet code, an invoice date or amount / cases the portal cannot read, or a
            product value longer than {SALES_IMPORT_MAX_DIM_VALUE_CHARS} characters. Skipped rows are not counted in any
            month.
          </p>
          <Button size="sm" variant="outline" className="mt-2"
            onClick={() => download(salesImportApi.errorsXlsxUrl(d.id), `skipped-rows-${d.id}.xlsx`, setActionError)}>
            <Download className="w-3.5 h-3.5" /> Download all skipped-row examples
          </Button>
        </details>
      )}

      {d.status === 'READY' && !purged && (
        <PreviewSection importId={d.id} onReprocess={reprocess} reprocessing={busy === 'reprocess'} canAct={canAct}
          canReprocess={d.canReprocess} onApplied={refresh} canReprocessAsNew={d.canReprocessAsNew}
          onReprocessAsNew={reprocessAsNew} reprocessingAsNew={busy === 'reprocess-new'} onActiveJob={setHeldWhy} />
      )}
    </div>
  );
}
