'use client';

/**
 * "Recalculate from stored history" for one OPEN month (owner-approved feature). Shows what would be written —
 * every Sales Import KPI recomputed from the month's stored final figures (the lines saved when the month was last
 * applied) with the CURRENT KPI definitions and outlet list — then, after a confirm, applies it. Nothing is
 * re-uploaded. The preview's definitions hash + history version are sent back; a 409 (either changed meanwhile)
 * reloads the preview.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { salesImportApi } from '@/lib/sales-import/api';
import {
  dateTimeLabel, formatCount, formatKpiValue, formatRupees, formatSigned, monthLabel, sentence, warningText,
} from '@/lib/sales-import/format';
import type { SalesMonthRecalcPreview, SalesMonthRecalcResult } from '@/lib/sales-import/types';
import { NO_REPLY, outcomeUnknown, reasonOr } from '@/lib/request-outcome';
import {
  MonthReconciliationPanel, useDimensionLabels, useOutletTypeNames,
} from '../../_components/month-reconciliation-panel';
import { DayDataNotice } from '../../_components/day-data-notice';

export function RecalculatePanel({ month, onClose, onApplied }: {
  month: string;
  onClose(): void;
  /** After a successful recalculation (re-fetch the months). */
  onApplied(): void;
}) {
  const label = monthLabel(month);
  const [preview, setPreview] = useState<SalesMonthRecalcPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<SalesMonthRecalcResult | null>(null);
  /** Recalculated, but the follow-up preview reload failed: the reconciliation shown predates the recalculation. */
  const [staleAfterApply, setStaleAfterApply] = useState(false);
  /** Re-reading the month after a recalculation whose reply never arrived. */
  const [checking, setChecking] = useState(false);
  /** No reply: 'unknown' = the re-read failed too (Recalculate disabled until Check again settles it). */
  const [noReply, setNoReply] = useState<{ before: string | null; state: 'unknown' | 'not-changed' } | null>(null);
  /** Set when the result was confirmed by re-reading (no reply arrived): the month's new last-written time. */
  const [lateAt, setLateAt] = useState<string | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const dims = useDimensionLabels();
  const typeNames = useOutletTypeNames();

  const load = useCallback(async (): Promise<boolean> => {
    const seq = ++seqRef.current;
    const r = await salesImportApi.recalcPreview(month);
    if (!mountedRef.current || seq !== seqRef.current) return false;
    if (r.success) { setPreview(r.data); setError(null); return true; }
    setError(r.status === 404
      ? `${label} has no stored history yet — it is saved each time a sales file is applied to the month.`
      : reasonOr(r.error, NO_REPLY));
    return false;
  }, [month, label]);

  useEffect(() => { void load(); }, [load]);

  /** The month's last-written time (SalesMonthRow.lastAppliedAt; a recalculation moves it), or undefined if unreadable. */
  const readLastWritten = useCallback(async (): Promise<{ at: string | null } | undefined> => {
    const r = await salesImportApi.months(month, month);
    const row = r.success ? r.data.find((x) => x.month === month) : undefined;
    return row ? { at: row.lastAppliedAt } : undefined;
  }, [month]);

  /**
   * After a recalculation whose reply never arrived (proxy / Worker timeout, 5xx, network): the backend may have
   * finished it. Re-read the month and compare its last-written time with the one read just before the click.
   */
  const verify = useCallback(async (before: string | null) => {
    setChecking(true);
    setNotice(null);
    const now = await readLastWritten();
    if (!mountedRef.current) return;
    setChecking(false);
    if (!now) { setNoReply({ before, state: 'unknown' }); return; }
    if (now.at !== before && now.at !== null) {
      setNoReply(null);
      setLateAt(now.at);
      setResult({ month, ok: true });
      onApplied();
      const refreshed = await load();
      if (mountedRef.current && !refreshed) setStaleAfterApply(true);
      return;
    }
    setNoReply({ before, state: 'not-changed' });
    setNotice(`Nothing was changed: ${NO_REPLY}, and checking again shows ${label} still as it was before. If you pressed ` +
      'Recalculate only moments ago the server may still be finishing — press Check again in a minute; if it still shows ' +
      'nothing new, press Try again.');
  }, [label, load, month, onApplied, readLastWritten]);

  async function apply() {
    if (!preview || !preview.canApply || applying || checking || noReply?.state === 'unknown') return;
    const names = preview.kpis.map((k) => k.label || k.kpiCode).join(', ');
    if (!window.confirm(
      `Recalculate ${label} from stored history?\n\nThe Sales Import KPIs${names ? ` (${names})` : ''} are rewritten for every ` +
      `programme outlet from the figures saved on ${dateTimeLabel(preview.historyAppliedAt)}, using today's KPI ` +
      'definitions and outlet list. Nothing is re-uploaded. Other KPIs are not touched.',
    )) return;
    setApplying(true);
    setNotice(null);
    setNoReply(null);
    // What the month's last write is NOW — needed to tell, if no reply arrives, whether the recalculation happened.
    const before = await readLastWritten();
    if (!mountedRef.current) return;
    if (!before) {
      setApplying(false);
      setNotice(`Nothing was changed: ${label} could not be read from the server just now, so nothing was sent. Try again in a moment.`);
      return;
    }
    const r = await salesImportApi.recalculate(month, {
      expectedDefinitionsHash: preview.definitionsHash,
      expectedHistoryAppliedAt: preview.historyAppliedAt,
      ...(preview.reconciliation?.focusFingerprint ? { expectedFocusFingerprint: preview.reconciliation.focusFingerprint } : {}),
    });
    if (!mountedRef.current) return;
    if (!r.success) {
      if (r.status === 403) {
        setApplying(false);
        setNotice('Nothing was changed: you don’t have permission to recalculate months.');
        return;
      }
      if (outcomeUnknown(r)) {
        // No definite answer: the backend may have recalculated anyway → look before saying anything.
        setApplying(false);
        await verify(before.at);
        return;
      }
      const refreshed = await load();
      setApplying(false);
      setNotice(`Nothing was changed: ${reasonOr(r.error, 'the preview is out of date')}. ` + (refreshed
        ? 'The preview has been refreshed — check it and recalculate again.'
        : 'The preview could not be refreshed — close and open it again.'));
      return;
    }
    setApplying(false);
    setResult(r.data);
    if (r.data.ok) {
      onApplied();
      // Reload the preview so "targets were uploaded after the last apply — recalculate" and the like disappear
      // now that the month has been recalculated. If the reload fails, hide the (now stale) reconciliation instead.
      const refreshed = await load();
      if (mountedRef.current && !refreshed) setStaleAfterApply(true);
    }
  }

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
      {checking && (
        <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 flex items-center gap-2"
          data-testid="recalc-checking">
          <Spinner size="sm" /> The server didn&apos;t reply in time. Checking what happened…
        </div>
      )}
      {!checking && noReply?.state === 'unknown' && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" data-testid="recalc-unknown">
          We couldn&apos;t confirm whether {label} was recalculated: {NO_REPLY}, and checking again also failed. Don&apos;t
          recalculate again yet — press Check again.{' '}
          <Button size="sm" variant="outline" className="ml-2" onClick={() => { void verify(noReply.before); }}>Check again</Button>
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="recalc-notice">
          {notice}
          {!checking && noReply?.state === 'not-changed' && (
            <span className="inline-flex gap-2 ml-2">
              <Button size="sm" variant="outline" onClick={() => { void verify(noReply.before); }}>Check again</Button>
              <Button size="sm" variant="outline" onClick={() => { void apply(); }}>Try again</Button>
            </span>
          )}
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
              data-testid="recalc-result" role="status">
              {result.ok && lateAt ? (
                <p className="flex items-start gap-1.5 text-emerald-800" data-testid="recalc-confirmed-late">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {label} recalculated. The server&apos;s reply didn&apos;t arrive in time, so its details (outlets updated,
                    day-by-day figures) were not received; checking again shows {label} was re-written at{' '}
                    {dateTimeLabel(lateAt)}. Don&apos;t recalculate it again.
                  </span>
                </p>
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
                disabled={!preview.canApply || preview.kpis.length === 0 || checking || noReply?.state === 'unknown'}
                data-testid="recalc-apply">
                Recalculate {label}
              </Button>
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
