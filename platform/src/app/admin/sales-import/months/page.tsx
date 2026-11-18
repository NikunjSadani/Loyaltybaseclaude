'use client';

/**
 * /admin/sales-import/months — month close / reopen (SALES-IMPORT-PIPELINE-PLAN §7.3, §11 F-5).
 *
 * Close = targets:upload (CLIENT_ADMIN or assumed GIFSY_ADMIN). Reopen = GIFSY_ADMIN only (the button is shown only
 * to GIFSY_ADMIN; the backend enforces the role + assumed tenant). The current month can never be closed.
 * "Recalculate from stored history" (targets:upload): an OPEN month with stored history (hasHistory) can be rewritten
 * from the final figures saved at its last apply, with today's KPI definitions — preview → confirm → apply. A CLOSED
 * month shows the action disabled ("Gifsy must reopen this month first").
 * "Rebuild product list" (targets:upload, §10c): a month with stored history whose product list (the KPI picker's
 * "Stored month(s)" source) is not current (productListCurrent false) — OPEN or CLOSED; it changes no figures.
 * `?from=YYYY-MM[&to=YYYY-MM]` (link from the KPI picker) lists that range so every month it names is shown (read after
 * mount, never in render; `to` is clamped at the current IST month).
 * FOCUS-FROM-TARGETS: `targetsChangedSinceApply` → a "Targets changed — recalculate" badge that opens the Recalculate
 * panel for that month (a plain badge when the month can't be recalculated here).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Calculator, Lock, LockOpen, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAdminSession } from '@/lib/admin-session';
import { salesImportApi } from '@/lib/sales-import/api';
import { dateTimeLabel, monthLabel, sentence } from '@/lib/sales-import/format';
import { NO_REPLY, outcomeUnknown, reasonOr } from '@/lib/request-outcome';
import { usePermissions } from '@/lib/use-permissions';
import type { SalesMonthRow } from '@/lib/sales-import/types';
import { RecalculatePanel } from './_components/recalculate-panel';

export default function SalesMonthsPage() {
  const { role } = useAdminSession();
  const isGifsyAdmin = role === 'GIFSY_ADMIN';
  const [rows, setRows] = useState<SalesMonthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const { ready, has } = usePermissions();
  const canClose = ready && has('targets:upload');
  const [busyMonth, setBusyMonth] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [recalcMonth, setRecalcMonth] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // ?from=&to= from the KPI picker: list that range so every month it names is shown (window / clock read in the effect).
    const qs = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const valid = (m: string | null | undefined) => (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : undefined);
    const from = valid(qs?.get('from'));
    const nowIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
    const rawTo = valid(qs?.get('to'));
    const to = rawTo && from ? (rawTo > nowIst ? nowIst : rawTo) : undefined;
    (from ? (to && to >= from ? salesImportApi.months(from, to) : salesImportApi.months(from)) : salesImportApi.months()).then((r) => {
      if (cancelled) return;
      if (r.success) setRows([...r.data].sort((a, b) => b.month.localeCompare(a.month)));
      else setError(r.error);
    });
    return () => { cancelled = true; };
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  /**
   * An action on a month got NO definite answer (proxy / Worker timeout, 5xx, network) — the backend may have done it
   * anyway. Re-read that month and report what is true now, never "was not …" without looking. Retrying close / reopen /
   * rebuild is harmless (an already-closed month is refused; a rebuild changes no figures).
   */
  async function settleNoReply(row: SalesMonthRow, t: {
    done(now: SalesMonthRow): boolean; doneText: string; notDoneText: string; unknownText: string;
  }) {
    const r = await salesImportApi.months(row.month, row.month);
    const now = r.success ? r.data.find((x) => x.month === row.month) : undefined;
    if (!now) {
      setActionMsg({ tone: 'err', text: t.unknownText });
      reload();
      return;
    }
    setRows((prev) => prev?.map((x) => (x.month === row.month ? now : x)) ?? prev);
    setActionMsg(t.done(now)
      ? { tone: 'ok', text: `${t.doneText} (The server's reply didn't arrive in time; checking again confirmed it.)` }
      : { tone: 'err', text: t.notDoneText });
  }

  async function close(row: SalesMonthRow) {
    if (busyMonth) return;
    const label = monthLabel(row.month);
    const neverImported = row.lastAppliedAt
      ? ''
      : `\n\nNo sales file has ever been applied to ${label}. Close it anyway?`;
    if (!window.confirm(`Closing locks ${label}. Sales files can no longer change it, and points can then be computed. Only Gifsy can reopen it.${neverImported}`)) return;
    setBusyMonth(row.month);
    setActionMsg(null);
    const r = await salesImportApi.closeMonth(row.month);
    const closedText = `${label} is closed. You can now compute points for it in the Points Engine.`;
    if (!r.success && outcomeUnknown(r)) {
      await settleNoReply(row, {
        done: (now) => now.state === 'CLOSED',
        doneText: closedText,
        notDoneText: `${label} was not closed: ${NO_REPLY}, and checking again shows it still open. Press Close again.`,
        unknownText: `We couldn’t confirm whether ${label} was closed: ${NO_REPLY}, and checking again also failed. Refresh this page and check ${label}'s state before trying again.`,
      });
      setBusyMonth(null);
      return;
    }
    setBusyMonth(null);
    if (!r.success) { setActionMsg({ tone: 'err', text: `${label} was not closed: ${reasonOr(r.error, 'the server refused it without a reason')}.` }); reload(); return; }
    setActionMsg({ tone: 'ok', text: closedText });
    setRows((prev) => prev?.map((x) => (x.month === row.month ? r.data : x)) ?? prev);
  }

  async function rebuildProductList(row: SalesMonthRow) {
    if (busyMonth) return;
    const label = monthLabel(row.month);
    if (!window.confirm(`Rebuild the product list for ${label} from its stored sales lines? This only refreshes the list of products the KPI settings offer for ${label} — it doesn't change any figures.`)) return;
    setBusyMonth(row.month);
    setActionMsg(null);
    const r = await salesImportApi.rebuildProductList(row.month);
    if (!r.success && outcomeUnknown(r)) {
      await settleNoReply(row, {
        done: (now) => now.productListCurrent === true,
        doneText: `The product list for ${label} is rebuilt. No figures changed.`,
        notDoneText: `The product list for ${label} was not rebuilt: ${NO_REPLY}, and checking again shows it still out of date. Rebuilding again is safe — it changes no figures.`,
        unknownText: `We couldn’t confirm whether the product list for ${label} was rebuilt: ${NO_REPLY}, and checking again also failed. Refresh this page to check; rebuilding again is safe — it changes no figures.`,
      });
      setBusyMonth(null);
      return;
    }
    setBusyMonth(null);
    if (!r.success) { setActionMsg({ tone: 'err', text: `The product list for ${label} was not rebuilt: ${reasonOr(r.error, 'the server refused it without a reason')}.` }); reload(); return; }
    setActionMsg({ tone: 'ok', text: `The product list for ${label} is rebuilt. No figures changed.` });
    setRows((prev) => prev?.map((x) => (x.month === row.month ? r.data : x)) ?? prev);
  }

  async function reopen(row: SalesMonthRow) {
    if (busyMonth) return;
    const label = monthLabel(row.month);
    const ds = row.downstream ?? { creditBatches: 0, exports: 0 };
    const hasDownstream = ds.creditBatches > 0 || ds.exports > 0;
    const downstreamText = hasDownstream
      ? `\n\nPoints work already exists for ${label}: ${[
        ds.creditBatches ? `${ds.creditBatches} credit batch${ds.creditBatches === 1 ? '' : 'es'}` : '',
        ds.exports ? `${ds.exports} points export${ds.exports === 1 ? '' : 's'} / report download${ds.exports === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' and ')}. If the sales numbers change after reopening, those will no longer match and any ` +
        'difference must go through the existing reversal process. Reopen anyway?'
      : '';
    if (!window.confirm(`Reopen ${label}? Sales files can then change it again. If points were already credited for ${label}, any difference must go through the existing reversal process. This is recorded in the audit log.${downstreamText}`)) return;
    setBusyMonth(row.month);
    setActionMsg(null);
    let r = await salesImportApi.reopenMonth(row.month, hasDownstream ? { acknowledgeDownstream: true } : {});
    // Points work appeared after this page loaded → the server asks for the acknowledgement: confirm once more.
    // Only the downstream-acknowledgement 409 is re-asked ("…needs confirmation: …"); any other 409 (already open,
    // current month…) falls through to the message + re-fetch below.
    if (!r.success && r.status === 409 && !hasDownstream && /needs confirmation/i.test(r.error ?? '')) {
      if (window.confirm(`${reasonOr(r.error, 'Points work exists for this month')}.\n\nReopen ${label} anyway? Points already credited or exported for it may no longer match.`)) {
        r = await salesImportApi.reopenMonth(row.month, { acknowledgeDownstream: true });
      } else {
        setBusyMonth(null);
        reload();
        return;
      }
    }
    if (!r.success && outcomeUnknown(r)) {
      await settleNoReply(row, {
        done: (now) => now.state === 'OPEN',
        doneText: `${label} is open again. Close it once the corrected file is applied.`,
        notDoneText: `${label} was not reopened: ${NO_REPLY}, and checking again shows it still closed. Press Reopen again.`,
        unknownText: `We couldn’t confirm whether ${label} was reopened: ${NO_REPLY}, and checking again also failed. Refresh this page and check ${label}'s state before trying again.`,
      });
      setBusyMonth(null);
      return;
    }
    setBusyMonth(null);
    if (!r.success) { setActionMsg({ tone: 'err', text: `${label} was not reopened: ${reasonOr(r.error, 'the server refused it without a reason')}.` }); reload(); return; }
    const { warnings, ...updated } = r.data;
    const extra = warnings?.length ? ` Check: ${warnings.map(sentence).join('; ')}.` : '';
    setActionMsg({ tone: warnings?.length ? 'warn' : 'ok', text: `${label} is open again. Close it once the corrected file is applied.${extra}` });
    setRows((prev) => prev?.map((x) => (x.month === row.month ? updated : x)) ?? prev);
  }

  return (
    <div className="space-y-5 pb-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Months</h1>
          <p className="text-sm text-gray-500 mt-0.5 max-w-3xl">
            The current month is always open. The previous month stays open until someone closes it; older months are
            closed unless Gifsy reopened them. Close a month once its final sales file is applied — points should only be
            computed for closed months. After adding or changing a KPI, use Recalculate on an open month to fill it from
            the figures stored at its last apply — nothing is re-uploaded.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={reload} aria-label="Refresh months"><RefreshCw className="w-3.5 h-3.5" /> Refresh</Button>
      </div>

      {actionMsg && (
        <div role={actionMsg.tone === 'err' ? 'alert' : 'status'}
          className={`rounded-lg border px-4 py-3 text-sm ${
            actionMsg.tone === 'err' ? 'bg-red-50 border-red-200 text-red-800'
              : actionMsg.tone === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-800'
                : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          {actionMsg.text}
        </div>
      )}

      {recalcMonth && (
        <RecalculatePanel key={recalcMonth} month={recalcMonth} onClose={() => setRecalcMonth(null)} onApplied={reload} />
      )}

      {rows === null ? (
        error ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-3">
            Couldn&apos;t load months: {reasonOr(error, NO_REPLY)}
            <Button size="sm" variant="outline" onClick={reload}>Retry</Button>
          </div>
        ) : (
          <div className="py-10 flex justify-center"><Spinner size="lg" /></div>
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No months to show yet.</p>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-2 font-medium">Month</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Last sales file applied</th>
                <th className="px-4 py-2 font-medium">Closed</th>
                <th className="px-4 py-2 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const label = monthLabel(row.month);
                return (
                  <tr key={row.month} className="border-b border-gray-100" data-testid={`sales-month-${row.month}`}>
                    <td className="px-4 py-2 font-medium text-gray-900">
                      {label}
                      {row.targetsChangedSinceApply && (
                        canClose && row.hasHistory && row.state === 'OPEN' ? (
                          <button type="button" onClick={() => setRecalcMonth(row.month)}
                            data-testid={`targets-changed-${row.month}`}
                            aria-label={`Targets for ${label} changed after it was applied — recalculate`}
                            className="mt-1 flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
                            <AlertTriangle className="w-3 h-3" /> Targets changed — recalculate
                          </button>
                        ) : (
                          <span data-testid={`targets-changed-${row.month}`}
                            className="mt-1 flex w-fit items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-800 border-amber-200">
                            <AlertTriangle className="w-3 h-3" /> Targets changed after the last apply
                          </span>
                        )
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                        row.state === 'CLOSED' ? 'bg-gray-100 text-gray-700 border-gray-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                        {row.state === 'CLOSED' ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
                        {row.state === 'CLOSED' ? 'Closed' : 'Open'}
                      </span>
                      {row.implicit && <span className="ml-2 text-[11px] text-gray-400">(automatic)</span>}
                    </td>
                    <td className="px-4 py-2 text-gray-600">{row.lastAppliedAt ? dateTimeLabel(row.lastAppliedAt) : 'Never'}</td>
                    <td className="px-4 py-2 text-gray-600">
                      {row.closedAt ? `${dateTimeLabel(row.closedAt)}${row.closedBy ? ` by ${row.closedBy}` : ''}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {canClose && row.canClose && (
                        <Button size="sm" variant="outline" onClick={() => close(row)} loading={busyMonth === row.month}
                          aria-label={`Close ${label}`}>
                          <Lock className="w-3.5 h-3.5" /> Close {label}
                        </Button>
                      )}
                      {canClose && row.hasHistory && (
                        row.state === 'OPEN' ? (
                          <Button size="sm" variant="ghost" onClick={() => setRecalcMonth(row.month)}
                            aria-label={`Recalculate ${label} from stored history`} data-testid={`recalc-open-${row.month}`}>
                            <Calculator className="w-3.5 h-3.5" /> Recalculate
                          </Button>
                        ) : (
                          <span className="inline-flex flex-col items-end align-middle mr-2">
                            <Button size="sm" variant="ghost" disabled aria-describedby={`recalc-closed-${row.month}`}
                              aria-label={`Recalculate ${label} from stored history`}>
                              <Calculator className="w-3.5 h-3.5" /> Recalculate
                            </Button>
                            <span id={`recalc-closed-${row.month}`} className="text-[11px] text-gray-500">Gifsy must reopen this month first</span>
                          </span>
                        )
                      )}
                      {canClose && row.hasHistory && row.productListCurrent === false && (
                        <Button size="sm" variant="ghost" onClick={() => rebuildProductList(row)} loading={busyMonth === row.month}
                          aria-label={`Rebuild the product list for ${label}`} data-testid={`rebuild-product-list-${row.month}`}>
                          <RotateCcw className="w-3.5 h-3.5" /> Rebuild product list
                        </Button>
                      )}
                      {isGifsyAdmin && canClose && row.canReopen && (
                        <Button size="sm" variant="ghost" onClick={() => reopen(row)} loading={busyMonth === row.month}
                          aria-label={`Reopen ${label}`}>
                          <LockOpen className="w-3.5 h-3.5" /> Reopen
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!isGifsyAdmin && (
        <p className="text-xs text-gray-500">Need to change a closed month? Ask Gifsy to reopen it.</p>
      )}
    </div>
  );
}
