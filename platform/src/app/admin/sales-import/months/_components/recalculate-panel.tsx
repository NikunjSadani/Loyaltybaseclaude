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
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(async (): Promise<boolean> => {
    const seq = ++seqRef.current;
    const r = await salesImportApi.recalcPreview(month);
    if (!mountedRef.current || seq !== seqRef.current) return false;
    if (r.success) { setPreview(r.data); setError(null); return true; }
    setError(r.status === 404
      ? `${label} has no stored history yet — it is saved each time a sales file is applied to the month.`
      : sentence(r.error));
    return false;
  }, [month, label]);

  useEffect(() => { void load(); }, [load]);

  async function apply() {
    if (!preview || !preview.canApply || applying) return;
    const names = preview.kpis.map((k) => k.label || k.kpiCode).join(', ');
    if (!window.confirm(
      `Recalculate ${label} from stored history?\n\nThe Sales Import KPIs${names ? ` (${names})` : ''} are rewritten for every ` +
      `programme outlet from the figures saved on ${dateTimeLabel(preview.historyAppliedAt)}, using today's KPI ` +
      'definitions and outlet list. Nothing is re-uploaded. Other KPIs are not touched.',
    )) return;
    setApplying(true);
    setNotice(null);
    const r = await salesImportApi.recalculate(month, {
      expectedDefinitionsHash: preview.definitionsHash,
      expectedHistoryAppliedAt: preview.historyAppliedAt,
    });
    if (!mountedRef.current) return;
    if (!r.success) {
      if (r.status === 403) {
        setApplying(false);
        setNotice('Nothing was changed: you don’t have permission to recalculate months.');
        return;
      }
      if (r.status !== undefined && r.status >= 400 && r.status < 500) {
        const refreshed = await load();
        setApplying(false);
        setNotice(`Nothing was changed: ${sentence(r.error) || 'the preview is out of date'}. ` + (refreshed
          ? 'The preview has been refreshed — check it and recalculate again.'
          : 'The preview could not be refreshed — close and open it again.'));
        return;
      }
      setApplying(false);
      setNotice(`Nothing was changed: ${sentence(r.error)}. Try again in a moment.`);
      return;
    }
    setApplying(false);
    setResult(r.data);
    if (r.data.ok) onApplied();
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
      {notice && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="recalc-notice">{notice}</div>}

      {!preview && !error && <div className="py-4 flex items-center gap-2 text-sm text-gray-500"><Spinner size="sm" /> Working out the figures…</div>}

      {preview && (
        <div className="space-y-3" data-testid="recalc-preview">
          <p className="text-xs text-gray-600">
            Stored figures from the file applied {dateTimeLabel(preview.historyAppliedAt)}.{' '}
            <strong>{formatCount(preview.outletsAffected)}</strong> outlet{preview.outletsAffected === 1 ? '' : 's'} would
            change. {formatCount(preview.matchedOutlets)} outlets found in the stored figures
            ({formatRupees(preview.matchedAmountRupees)}); {formatCount(preview.zeroFillOutlets)} programme outlets have no
            lines and get 0; {formatCount(preview.unmatchedCustomers)} customers are not in the programme
            ({formatRupees(preview.unmatchedAmountRupees)}, ignored).
          </p>
          {!preview.canApply && preview.blockedReason && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex gap-2"
              data-testid="recalc-blocked-banner">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span><strong>{label} cannot be recalculated:</strong> {sentence(preview.blockedReason)}.</span>
            </div>
          )}
          {preview.warnings.length > 0 && (
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
              {result.ok ? (
                <p className="flex items-center gap-1.5 text-emerald-800">
                  <CheckCircle2 className="w-4 h-4" /> {label} recalculated: {formatCount(result.outletsWritten ?? 0)} outlets
                  updated, {formatCount(result.outletsZeroFilled ?? 0)} set to 0.
                </p>
              ) : (
                <p className="text-red-700">{label} was not recalculated: {sentence(result.error) || 'unknown error'}.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={apply} loading={applying}
                disabled={!preview.canApply || preview.kpis.length === 0} data-testid="recalc-apply">
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
