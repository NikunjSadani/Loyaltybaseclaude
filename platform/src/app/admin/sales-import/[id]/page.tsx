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
import { usePermissions } from '@/lib/use-permissions';
import {
  SALES_IMPORT_ABANDONED_UPLOAD_HOURS, SALES_IMPORT_MAX_DIM_VALUE_CHARS, SALES_IMPORT_STALE_HEARTBEAT_MINUTES,
  type ApplyMonthResult, type MonthPreview, type SalesDimensionMapping, type SalesImportDetail, type SalesImportPreview,
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

    const load = async () => {
      const seq = ++seqRef.current;
      const r = await salesImportApi.get(importId);
      if (cancelled || seq !== seqRef.current) return; // stale response
      if (!r.success) {
        const final = finalErrorText(r.status);
        setError({ text: final ?? r.error, final: final !== null });
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
  return <div role={tone === 'red' ? 'alert' : 'status'} data-testid={testId} className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

async function download(url: string, filename: string, onError: (m: string) => void) {
  const r = await fetchDownload(url);
  if (r.success) downloadBlob(r.data, filename);
  else onError(r.error);
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
  reprocessingAsNew = false,
}: {
  importId: string; onReprocess(): void; reprocessing: boolean; canAct: boolean; canReprocess: boolean;
  /** Applied import whose mapping changed: re-read the stored file as a NEW import. */
  canReprocessAsNew?: boolean; onReprocessAsNew?(): void; reprocessingAsNew?: boolean;
  /** After an apply attempt that changed (or may have changed) server state: refresh the import detail too. */
  onApplied(): void;
}) {
  const [preview, setPreview] = useState<SalesImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [partialAcks, setPartialAcks] = useState<Set<string>>(new Set());
  const [olderAck, setOlderAck] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ApplyMonthResult[] | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const dims = useDimensionLabels();
  const typeNames = useOutletTypeNames();

  /** Loads the preview; resolves true only when THIS load landed successfully (stale / failed → false). */
  const loadPreview = useCallback(async (): Promise<boolean> => {
    const seq = ++seqRef.current;
    setLoading(true);
    const r = await salesImportApi.preview(importId);
    if (!mountedRef.current || seq !== seqRef.current) return false;
    setLoading(false);
    if (r.success) {
      setError(null);
      setPreview(r.data);
      // Drop selections that are no longer applicable after a refresh.
      const ok = new Set(r.data.months.filter((m) => m.canApply).map((m) => m.month));
      setSelected((prev) => new Set([...prev].filter((m) => ok.has(m))));
      return true;
    }
    setError(finalErrorText(r.status) ?? r.error);
    return false;
  }, [importId]);

  useEffect(() => { void loadPreview(); }, [loadPreview, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  if (error && !preview) {
    return (
      <Banner tone="red">
        Couldn&apos;t load the preview: {error}{' '}
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

  function toggle(month: string) {
    setResults(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month); else next.add(month);
      return next;
    });
  }

  async function apply() {
    if (!preview || blockers.length > 0 || applying || !canAct) return;
    const picked = months.filter((m) => selected.has(m.month));
    const names = picked.map((m) => monthLabel(m.month)).join(', ');
    const ok = window.confirm(
      `Apply ${names}?\n\n` +
      `For each month, the Sales Import KPIs${kpiNames.length ? ` (${kpiNames.join(', ')})` : ''} are fully replaced ` +
      'for every programme outlet. Outlets with no sales in the file get 0. Other KPIs are not touched.',
    );
    if (!ok) return;
    setApplying(true);
    setNotice(null);
    setResults(null);
    const partialMonths = picked.filter(isPartialMonth).map((m) => m.month);
    const fingerprints = focusFingerprintsFor(months, selected);
    const r = await salesImportApi.apply(importId, {
      months: picked.map((m) => m.month),
      expectedDefinitionsHash: preview.definitionsHash,
      processingVersion: preview.processingVersion,
      ...(partialMonths.length ? { acknowledgePartialMonths: partialMonths } : {}),
      ...(anyOlder ? { acknowledgeOlderThanLastApplied: true } : {}),
      ...(Object.keys(fingerprints).length ? { expectedFocusFingerprints: fingerprints } : {}),
    });
    if (!r.success) {
      if (r.status === 401) {
        setApplying(false);
        setNotice('Nothing was applied: your session has expired. Sign in again, then apply.');
      } else if (r.status === 403) {
        setApplying(false);
        setNotice('Nothing was applied: you don\u2019t have permission to apply sales files.');
      } else if (r.status !== undefined && r.status >= 400 && r.status < 500) {
        // Any refusal (definitions / processing version changed, a month closed, an ack now needed…) means the
        // preview on screen may be out of date → reload it (and the import) so the admin decides on the current
        // state. Only claim "refreshed" when the reload actually landed.
        onApplied();
        const refreshed = await loadPreview();
        setApplying(false);
        const why = sentence(r.error) || 'the preview is out of date';
        setNotice(refreshed
          ? `Nothing was applied: ${why}. The preview has been refreshed — check it and apply again.`
          : `Nothing was applied: ${why}. The preview could not be refreshed — press Refresh preview before applying again.`);
      } else {
        setApplying(false);
        setNotice(`Nothing was applied: ${sentence(r.error)}. Try again in a moment.`);
      }
      return;
    }
    setApplying(false);
    setResults(r.data.results);
    setSelected(new Set(r.data.results.filter((x) => !x.ok).map((x) => x.month)));
    setPartialAcks(new Set());
    setOlderAck(false);
    onApplied();
    refetch();
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
          Couldn&apos;t refresh the preview: {sentence(error)}. The figures below may be out of date.{' '}
          <Button size="sm" variant="outline" className="ml-2" onClick={refetch}>Retry</Button>
        </Banner>
      )}
      {notice && <Banner tone="amber" testId="sales-import-apply-notice">{notice}</Banner>}
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
                  onRefresh={loadPreview}
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
          <Button variant="primary" onClick={apply} disabled={blockers.length > 0} loading={applying} data-testid="sales-import-apply">
            Apply {selected.size > 0 ? `${selected.size} month${selected.size > 1 ? 's' : ''}` : ''}
          </Button>
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

      {results && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="sales-import-apply-results">
          {results.map((r) => (
            <div key={r.month} className={`rounded-xl border px-4 py-3 text-sm ${r.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
              <p className="font-semibold flex items-center gap-1.5">
                {r.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                {monthLabel(r.month)}: {r.ok ? 'applied' : 'not applied'}
              </p>
              {r.ok ? (
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

  async function reprocess() {
    if (!importId || busy) return;
    setBusy('reprocess');
    setActionError(null);
    const r = await salesImportApi.reprocess(importId);
    setBusy(null);
    if (!r.success) { setActionError(`Not reprocessed: ${sentence(r.error)}.`); refresh(); return; }
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
    if (!r.success) { setActionError(`Not started: ${sentence(r.error)}.`); refresh(); return; }
    router.push(`/admin/sales-import/${r.data.id}`);
  }

  async function cancel() {
    if (!importId || busy) return;
    if (!window.confirm('Cancel processing this file? Nothing from it will be imported. You can upload it again later.')) return;
    setBusy('cancel');
    setActionError(null);
    const r = await salesImportApi.cancel(importId);
    setBusy(null);
    if (!r.success) { setActionError(`Not cancelled: ${sentence(r.error)}.`); }
    refresh();
  }

  async function remove() {
    if (!importId || busy) return;
    if (!window.confirm('Delete this import? The uploaded file and its preview are removed. Imports that were already applied cannot be deleted.')) return;
    setBusy('delete');
    setActionError(null);
    const r = await salesImportApi.remove(importId);
    setBusy(null);
    if (!r.success) { setActionError(`Not deleted: ${sentence(r.error)}.`); refresh(); return; }
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
              <Button size="sm" variant="outline" onClick={cancel} loading={busy === 'cancel'} data-testid="sales-import-cancel">
                <Ban className="w-3.5 h-3.5" /> Cancel processing
              </Button>
            )}
            {d.canReprocessAsNew && (
              <Button size="sm" variant="outline" onClick={reprocessAsNew} loading={busy === 'reprocess-new'} data-testid="sales-import-reprocess-as-new">
                <Copy className="w-3.5 h-3.5" /> Read again as a new import
              </Button>
            )}
            {d.canReprocess && d.status !== 'NEEDS_MAPPING' && (
              <Button size="sm" variant="outline" onClick={reprocess} loading={busy === 'reprocess'}>
                <RefreshCw className="w-3.5 h-3.5" /> Reprocess
              </Button>
            )}
            {d.canDelete && (
              <Button size="sm" variant="ghost" onClick={remove} loading={busy === 'delete'} className="text-red-600">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <Banner tone={error.final ? 'red' : 'amber'}>
          {error.final ? error.text : `Lost contact with the server (${sentence(error.text)}). Still trying…`}
        </Banner>
      )}
      {actionError && <Banner tone="red">{actionError}</Banner>}

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
          onReprocessAsNew={reprocessAsNew} reprocessingAsNew={busy === 'reprocess-new'} />
      )}
    </div>
  );
}
