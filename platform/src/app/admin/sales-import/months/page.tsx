'use client';

/**
 * /admin/sales-import/months — month close / reopen (SALES-IMPORT-PIPELINE-PLAN §7.3, §11 F-5).
 *
 * Close = targets:upload (CLIENT_ADMIN or assumed GIFSY_ADMIN). Reopen = GIFSY_ADMIN only (the button is shown only
 * to GIFSY_ADMIN; the backend enforces the role + assumed tenant). The current month can never be closed.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Lock, LockOpen, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAdminSession } from '@/lib/admin-session';
import { salesImportApi } from '@/lib/sales-import/api';
import { dateTimeLabel, monthLabel, sentence } from '@/lib/sales-import/format';
import { usePermissions } from '@/lib/use-permissions';
import type { SalesMonthRow } from '@/lib/sales-import/types';

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

  useEffect(() => {
    let cancelled = false;
    setError(null);
    salesImportApi.months().then((r) => {
      if (cancelled) return;
      if (r.success) setRows([...r.data].sort((a, b) => b.month.localeCompare(a.month)));
      else setError(r.error);
    });
    return () => { cancelled = true; };
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

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
    setBusyMonth(null);
    if (!r.success) { setActionMsg({ tone: 'err', text: `${label} was not closed: ${sentence(r.error)}.` }); reload(); return; }
    setActionMsg({ tone: 'ok', text: `${label} is closed. You can now compute points for it in the Points Engine.` });
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
    if (!r.success && r.status === 409 && !hasDownstream) {
      if (window.confirm(`${sentence(r.error)}.\n\nReopen ${label} anyway? Points already credited or exported for it may no longer match.`)) {
        r = await salesImportApi.reopenMonth(row.month, { acknowledgeDownstream: true });
      } else {
        setBusyMonth(null);
        reload();
        return;
      }
    }
    setBusyMonth(null);
    if (!r.success) { setActionMsg({ tone: 'err', text: `${label} was not reopened: ${sentence(r.error)}.` }); reload(); return; }
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
            computed for closed months.
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

      {rows === null ? (
        error ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-3">
            Couldn&apos;t load months: {error}
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
                    <td className="px-4 py-2 font-medium text-gray-900">{label}</td>
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
