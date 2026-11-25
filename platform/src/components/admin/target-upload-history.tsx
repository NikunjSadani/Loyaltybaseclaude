'use client';

/**
 * Targets — Upload history (owner 2026-11-25). Newest uploads first (the API returns at most 100), tenant-scoped by
 * the API. GET /api/admin/targets/batches → batch rows + uploader name + the confirmed-apply audit details.
 * "Download file" streams the kept file (GET /api/admin/targets/batches/:id/file); uploads made before the
 * confirm step (or applied directly by a script) say "File not kept".
 */
import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import { readJsonSafe, responseErrorMessage } from '@/lib/safe-response';
import { formatISTDateTime } from '@/lib/ist-date';
import { formatMonth } from '@/lib/targets';
import { useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

export interface TargetUploadHistoryRow {
  id: string;
  createdAt: string;
  month: string;
  status: string;
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

const dash = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-IN'));

export function TargetUploadHistory({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rows, setRows] = useState<TargetUploadHistoryRow[] | null>(null);
  const [error, setError] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const fileAction = useDownloadAction();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/targets/batches', { headers: authHeader() });
        const json = await readJsonSafe<{ success: boolean; data?: TargetUploadHistoryRow[]; error?: string }>(res);
        if (cancelled) return;
        if (!json || !res.ok || !json.success || !Array.isArray(json.data)) {
          setError(json?.error ?? responseErrorMessage(res, json, ''));
          setRows([]);
          return;
        }
        setError('');
        setRows(json.data);
      } catch {
        if (!cancelled) {
          setError("Couldn't load the upload history (network error). Refresh to try again.");
          setRows([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

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
          <p className="text-xs text-gray-500 mt-0.5">The latest target uploads for this program (newest first). Times are IST.</p>
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
                return (
                  <tr key={r.id} className="border-b border-gray-50 text-gray-700 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatISTDateTime(r.createdAt)}</td>
                    <td className="py-2 pr-3">{r.uploadedByName ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {months.map(formatMonth).join(', ')}
                      {r.status === 'FAILED' && (
                        <span className="ml-2 rounded-full bg-red-50 border border-red-200 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                          Failed — not fully applied
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right">{dash(r.acceptedCount)}</td>
                    <td className="py-2 pr-3 text-right">{dash(r.rejectedCount)}</td>
                    <td className="py-2 pr-3 text-right">{dash(r.overwriteCount)}</td>
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
                        : <span className="text-gray-400">File not kept</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <DownloadActionStatus action={fileAction} />
    </div>
  );
}
