'use client';

/**
 * Target history (owner 2026-11-25, all clients) — one outlet's target changes, newest first, 100 at a time:
 * GET /api/admin/targets/history?outletCode=…[&before=<nextCursor>] → { items, hasMore, nextCursor, trackingSince }.
 * Every row: month, KPI, old → new, who, when (IST) and the upload it came from (its file when kept).
 * History starts when tracking was switched on; the panel always SAYS so (never a silent gap).
 * Also exports `TargetHistoryDownloadButton` — the report (xlsx) via the Downloads design (one outlet streams now; a
 * whole program is prepared on the Downloads page).
 */
import { useEffect, useState } from 'react';
import { History, Download } from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import { readJsonSafe, responseErrorMessage } from '@/lib/safe-response';
import { formatISTDateTime } from '@/lib/ist-date';
import { formatMonth } from '@/lib/targets';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

export interface TargetHistoryRow {
  id: string;
  outletCode: string;
  month: string;
  kpiCode: string;
  kpiLabel: string;
  field: 'VALUE' | 'NAME' | string;
  oldValue: unknown;
  newValue: unknown;
  changeType: 'CREATED' | 'UPDATED' | 'DELETED' | string;
  batchId: string | null;
  batchFileKept: boolean;
  changedByName: string | null;
  changedAt: string;
}

interface HistoryPage {
  items: TargetHistoryRow[];
  hasMore?: boolean;
  nextCursor?: string | null;
  trackingSince?: string | null;
}

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'number' ? v.toLocaleString('en-IN') : String(v));

export function TargetHistoryDownloadButton({ outletCode, month, label = 'Download target history' }: {
  outletCode?: string; month?: string; label?: string;
}) {
  const action = useDownloadAction();
  const qs = new URLSearchParams();
  if (outletCode) qs.set('outletCode', outletCode);
  if (month) qs.set('month', month);
  const q = qs.toString();
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => action.run(`/api/admin/targets/history/export${q ? `?${q}` : ''}`, {
          fallbackFileName: `target-history${outletCode ? `-${outletCode}` : ''}.xlsx`,
        })}
        disabled={action.blocked}
        className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 text-sm font-semibold rounded-xl hover:border-gray-400 disabled:opacity-40 transition-colors"
      >
        <Download className="w-4 h-4" />
        {downloadButtonLabel(action, label)}
      </button>
      <DownloadActionStatus action={action} />
    </div>
  );
}

/** The Targets pages' entry: open an outlet's history + download the whole program's history report. */
export function TargetHistoryCard() {
  return (
    <div data-testid="target-history-card" className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-gray-100"><History className="w-4 h-4 text-gray-600" /></div>
        <div>
          <p className="text-sm font-semibold text-gray-900">Target change history</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Every target an upload changed — old → new, who, when. Recorded since history tracking started.{' '}
            <a href="/admin/targets/history" className="font-semibold text-[var(--brand-primary)] hover:underline">See an outlet&apos;s history</a>
          </p>
        </div>
      </div>
      <TargetHistoryDownloadButton />
    </div>
  );
}

export function TargetHistoryPanel({ outletCode }: { outletCode: string }) {
  const [rows, setRows] = useState<TargetHistoryRow[] | null>(null);
  const [trackingSince, setTrackingSince] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const fileAction = useDownloadAction();

  async function fetchPage(before: string | null): Promise<{ page: HistoryPage } | { error: string }> {
    const qs = new URLSearchParams({ outletCode });
    if (before) qs.set('before', before);
    const res = await fetch(`/api/admin/targets/history?${qs.toString()}`, { headers: authHeader() });
    const json = await readJsonSafe<{ success: boolean; data?: HistoryPage; error?: string }>(res);
    if (!json || !res.ok || !json.success || !json.data || !Array.isArray(json.data.items)) {
      return { error: json?.error ?? responseErrorMessage(res, json, '') };
    }
    return { page: json.data };
  }

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError('');
    (async () => {
      try {
        const r = await fetchPage(null);
        if (cancelled) return;
        if ('error' in r) { setError(r.error); setRows([]); setNextCursor(null); return; }
        setRows(r.page.items);
        setTrackingSince(r.page.trackingSince ?? null);
        setNextCursor(r.page.hasMore ? r.page.nextCursor ?? null : null);
      } catch {
        if (!cancelled) { setError("Couldn't load the target history (network error). Refresh to try again."); setRows([]); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletCode]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const r = await fetchPage(nextCursor);
      if ('error' in r) { setMoreError(r.error); return; }
      setRows(prev => [...(prev ?? []), ...r.page.items]);
      setNextCursor(r.page.hasMore ? r.page.nextCursor ?? null : null);
    } catch {
      setMoreError("Couldn't load older changes (network error). Try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div data-testid="target-history" className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gray-100"><History className="w-4 h-4 text-gray-600" /></div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Target history — <span className="font-mono">{outletCode}</span></p>
            <p className="text-xs text-gray-500 mt-0.5">Every target change from an upload, newest first. Times are IST.</p>
          </div>
        </div>
        <TargetHistoryDownloadButton outletCode={outletCode} label="Download this outlet's history" />
      </div>

      {/* No silent gap: history only covers changes since tracking started. */}
      {rows !== null && !error && (
        <p data-testid="target-history-tracking" className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          {trackingSince
            ? `Target history is recorded from ${formatISTDateTime(trackingSince)} IST. Changes made before then are not listed (before history tracking).`
            : 'No target changes have been recorded yet. Changes made before history tracking started are not listed.'}
        </p>
      )}

      {rows === null && <p className="text-xs text-gray-500">Loading target history…</p>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {rows !== null && !error && rows.length === 0 && (
        <p className="text-xs text-gray-500">No recorded target changes for this outlet.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                <th className="py-2 pr-3 font-semibold">Month</th>
                <th className="py-2 pr-3 font-semibold">KPI</th>
                <th className="py-2 pr-3 font-semibold">Old → New</th>
                <th className="py-2 pr-3 font-semibold">By</th>
                <th className="py-2 pr-3 font-semibold">When (IST)</th>
                <th className="py-2 pr-3 font-semibold">Upload</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b border-gray-50 text-gray-700 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{formatMonth(r.month)}</td>
                  <td className="py-2 pr-3">{r.kpiLabel}{r.field === 'NAME' ? ' (custom name)' : ''}</td>
                  <td className="py-2 pr-3">
                    {show(r.oldValue)} → {r.changeType === 'DELETED' ? 'removed' : show(r.newValue)}
                    {r.changeType === 'CREATED' && <span className="ml-1 text-[10px] text-gray-400">(new)</span>}
                  </td>
                  <td className="py-2 pr-3">{r.changedByName ?? '—'}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{formatISTDateTime(r.changedAt)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {r.batchId && r.batchFileKept
                      ? (
                        <button
                          type="button"
                          disabled={fileAction.blocked}
                          onClick={() => fileAction.run(`/api/admin/targets/batches/${encodeURIComponent(r.batchId!)}/file`, {
                            fallbackFileName: `targets-upload-${r.batchId}.xlsx`,
                          })}
                          className="font-semibold text-[var(--brand-primary)] hover:underline disabled:opacity-40"
                        >
                          Upload file
                        </button>
                      )
                      : <span className="text-gray-400">{r.batchId ? `Upload ${r.batchId.slice(-8)}` : '—'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <p data-testid="target-history-count" className="text-xs text-gray-500">
            {nextCursor
              ? `Showing the newest ${rows.length.toLocaleString('en-IN')} changes — older changes are not shown yet.`
              : `Showing all ${rows.length.toLocaleString('en-IN')} recorded change${rows.length === 1 ? '' : 's'}.`}
          </p>
          {nextCursor && (
            <button type="button" onClick={loadMore} disabled={loadingMore}
              className="text-xs font-semibold text-[var(--brand-primary)] hover:underline disabled:opacity-40">
              {loadingMore ? 'Loading…' : 'Load older changes'}
            </button>
          )}
          {moreError && <p role="alert" className="text-xs text-red-700">{moreError}</p>}
        </div>
      )}
      <DownloadActionStatus action={fileAction} />
    </div>
  );
}
