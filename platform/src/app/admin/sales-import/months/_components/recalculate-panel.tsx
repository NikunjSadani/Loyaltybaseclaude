'use client';

/**
 * "Recalculate from stored history" for one OPEN month (owner-approved feature). Shows what would be written —
 * every Sales Import KPI recomputed from the month's stored final figures (the lines saved when the month was last
 * applied) with the CURRENT KPI definitions and outlet list — then, after a confirm, applies it. Nothing is
 * re-uploaded. The preview's definitions hash + history version are sent back; a 409 (either changed meanwhile)
 * reloads the preview. Since 2026-11-18 the recalculation runs as a BACKGROUND job (the POST answers 202 with the job;
 * the page follows it); with no clear answer the click is looked up by its requestId — never guessed.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { salesImportApi } from '@/lib/sales-import/api';
import {
  dateTimeLabel, formatCount, formatKpiValue, formatRupees, formatSigned, monthLabel, sentence, warningText,
} from '@/lib/sales-import/format';
import type {
  ApplyMonthResult, SalesApplyJobDto, SalesMonthActiveJob, SalesMonthRecalcPreview, SalesMonthRecalcRequest,
} from '@/lib/sales-import/types';
import { failureReason, outcomeUnknown } from '@/lib/request-outcome';
import {
  JOB_QUEUED_TOO_LONG_MS, clearUnknown, jobEnded, jobHeadline, loadUnknown, lookUp, monthProgressText, monthResult,
  newRequestId, resolveSubmit, resultsSummary, saveUnknown, useJobFollower, whenLabel, type SubmitOutcome, type UnknownLock,
} from '@/lib/sales-import/apply-job';
import {
  MonthReconciliationPanel, useDimensionLabels, useOutletTypeNames,
} from '../../_components/month-reconciliation-panel';
import { NotCalculatedAck } from '../../_components/not-calculated-ack';
import { DayDataNotice } from '../../_components/day-data-notice';

/** The pre-release synchronous recalculate answer (one ApplyMonthResult) — still accepted during a deploy. */
function legacyResult(data: unknown): ApplyMonthResult[] | null {
  return data && typeof data === 'object' && 'ok' in (data as object) ? [data as ApplyMonthResult] : null;
}

export function RecalculatePanel({ month, onClose, onApplied, activeJob = null, listVersion = 0 }: {
  month: string;
  onClose(): void;
  /** The month's queued / running Apply or Recalculate (SalesMonthRow.activeJob): followed until it ends. */
  activeJob?: SalesMonthActiveJob | null;
  /** Bumped by the Months page on every successful list read (final review L5: "the list has confirmed"). */
  listVersion?: number;
  /** After a successful recalculation (re-fetch the months). */
  onApplied(): void;
}) {
  const label = monthLabel(month);
  const [preview, setPreview] = useState<SalesMonthRecalcPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The POST is in flight. */
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyMonthResult | null>(null);
  /** Recalculated, but the follow-up preview reload failed: the reconciliation shown predates the recalculation. */
  const [staleAfterApply, setStaleAfterApply] = useState(false);
  /** Looking the click up by its requestId after no clear answer. */
  const [checking, setChecking] = useState(false);
  /** No clear answer and the lookup failed too → Recalculate disabled until Check again settles it. */
  const unknownKey = `sales-recalc-unknown:${month}`;
  // B-L8: an unknown outcome survives a reload (Recalculate stays held until Check again settles it).
  const [unknown, setUnknownState] = useState<UnknownLock | null>(() => (typeof window === 'undefined' ? null : loadUnknown(unknownKey)));
  const setUnknown = useCallback((u: UnknownLock | null) => {
    setUnknownState(u);
    if (u) saveUnknown(unknownKey, u); else clearUnknown(unknownKey);
  }, [unknownKey]);
  const outcomeRef = useRef<HTMLDivElement | null>(null);
  const focusOutcome = () => { setTimeout(() => outcomeRef.current?.focus(), 0); };
  /** The lookup says the click recorded nothing → Try again resends the SAME request (same requestId: harmless). */
  const [notRecorded, setNotRecorded] = useState(false);
  /** FOCUS-NAMES-FROM-KPI: the admin accepted the not-calculated KPIs of this month (required to recalculate). */
  const [ncAck, setNcAck] = useState(false);
  const lastSent = useRef<SalesMonthRecalcRequest | null>(null);
  /** The month's job this panel shows (this click's, or the one already running when it opened). */
  const [jobId, setJobId] = useState<string | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const dims = useDimensionLabels();
  const typeNames = useOutletTypeNames();

  /** true when this load landed OR a newer one superseded it (L8: a superseded load is not a failure). */
  const load = useCallback(async (): Promise<boolean> => {
    const seq = ++seqRef.current;
    const r = await salesImportApi.recalcPreview(month);
    if (!mountedRef.current || seq !== seqRef.current) return true;
    if (r.success) { setPreview(r.data); setError(null); return true; }
    setError(r.status === 404
      ? `${label} has no stored history yet — it is saved each time a sales file is applied to the month.`
      : failureReason(r));
    return false;
  }, [month, label]);

  useEffect(() => { void load(); }, [load]);

  const onJobEnded = useCallback(async (job: SalesApplyJobDto) => {
    if (!mountedRef.current) return;
    onApplied();
    if (job.kind !== 'RECALC' || !job.months.some((m) => m.month === month)) { void load(); return; }
    const res = monthResult(job, month);
    setResult(res);
    // Reload the preview so "targets were uploaded after the last apply — recalculate" and the like disappear now that
    // the month has been recalculated. If the reload fails, hide the (now stale) reconciliation instead.
    const refreshed = await load();
    if (mountedRef.current && res?.ok && !refreshed) setStaleAfterApply(true);
  }, [load, month, onApplied]);
  const { jobs, problems, follow } = useJobFollower(onJobEnded);

  // Opened while an Apply / Recalculate of this month is queued or running → follow it (refresh-safe, several admins).
  useEffect(() => {
    if (!activeJob) return;
    follow(activeJob.jobId);
    setJobId((cur) => cur ?? activeJob.jobId);
  }, [activeJob, follow]);

  const job = jobId ? jobs[jobId] ?? null : null;
  const followProblem = jobId ? problems[jobId] ?? null : null;
  // Re-review L6: a FINAL 401 / 403 / 404 while following ends the wait (the message says why) and re-enables
  // Recalculate — never "Waiting for it to finish" forever.
  const jobRunning = !followProblem?.final && ((!!job && !jobEnded(job)) || (!!activeJob && !job));
  // Final review L5: after a FINAL 401 / 403 / 404 the recalculation may still be running. Re-read the Months list and
  // keep Recalculate held until a list read made AFTER the stop shows no active job for this month.
  const [stoppedAtList, setStoppedAtList] = useState<number | null>(null);
  useEffect(() => {
    if (followProblem?.final && stoppedAtList === null) { setStoppedAtList(listVersion); onApplied(); }
  }, [followProblem?.final, stoppedAtList, listVersion, onApplied]);
  const awaitingList = stoppedAtList !== null && (listVersion === stoppedAtList || !!activeJob);
  const busy = applying || checking || !!unknown || jobRunning || awaitingList;
  const queuedTooLong = !!job && job.status === 'QUEUED' && job.attempts === 0 && Date.now() - Date.parse(job.createdAt) > JOB_QUEUED_TOO_LONG_MS;
  const progress = job ? job.months.map((m) => monthProgressText(job, m.month, monthLabel(m.month))).join('. ') : '';
  const problem = followProblem;
  const ncItems = preview?.reconciliation?.notCalculated ?? [];
  const ncNeedsAck = ncItems.length > 0 && !ncAck;

  async function apply() {
    if (!preview || !preview.canApply || busy || ncNeedsAck) return;
    const names = preview.kpis.map((k) => k.label || k.kpiCode).join(', ');
    if (!window.confirm(
      `Recalculate ${label} from stored history?\n\nThe Sales Import KPIs${names ? ` (${names})` : ''} are rewritten for every ` +
      `programme outlet from the figures saved on ${dateTimeLabel(preview.historyAppliedAt)}, using today's KPI ` +
      'definitions and outlet list. Nothing is re-uploaded. Other KPIs are not touched. It runs in the background.',
    )) return;
    await send({
      expectedDefinitionsHash: preview.definitionsHash,
      expectedHistoryAppliedAt: preview.historyAppliedAt,
      ...(preview.reconciliation?.focusFingerprint ? { expectedFocusFingerprint: preview.reconciliation.focusFingerprint } : {}),
      ...(ncItems.length > 0 ? { confirmNotCalculated: true } : {}),
      requestId: newRequestId(),
    });
  }

  async function send(req: SalesMonthRecalcRequest) {
    lastSent.current = req;
    setApplying(true);
    setNotice(null);
    setResult(null);
    setUnknown(null);
    setNotRecorded(false);
    const r = await salesImportApi.recalculate(month, req);
    if (!mountedRef.current) return;
    if (!r.success && !outcomeUnknown(r)) {
      setApplying(false);
      await refused(r.status, failureReason(r));
      focusOutcome();
      return;
    }
    if (!r.success) setChecking(true);
    const out = await resolveSubmit(r, req.requestId!, legacyResult);
    if (!mountedRef.current) return;
    setApplying(false);
    setChecking(false);
    await settle(out, req.requestId!);
  }

  async function settle(out: SubmitOutcome, requestId: string) {
    focusOutcome();
    if (out.kind === 'job') {
      setUnknown(null);
      setJobId(out.job.id);
      follow(out.job.id, out.job);
      onApplied();
      if (out.afterNoAnswer) setNotice('The server’s first reply didn’t come through, but the recalculation was recorded — its progress is shown below. Don’t recalculate again.');
    } else if (out.kind === 'legacy') {
      const res = out.results[0];
      setResult(res);
      if (res.ok) {
        onApplied();
        const refreshed = await load();
        if (mountedRef.current && !refreshed) setStaleAfterApply(true);
      }
    } else if (out.kind === 'refused') {
      await refused(out.status, out.reason);
    } else if (out.kind === 'not-recorded') {
      setNotRecorded(true);
      setNotice(`Nothing was changed: ${out.reason}, and nothing was recorded for this click. Try again.`);
    } else {
      setUnknown({ requestId, reason: out.reason, months: [month] });
    }
  }

  async function refused(status: number | undefined, reason: string) {
    if (status === 401) { setNotice('Nothing was changed: your session has expired. Sign in again, then recalculate.'); return; } // B-L12
    if (status === 403) { setNotice('Nothing was changed: you don’t have permission to recalculate months.'); return; }
    const refreshed = await load();
    onApplied();
    setNotice(`Nothing was changed: ${reason}. ` + (refreshed
      ? 'The preview has been refreshed — check it and recalculate again.'
      : 'The preview could not be refreshed — close and open it again.'));
  }

  async function checkAgain() {
    if (!unknown) return;
    setChecking(true);
    const out = await lookUp(unknown.requestId, unknown.reason);
    if (!mountedRef.current) return;
    setChecking(false);
    await settle(out, unknown.requestId);
  }

  const recalcWhy = awaitingList ? 'Recalculate is held until the Months list shows the earlier recalculation has finished.'
    : unknown ? 'Recalculate is held until the page can confirm whether the last one was recorded.'
    : jobRunning ? `${label} is being ${job?.kind === 'APPLY' ? 'applied' : 'recalculated'} — wait for it to finish.`
      : checking ? 'Checking what happened to the last recalculation.'
        : ncNeedsAck ? 'Tick the red warning to accept the KPIs that are not calculated this month.' : '';
  // B-M6: the result is announced too (the visible result card has no live role of its own).
  const liveText = checking ? 'Checking what happened to the recalculation…' : jobRunning ? progress
    : result ? resultsSummary([result], monthLabel, 'recalculated') : notice ?? '';

  return (
    <section className="bg-white rounded-xl border border-blue-200 shadow-sm p-5 space-y-4" data-testid={`recalc-panel-${month}`}
      aria-label={`Recalculate ${label} from stored history`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Recalculate {label} from stored history</h2>
          <p className="text-xs text-gray-500 mt-0.5 max-w-3xl">
            Uses the final figures saved when this month was last applied; nothing is re-uploaded. Every Sales Import KPI
            is worked out again with today&apos;s KPI definitions and outlet list — useful after adding or changing a KPI.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close recalculation"><X className="w-3.5 h-3.5" /></Button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" data-testid="recalc-error">
          Couldn&apos;t load the recalculation preview: {error}{' '}
          <Button size="sm" variant="outline" className="ml-2" onClick={() => { void load(); }}>Retry</Button>
        </div>
      )}
      <p className="sr-only" aria-live="polite" data-testid="recalc-live">{liveText}</p>
      <div ref={outcomeRef} tabIndex={-1} className="space-y-4 outline-none" data-testid="recalc-outcome">
      {checking && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 flex items-center gap-2"
          data-testid="recalc-checking">
          <Spinner size="sm" /> No clear answer from the server. Checking what happened…
        </div>
      )}
      {!checking && unknown && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" data-testid="recalc-unknown">
          We couldn&apos;t confirm whether the recalculation of {label} was recorded: {unknown.reason}, and checking also
          failed. Don&apos;t recalculate again yet — press Check again.{' '}
          <Button size="sm" variant="outline" className="ml-2" onClick={() => { void checkAgain(); }}>Check again</Button>
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="recalc-notice">
          {notice}
          {notRecorded && lastSent.current && (
            <Button size="sm" variant="outline" className="ml-2" onClick={() => { void send(lastSent.current!); }}>Try again</Button>
          )}
        </div>
      )}
      </div>
      {problem?.final && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="recalc-job-stopped">
          We couldn&apos;t follow the recalculation — it may still be running; refresh before trying again. ({problem.text})
          {awaitingList && ' Recalculate stays unavailable until the Months list shows it has finished.'}
        </div>
      )}
      {jobRunning && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 space-y-1" data-testid="recalc-job">
          <p className="font-semibold flex items-center gap-2"><Spinner size="sm" />
            {job?.kind === 'APPLY' && job.status !== 'QUEUED' ? `${label} is being applied from a sales file` : job ? jobHeadline(job) : 'Waiting for it to finish'}
          </p>
          {job && <p className="text-xs">Started by {job.requestedBy} at {whenLabel(job.createdAt)}. {progress}. You can close this panel — it carries on.</p>}
          {!job && activeJob && <p className="text-xs">Started by {activeJob.requestedBy} at {whenLabel(activeJob.createdAt)}.</p>}
          {queuedTooLong && (
            <p className="text-xs text-amber-800">The processor has not started yet. It is started again automatically within 10 minutes — don&apos;t recalculate again.</p>
          )}
          {problem && <p role={problem.final ? 'alert' : undefined} className="text-xs text-amber-800" data-testid="recalc-job-problem">{problem.text}</p>}
        </div>
      )}

      {!preview && !error && <div className="py-4 flex items-center gap-2 text-sm text-gray-500"><Spinner size="sm" /> Working out the figures…</div>}

      {preview && (
        <div className="space-y-3" data-testid="recalc-preview">
          <p className="text-xs text-gray-600">
            Stored figures from the file applied {dateTimeLabel(preview.historyAppliedAt)}.{' '}
            <strong>{formatCount(preview.outletsAffected)}</strong> outlet{preview.outletsAffected === 1 ? '' : 's'} would
            change. {formatCount(preview.matchedOutlets)} outlets found in the stored figures
            ({formatRupees(preview.matchedAmountRupees)}); {formatCount(preview.zeroFillOutlets)} programme outlets have no
            lines and get 0; {formatCount(preview.unmatchedCustomers)} customers in the stored figures are not in the
            programme now ({formatRupees(preview.unmatchedAmountRupees)}, ignored). Stored history keeps programme outlets
            only, so customers that were never in the programme are not in these figures.
          </p>
          {!result && <DayDataNotice month={month} dayData={preview.dayData} />}
          {!preview.canApply && preview.blockedReason && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex gap-2"
              data-testid="recalc-blocked-banner">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span><strong>{label} cannot be recalculated:</strong> {sentence(preview.blockedReason)}.</span>
            </div>
          )}
          {staleAfterApply ? (
            <p role="status" className="text-xs text-gray-600" data-testid="recalc-recon-stale">
              {label} was recalculated, but its targets and focus-brand check could not be reloaded — close the
              recalculation and open it again to see them.
            </p>
          ) : (
            <MonthReconciliationPanel month={month} reconciliation={preview.reconciliation}
              measures={Object.fromEntries(preview.kpis.map((k) => [k.kpiCode, k.measure]))} dims={dims} typeNames={typeNames}
              canAct monthOpen={preview.monthState === 'OPEN'} onRefresh={load}
              refreshHint="close the recalculation and open it again before recalculating" />
          )}
          {!staleAfterApply && !result && (
            <NotCalculatedAck month={month} label={label} items={preview.reconciliation?.notCalculated}
              checked={ncAck} onChange={setNcAck} canAct={preview.canApply} />
          )}
          {!staleAfterApply && preview.warnings.length > 0 && (
            <ul className="space-y-1" data-testid="recalc-warnings">
              {preview.warnings.map((w) => (
                <li key={w} className="text-xs text-amber-800 flex gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  {warningText(w, { month, firstDate: `${month}-01`, lastDate: `${month}-01` })}
                </li>
              ))}
            </ul>
          )}
          {preview.kpis.length === 0 ? (
            <p className="text-xs text-gray-500">No KPIs are set up for Sales Import, so there is nothing to recalculate.</p>
          ) : (
            <table className="text-xs w-full max-w-3xl">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-1 pr-3 font-medium">KPI</th>
                  <th className="py-1 pr-3 font-medium text-right">Recalculated</th>
                  <th className="py-1 pr-3 font-medium text-right">Stored now</th>
                  <th className="py-1 pr-3 font-medium text-right">Change</th>
                  <th className="py-1 pr-3 font-medium text-right">Outlets &gt; 0</th>
                  <th className="py-1 font-medium text-right">Negative</th>
                </tr>
              </thead>
              <tbody>
                {preview.kpis.map((k) => (
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

          {result ? (
            <div className={`rounded-lg border px-4 py-3 text-sm ${result.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}
              data-testid="recalc-result">
              {result.ok && result.outletsWritten === undefined ? (
                <p className="flex items-center gap-1.5 text-emerald-800"><CheckCircle2 className="w-4 h-4" /> {label} recalculated.</p>
              ) : result.ok ? (
                <>
                  <p className="flex items-center gap-1.5 text-emerald-800">
                    <CheckCircle2 className="w-4 h-4" /> {label} recalculated: {formatCount(result.outletsWritten ?? 0)} outlets
                    updated, {formatCount(result.outletsZeroFilled ?? 0)} set to 0.
                  </p>
                  <DayDataNotice month={month} dayData={result.dayData} />
                </>
              ) : (
                <p className="text-red-700">{label} was not recalculated: {sentence(result.error) || 'unknown error'}.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={apply} loading={applying}
                disabled={!preview.canApply || preview.kpis.length === 0 || busy || ncNeedsAck}
                aria-describedby={recalcWhy ? 'recalc-apply-why' : undefined}
                data-testid="recalc-apply">
                Recalculate {label}
              </Button>
              {recalcWhy && <span id="recalc-apply-why" className="sr-only">{recalcWhy}</span>}
              {!preview.canApply && preview.blockedReason && (
                <span className="text-xs text-gray-600" data-testid="recalc-blocked">{preview.blockedReason}</span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
