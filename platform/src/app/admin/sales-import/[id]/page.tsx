'use client';

/**
 * /admin/sales-import/[id] — one import (SALES-IMPORT-PIPELINE-PLAN §11 F-4).
 *
 * QUEUED/PROCESSING → polls GET :id every 2 s (stale responses dropped via a request sequence; stops on unmount and
 * on a terminal status). NEEDS_MAPPING → detected headings + link to Settings. FAILED → message + Reprocess.
 * READY → the per-month preview: tick OPEN months, acknowledge partial / older-file warnings, Apply.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, Lock, RefreshCw, Trash2, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { downloadBlob } from '@/lib/download';
import { fetchDownload, salesImportApi } from '@/lib/sales-import/api';
import {
  STATUS_CHIP, STATUS_LABEL, WARNING_SHORT, applyBlockers, dateTimeLabel, dayLabel, formatBytes, formatCases,
  formatCount, formatKpiValue, formatRupees, formatSigned, isActiveStatus, isPartialMonth, monthLabel, warningText,
} from '@/lib/sales-import/format';
import type {
  ApplyMonthResult, MonthPreview, SalesImportDetail, SalesImportPreview,
} from '@/lib/sales-import/types';

const POLL_MS = 2000;
const QUEUED_TOO_LONG_MS = 2 * 60 * 1000;

// ── Polling the import ───────────────────────────────────────────────────────

function useImportDetail(importId: string | undefined) {
  const [detail, setDetail] = useState<SalesImportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queuedTooLong, setQueuedTooLong] = useState(false);
  const [tick, setTick] = useState(0);
  const seqRef = useRef(0);
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
        setError(r.status === 404 ? 'This import was not found.' : r.error);
        // Keep polling through a transient error while processing; a 404 is final.
        if (r.status !== 404 && r.status !== 403) timer = setTimeout(load, POLL_MS * 2);
        return;
      }
      setError(null);
      setDetail(r.data);
      if (r.data.status === 'QUEUED') {
        const now = Date.now();
        if (queuedSinceRef.current === null) queuedSinceRef.current = now;
        setQueuedTooLong(now - queuedSinceRef.current > QUEUED_TOO_LONG_MS);
      } else {
        queuedSinceRef.current = null;
        setQueuedTooLong(false);
      }
      if (isActiveStatus(r.data.status)) timer = setTimeout(load, POLL_MS);
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
      {queuedTooLong && (
        <Banner tone="amber" testId="sales-import-queued-long">
          This file has been queued for more than 2 minutes. If it does not start soon, contact Gifsy support.
        </Banner>
      )}
    </section>
  );
}

function NeedsMappingCard({ d, onReprocess, busy }: { d: SalesImportDetail; onReprocess(): void; busy: boolean }) {
  const rows = d.detectedHeaders ?? [];
  return (
    <section className="bg-white rounded-xl border border-amber-200 p-6 space-y-3" data-testid="sales-import-needs-mapping">
      <h2 className="text-sm font-semibold text-gray-900">The portal could not find the columns it needs</h2>
      {d.error && <p className="text-sm text-amber-800">{d.error}</p>}
      <p className="text-sm text-gray-600">
        These are the first rows of the file. Tell the portal which column is the outlet code, invoice date, amount,
        cases and product details, then press Reprocess.
      </p>
      {rows.length > 0 && (
        <div className="overflow-x-auto border border-gray-100 rounded-lg">
          <table className="text-xs">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                  {r.map((c, j) => <td key={j} className="px-2 py-1 whitespace-nowrap text-gray-700">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2">
        <Link href={`/admin/sales-import/settings?fromImport=${encodeURIComponent(d.id)}`}
          className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg bg-[var(--brand-primary)] text-white hover:opacity-90">
          Set up column mapping
        </Link>
        <Button variant="outline" onClick={onReprocess} loading={busy}><RefreshCw className="w-4 h-4" /> Reprocess</Button>
      </div>
    </section>
  );
}

// ── Month preview table ──────────────────────────────────────────────────────

function MonthRow({
  m, selected, onToggle, partialAck, onPartialAck, importId, onDownloadError,
}: {
  m: MonthPreview; selected: boolean; onToggle(): void; partialAck: boolean; onPartialAck(v: boolean): void;
  importId: string; onDownloadError(msg: string): void;
}) {
  const [open, setOpen] = useState(false);
  const partial = isPartialMonth(m);
  const label = monthLabel(m.month);
  return (
    <>
      <tr className="border-b border-gray-100 align-top" data-testid={`month-row-${m.month}`}>
        <td className="px-3 py-2">
          <input
            type="checkbox"
            aria-label={`Apply ${label}`}
            checked={selected}
            disabled={!m.canApply}
            onChange={onToggle}
            title={m.canApply ? undefined : m.blockedReason}
            className="w-4 h-4"
          />
        </td>
        <td className="px-3 py-2">
          <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 font-medium text-gray-900" aria-expanded={open}>
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {label}
          </button>
          <span className={`mt-1 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
            m.monthState === 'CLOSED' ? 'bg-gray-100 text-gray-600 border-gray-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
            {m.monthState === 'CLOSED' && <Lock className="w-3 h-3" />}{m.monthState === 'CLOSED' ? 'Closed' : 'Open'}
          </span>
          {!m.canApply && m.blockedReason && <p className="mt-1 text-xs text-gray-500 max-w-[14rem]">{m.blockedReason}</p>}
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-gray-600">{dayLabel(m.firstDate)} – {dayLabel(m.lastDate)}</td>
        <td className="px-3 py-2 text-right text-gray-600">{formatCount(m.lines)}</td>
        <td className="px-3 py-2 text-right text-gray-600">{formatCount(m.matchedOutlets)}</td>
        <td className="px-3 py-2 text-right text-gray-600">
          {m.unmatchedCustomers > 0 ? (
            <button type="button" className="text-[var(--brand-primary)] underline"
              title="Download the customers in the file that are not programme outlets"
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
              <span key={w} title={warningText(w, m)}
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                  w === 'ROSTER_CHANGED' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                {WARNING_SHORT[w]}
              </span>
            ))}
          </div>
        </td>
      </tr>
      {(partial || open) && (
        <tr className="border-b border-gray-100 bg-gray-50/50">
          <td />
          <td colSpan={8} className="px-3 py-3 space-y-3">
            {m.warnings.length > 0 && (
              <ul className="space-y-1">
                {m.warnings.map((w) => (
                  <li key={w} className="text-xs text-amber-800 flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{warningText(w, m)}</li>
                ))}
              </ul>
            )}
            {partial && m.canApply && (
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
                  {m.lastApplied ? ` Last applied ${dateTimeLabel(m.lastApplied.at)} by ${m.lastApplied.byName}.` : ' Never applied from a sales file.'}
                </p>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function PreviewSection({ importId, onReprocess, reprocessing }: { importId: string; onReprocess(): void; reprocessing: boolean }) {
  const [preview, setPreview] = useState<SalesImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [partialAcks, setPartialAcks] = useState<Set<string>>(new Set());
  const [olderAck, setOlderAck] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ApplyMonthResult[] | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const seq = ++seqRef.current;
    setError(null);
    salesImportApi.preview(importId).then((r) => {
      if (cancelled || seq !== seqRef.current) return;
      if (r.success) {
        setPreview(r.data);
        // Drop selections that are no longer applicable after a refresh.
        const ok = new Set(r.data.months.filter((m) => m.canApply).map((m) => m.month));
        setSelected((prev) => new Set([...prev].filter((m) => ok.has(m))));
      } else setError(r.error);
    });
    return () => { cancelled = true; };
  }, [importId, tick]);

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
  const blockers = applyBlockers(months, selected, partialAcks, olderAck);
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
    if (!preview || blockers.length > 0 || applying) return;
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
    const r = await salesImportApi.apply(importId, {
      months: picked.map((m) => m.month),
      expectedDefinitionsHash: preview.definitionsHash,
      ...(partialMonths.length ? { acknowledgePartialMonths: partialMonths } : {}),
      ...(anyOlder ? { acknowledgeOlderThanLastApplied: true } : {}),
    });
    setApplying(false);
    if (!r.success) {
      if (r.status === 409) {
        setNotice(`Nothing was applied: ${r.error || 'the KPI definitions changed'}. The preview has been refreshed — check it and apply again.`);
        refetch();
      } else {
        setNotice(`Nothing was applied: ${r.error}`);
      }
      return;
    }
    setResults(r.data.results);
    setSelected(new Set(r.data.results.filter((x) => !x.ok).map((x) => x.month)));
    setPartialAcks(new Set());
    setOlderAck(false);
    refetch();
  }

  return (
    <section className="space-y-4" data-testid="sales-import-preview">
      {!preview.rosterHashMatches && (
        <Banner tone="red" testId="sales-import-roster-changed">
          The outlet list changed after this file was processed, so it cannot be applied as-is.{' '}
          <Button size="sm" variant="outline" className="ml-2" onClick={onReprocess} loading={reprocessing}>
            <RefreshCw className="w-3.5 h-3.5" /> Reprocess
          </Button>
        </Banner>
      )}
      {notice && <Banner tone="amber" testId="sales-import-apply-notice">{notice}</Banner>}
      {downloadError && <Banner tone="red">{downloadError}</Banner>}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Months in this file</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Tick the months to update. Each ticked month is replaced completely by this file. Only open months can be
            ticked; a closed month needs Gifsy to reopen it. Open months can still change, so compute points only after
            closing the month under <Link href="/admin/sales-import/months" className="underline">Months</Link>.
          </p>
        </div>
        {months.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500">No usable invoice lines were found in this file.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 bg-gray-50 border-b border-gray-200">
                <th className="px-3 py-2 w-8"><span className="sr-only">Apply</span></th>
                <th className="px-3 py-2 font-medium">Month</th>
                <th className="px-3 py-2 font-medium">Dates</th>
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
                  selected={selected.has(m.month)}
                  onToggle={() => toggle(m.month)}
                  partialAck={partialAcks.has(m.month)}
                  onPartialAck={(v) => setPartialAcks((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(m.month); else next.delete(m.month);
                    return next;
                  })}
                  onDownloadError={setDownloadError}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {anyOlder && (
        <label className="flex items-start gap-2 text-sm text-gray-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <input type="checkbox" className="mt-1" checked={olderAck} onChange={(e) => setOlderAck(e.target.checked)}
            aria-label="I want to apply this older file over the newer one" />
          <span>This file is older than the file last applied to a ticked month. I want to apply it anyway and replace the newer numbers.</span>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={apply} disabled={blockers.length > 0} loading={applying} data-testid="sales-import-apply">
          Apply {selected.size > 0 ? `${selected.size} month${selected.size > 1 ? 's' : ''}` : ''}
        </Button>
        {selected.size > 0 && blockers.length > 0 && (
          <ul className="text-xs text-gray-600 list-disc pl-4" data-testid="sales-import-apply-blockers">
            {blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        )}
      </div>

      {results && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="sales-import-apply-results">
          {results.map((r) => (
            <div key={r.month} className={`rounded-xl border px-4 py-3 text-sm ${r.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
              <p className="font-semibold flex items-center gap-1.5">
                {r.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                {monthLabel(r.month)}: {r.ok ? 'applied' : 'not applied'}
              </p>
              {r.ok ? (
                <p className="text-xs text-gray-700 mt-1">
                  {formatCount(r.outletsWritten ?? 0)} outlets updated, {formatCount(r.outletsZeroFilled ?? 0)} set to 0. Targets
                  cards and dashboards now show these numbers.
                </p>
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
  const [busy, setBusy] = useState<'reprocess' | 'delete' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function reprocess() {
    if (!importId || busy) return;
    setBusy('reprocess');
    setActionError(null);
    const r = await salesImportApi.reprocess(importId);
    setBusy(null);
    if (!r.success) { setActionError(r.error); return; }
    refresh();
  }

  async function remove() {
    if (!importId || busy) return;
    if (!window.confirm('Delete this import? The uploaded file and its preview are removed. Imports that were already applied cannot be deleted.')) return;
    setBusy('delete');
    setActionError(null);
    const r = await salesImportApi.remove(importId);
    setBusy(null);
    if (!r.success) { setActionError(r.error); return; }
    router.push('/admin/sales-import');
  }

  if (!d) {
    if (error) {
      return (
        <div className="space-y-3">
          <Banner tone="red">{error}</Banner>
          <Link href="/admin/sales-import" className="text-sm text-[var(--brand-primary)] underline">Back to imports</Link>
        </div>
      );
    }
    return <div className="py-10 flex justify-center"><Spinner size="lg" /></div>;
  }

  const canReprocess = d.status === 'READY' || d.status === 'NEEDS_MAPPING' || d.status === 'FAILED';

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
        <div className="flex gap-2">
          {canReprocess && d.status !== 'NEEDS_MAPPING' && (
            <Button size="sm" variant="outline" onClick={reprocess} loading={busy === 'reprocess'}>
              <RefreshCw className="w-3.5 h-3.5" /> Reprocess
            </Button>
          )}
          {!isActiveStatus(d.status) && (
            <Button size="sm" variant="ghost" onClick={remove} loading={busy === 'delete'} className="text-red-600">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </Button>
          )}
        </div>
      </div>

      {error && <Banner tone="amber">Lost contact with the server ({error}). Still trying…</Banner>}
      {actionError && <Banner tone="red">{actionError}</Banner>}

      {d.duplicateOfId && (
        <Banner tone="blue" testId="sales-import-duplicate">
          <span className="inline-flex items-center gap-1.5"><Copy className="w-4 h-4" /> This is the same file as an earlier upload.</span>{' '}
          <Link href={`/admin/sales-import/${d.duplicateOfId}`} className="underline">Open the earlier import</Link>. Applying it again
          gives the same numbers, so it is harmless.
        </Banner>
      )}

      {d.status === 'UPLOADING' && (
        <Banner tone="amber">This upload did not finish. Delete it and upload the file again.</Banner>
      )}
      {isActiveStatus(d.status) && <ProcessingCard d={d} queuedTooLong={queuedTooLong} />}
      {d.status === 'NEEDS_MAPPING' && <NeedsMappingCard d={d} onReprocess={reprocess} busy={busy === 'reprocess'} />}
      {d.status === 'FAILED' && (
        <Banner tone="red" testId="sales-import-failed">
          Processing failed: {d.error ?? 'unknown error'}. Fix the file or the column mapping, then press Reprocess.
        </Banner>
      )}
      {d.status === 'CANCELLED' && <Banner tone="amber">This import was cancelled.</Banner>}

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
          <Button size="sm" variant="outline" className="mt-2"
            onClick={() => download(salesImportApi.errorsXlsxUrl(d.id), `skipped-rows-${d.id}.xlsx`, setActionError)}>
            <Download className="w-3.5 h-3.5" /> Download all skipped-row examples
          </Button>
        </details>
      )}

      {d.status === 'READY' && <PreviewSection importId={d.id} onReprocess={reprocess} reprocessing={busy === 'reprocess'} />}
    </div>
  );
}
