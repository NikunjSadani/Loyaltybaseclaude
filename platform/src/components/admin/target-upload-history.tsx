'use client';

/**
 * Targets — Upload history (owner 2026-11-25). Newest uploads first, tenant-scoped by the API, in pages of 100:
 * GET /api/admin/targets/batches[?before=<nextCursor>] → { items, pageSize, hasMore, nextCursor }. Each row carries
 * the uploader name, the apply audit details and a truthful `outcome` (applied / failed — nothing saved / older upload
 * that may be partly saved / being saved / did not finish — nothing saved). "Download file" streams the kept file
 * (GET /api/admin/targets/batches/:id/file); uploads made before the confirm step say "File not kept".
 */
import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import { readJsonSafe, responseErrorMessage } from '@/lib/safe-response';
import { formatISTDateTime } from '@/lib/ist-date';
import { formatMonth } from '@/lib/targets';
import { useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

export type TargetUploadOutcome = 'APPLIED' | 'FAILED' | 'LEGACY_FAILED' | 'IN_PROGRESS' | 'ABANDONED';

export interface TargetUploadHistoryRow {
  id: string;
  createdAt: string;
  month: string;
  status: string;
  /** Truthful outcome (absent on older API builds → derived from status). */
  outcome?: TargetUploadOutcome;
  failureReason?: string | null;
  totalRows: number;
  acceptedCount: number;
  rejectedCount: number;
  uploadedByName?: string | null;
  months?: string[] | null;
  fileName?: string | null;
  savedCount?: number | null;
  newCount?: number | null;
  overwriteCount?: number | null;
  fileKept?: boolean;
}

interface HistoryPage {
  items: TargetUploadHistoryRow[];
  pageSize?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
}

const dash = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-IN'));

/** The outcome tag of a row that was NOT (fully) applied — null for an applied upload. */
const OUTCOME_TAG: Record<Exclude<TargetUploadOutcome, 'APPLIED'>, { text: string; cls: string }> = {
  FAILED:        { text: 'Failed — nothing saved', cls: 'bg-red-50 border-red-200 text-red-700' },
  LEGACY_FAILED: { text: 'Failed part-way (older upload) — may be partly saved; check Download Final Targets', cls: 'bg-red-50 border-red-200 text-red-700' },
  IN_PROGRESS:   { text: 'Being saved…', cls: 'bg-blue-50 border-blue-200 text-blue-700' },
  ABANDONED:     { text: 'Did not finish — nothing saved', cls: 'bg-amber-50 border-amber-200 text-amber-800' },
};

function outcomeOf(r: TargetUploadHistoryRow): TargetUploadOutcome {
  if (r.outcome) return r.outcome;
  if (r.status === 'FAILED') return 'LEGACY_FAILED';
  if (r.status === 'PENDING') return 'IN_PROGRESS';
  return 'APPLIED';
}

/** Reads one page; an older API build returns a bare array (one page, no more). */
async function fetchPage(before: string | null): Promise<{ page: HistoryPage } | { error: string }> {
  const res = await fetch(`/api/admin/targets/batches${before ? `?before=${encodeURIComponent(before)}` : ''}`, { headers: authHeader() });
  const json = await readJsonSafe<{ success: boolean; data?: HistoryPage | TargetUploadHistoryRow[]; error?: string }>(res);
  if (!json || !res.ok || !json.success || !json.data) return { error: json?.error ?? responseErrorMessage(res, json, '') };
  if (Array.isArray(json.data)) return { page: { items: json.data, hasMore: false, nextCursor: null } };
  if (!Array.isArray(json.data.items)) return { error: "Couldn't read the upload history. Refresh to try again." };
  return { page: json.data };
}

export function TargetUploadHistory({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rows, setRows] = useState<TargetUploadHistoryRow[] | null>(null);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const fileAction = useDownloadAction();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchPage(null);
        if (cancelled) return;
        if ('error' in r) {
          setError(r.error);
          setRows([]);
          setNextCursor(null);
          return;
        }
        setError('');
        setMoreError('');
        setRows(r.page.items);
        setNextCursor(r.page.hasMore ? r.page.nextCursor ?? null : null);
      } catch {
        if (!cancelled) {
          setError("Couldn't load the upload history (network error). Refresh to try again.");
          setRows([]);
          setNextCursor(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

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
      setMoreError("Couldn't load more uploads (network error). Try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function download(r: TargetUploadHistoryRow) {
    setDownloadingId(r.id);
    try {
      await fileAction.run(`/api/admin/targets/batches/${encodeURIComponent(r.id)}/file`, {
        fallbackFileName: r.fileName || `targets-upload-${r.id}.xlsx`,
      });
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div data-testid="target-upload-history" className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-3">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-gray-100">
          <History className="w-4 h-4 text-gray-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">Upload history</p>
          <p className="text-xs text-gray-500 mt-0.5">Target uploads for this program, newest first. Times are IST.</p>
        </div>
      </div>

      {rows === null && <p className="text-xs text-gray-500">Loading upload history…</p>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {rows !== null && !error && rows.length === 0 && (
        <p className="text-xs text-gray-500">No target uploads yet.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                <th className="py-2 pr-3 font-semibold">When (IST)</th>
                <th className="py-2 pr-3 font-semibold">Who</th>
                <th className="py-2 pr-3 font-semibold">Month(s)</th>
                <th className="py-2 pr-3 font-semibold text-right">Accepted</th>
                <th className="py-2 pr-3 font-semibold text-right">Rejected</th>
                <th className="py-2 pr-3 font-semibold text-right">Overwritten</th>
                <th className="py-2 pr-3 font-semibold">File</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const months = r.months && r.months.length > 0 ? r.months : [r.month];
                const outcome = outcomeOf(r);
                const tag = outcome === 'APPLIED' ? null : OUTCOME_TAG[outcome];
                return (
                  <tr key={r.id} className="border-b border-gray-50 text-gray-700 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatISTDateTime(r.createdAt)}</td>
                    <td className="py-2 pr-3">{r.uploadedByName ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {months.map(formatMonth).join(', ')}
                      {tag && (
                        <span className={`ml-2 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${tag.cls}`}>
                          {tag.text}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right">{dash(r.acceptedCount)}</td>
                    <td className="py-2 pr-3 text-right">{dash(r.rejectedCount)}</td>
                    {/* Nothing was overwritten by an upload that saved nothing. */}
                    <td className="py-2 pr-3 text-right">{outcome === 'APPLIED' ? dash(r.overwriteCount) : '—'}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {r.fileKept
                        ? (
                          <button
                            type="button"
                            onClick={() => download(r)}
                            disabled={fileAction.blocked}
                            className="font-semibold text-[var(--brand-primary)] hover:underline disabled:opacity-40"
                          >
                            {downloadingId === r.id ? 'Preparing…' : 'Download file'}
                          </button>
                        )
                        : <span className="text-gray-400">{outcome === 'APPLIED' ? 'File not kept' : '—'}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <p data-testid="target-upload-history-count" className="text-xs text-gray-500">
            {nextCursor
              ? `Showing the newest ${rows.length.toLocaleString('en-IN')} uploads — older uploads are not shown yet.`
              : `Showing all ${rows.length.toLocaleString('en-IN')} upload${rows.length === 1 ? '' : 's'}.`}
          </p>
          {nextCursor && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="text-xs font-semibold text-[var(--brand-primary)] hover:underline disabled:opacity-40"
            >
              {loadingMore ? 'Loading…' : 'Load older uploads'}
            </button>
          )}
          {moreError && <p role="alert" className="text-xs text-red-700">{moreError}</p>}
        </div>
      )}
      <DownloadActionStatus action={fileAction} />
    </div>
  );
}
