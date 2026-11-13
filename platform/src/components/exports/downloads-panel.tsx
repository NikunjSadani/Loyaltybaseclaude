'use client';

/**
 * Downloads page body (admin portal + Gifsy console) — the caller's own background report
 * requests. Design: platform/docs/plans/DOWNLOADS-PAGE.md (owner-approved 2026-11-13).
 *
 * - Lists GET /api/admin/exports (newest first, cursor "Load more").
 * - Auto-refreshes every ~10 s while any request is Waiting / Preparing; stops when none are,
 *   and pauses while the browser tab is hidden.
 * - Download button only for Ready files that have not passed their expiry.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Download, FolderDown, Loader2, RefreshCw, XCircle } from 'lucide-react';
import type { ExportRequestDto, ExportStatus } from '@/lib/exports/types';
import { EXPORT_RETENTION_DAYS } from '@/lib/exports/types';
import { downloadPreparedFile, fetchExportList } from '@/lib/exports/download';

export const DOWNLOADS_POLL_MS = 10_000;

type Tone = 'light' | 'dark';

/** What the person sees for each status. A READY file past its expiry shows as Expired. */
export type DisplayStatus = ExportStatus;

export function displayStatus(item: Pick<ExportRequestDto, 'status' | 'expiresAt'>, now: number = Date.now()): DisplayStatus {
  if (item.status === 'READY' && item.expiresAt && Date.parse(item.expiresAt) <= now) return 'EXPIRED';
  return item.status;
}

export const STATUS_LABEL: Record<ExportStatus, string> = {
  QUEUED: 'Waiting to start',
  RUNNING: 'Preparing',
  READY: 'Ready',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
};

const isActive = (s: ExportStatus) => s === 'QUEUED' || s === 'RUNNING';

const dateFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : dateFmt.format(new Date(t));
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRows(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-IN');
}

const TONES: Record<Tone, Record<string, string>> = {
  light: {
    title: 'text-xl font-bold text-gray-900',
    sub: 'text-sm text-gray-500',
    card: 'bg-white border border-gray-200 rounded-xl overflow-hidden',
    thead: 'bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-100',
    tbody: 'divide-y divide-gray-100',
    strong: 'font-medium text-gray-800',
    muted: 'text-gray-500',
    faint: 'text-gray-400',
    btn: 'border border-gray-300 text-gray-700 hover:bg-gray-50',
    primary: 'bg-[var(--brand-primary)] text-white hover:opacity-90',
    errorBox: 'bg-red-50 border border-red-200 text-red-700',
    errText: 'text-red-600',
    divider: 'border-gray-100',
  },
  dark: {
    title: 'text-xl font-bold text-white',
    sub: 'text-sm text-white/50',
    card: 'border border-white/10 rounded-xl overflow-hidden',
    thead: 'bg-white/5 text-[10px] uppercase tracking-wide text-white/50 border-b border-white/10',
    tbody: 'divide-y divide-white/5',
    strong: 'font-medium text-white',
    muted: 'text-white/60',
    faint: 'text-white/40',
    btn: 'border border-white/15 text-white/70 hover:bg-white/5',
    primary: 'bg-[var(--brand-primary)] text-white hover:opacity-90',
    errorBox: 'bg-red-500/10 border border-red-500/20 text-red-300',
    errText: 'text-red-400',
    divider: 'border-white/10',
  },
};

const BADGE: Record<Tone, Record<ExportStatus, string>> = {
  light: {
    QUEUED: 'bg-gray-100 text-gray-700',
    RUNNING: 'bg-blue-100 text-blue-700',
    READY: 'bg-green-100 text-green-700',
    FAILED: 'bg-red-100 text-red-700',
    EXPIRED: 'bg-amber-100 text-amber-800',
  },
  dark: {
    QUEUED: 'bg-white/10 text-white/70',
    RUNNING: 'bg-blue-500/15 text-blue-300',
    READY: 'bg-green-500/15 text-green-300',
    FAILED: 'bg-red-500/15 text-red-300',
    EXPIRED: 'bg-amber-500/15 text-amber-300',
  },
};

function StatusBadge({ status, tone }: { status: ExportStatus; tone: Tone }) {
  const Icon = status === 'READY' ? CheckCircle2
    : status === 'FAILED' ? XCircle
    : status === 'RUNNING' ? Loader2
    : Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${BADGE[tone][status]}`}>
      <Icon className={`w-3 h-3 ${status === 'RUNNING' ? 'animate-spin' : ''}`} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Merge a refreshed first page into what is already loaded (keeps "Load more" pages). */
function mergeFirstPage(current: ExportRequestDto[], fresh: ExportRequestDto[]): ExportRequestDto[] {
  const freshIds = new Set(fresh.map((i) => i.id));
  return [...fresh, ...current.filter((i) => !freshIds.has(i.id))];
}

/** True while the browser tab is visible (pauses auto-refresh in a background tab). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

export function DownloadsPanel({ tone = 'light' }: { tone?: Tone }) {
  const t = TONES[tone];
  const [items, setItems] = useState<ExportRequestDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pagesLoaded, setPagesLoaded] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const visible = usePageVisible();
  const mounted = useRef(true);
  const pagesRef = useRef(0);
  pagesRef.current = pagesLoaded;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Load (or re-load) the first page. `silent` = a background refresh: keep the table on screen. */
  const loadFirst = useCallback(async (silent: boolean) => {
    if (silent) setRefreshing(true);
    const res = await fetchExportList(null);
    if (!mounted.current) return;
    setNow(Date.now());
    if (res.ok) {
      setLoadError(null);
      setRefreshError(null);
      if (pagesRef.current <= 1) {
        setItems(res.data.items);
        setNextCursor(res.data.nextCursor);
        setPagesLoaded(1);
      } else {
        setItems((cur) => mergeFirstPage(cur, res.data.items));
      }
    } else if (silent && pagesRef.current > 0) {
      // Keep showing what we have; say the refresh failed.
      setRefreshError(res.message);
    } else {
      setLoadError(res.message);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { void loadFirst(false); }, [loadFirst]);

  const hasActive = items.some((i) => isActive(i.status));

  // Auto-refresh while anything is Waiting / Preparing and the tab is visible.
  useEffect(() => {
    if (!hasActive || !visible || loading) return;
    const id = setTimeout(() => { void loadFirst(true); }, DOWNLOADS_POLL_MS);
    return () => clearTimeout(id);
  }, [hasActive, visible, loading, items, loadFirst]);

  // Coming back to the tab with work in progress → refresh straight away.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current && hasActive) void loadFirst(true);
    wasVisible.current = visible;
  }, [visible, hasActive, loadFirst]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    const res = await fetchExportList(nextCursor);
    if (!mounted.current) return;
    if (res.ok) {
      setItems((cur) => {
        const seen = new Set(cur.map((i) => i.id));
        return [...cur, ...res.data.items.filter((i) => !seen.has(i.id))];
      });
      setNextCursor(res.data.nextCursor);
      setPagesLoaded((p) => p + 1);
    } else {
      setLoadMoreError(res.message);
    }
    setLoadingMore(false);
  };

  const download = async (item: ExportRequestDto) => {
    if (rowBusy[item.id]) return;
    setRowBusy((b) => ({ ...b, [item.id]: true }));
    setRowError((e) => { const n = { ...e }; delete n[item.id]; return n; });
    const out = await downloadPreparedFile(item.id, item.fileName);
    if (!mounted.current) return;
    setRowBusy((b) => ({ ...b, [item.id]: false }));
    if (out.kind === 'error') {
      setRowError((e) => ({ ...e, [item.id]: out.message }));
      // Gone / expired on the server → refresh so the row shows its real status.
      if (out.status === 404 || out.status === 410) void loadFirst(true);
    }
  };

  const header = (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className={`${t.title} flex items-center gap-2`}>
          <FolderDown className="w-5 h-5 shrink-0" aria-hidden="true" />Downloads
        </h1>
        <p className={`${t.sub} mt-0.5`}>
          Large reports are prepared in the background and appear here, usually within 1–5 minutes.
          Files are kept for {EXPORT_RETENTION_DAYS} days.
        </p>
      </div>
      <button
        type="button"
        onClick={() => { void loadFirst(pagesLoaded > 0); }}
        disabled={loading || refreshing}
        className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors disabled:opacity-60 shrink-0 self-start ${t.btn}`}
      >
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className={`${t.card} px-4 py-12 text-center text-sm ${t.muted}`} role="status">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-hidden="true" />Loading your downloads…
      </div>
    );
  } else if (loadError) {
    body = (
      <div className={`${t.card} px-4 py-12 text-center text-sm`} role="alert" data-testid="downloads-error">
        <p className={t.errText}>{loadError}</p>
        <button
          type="button"
          onClick={() => { setLoading(true); setLoadError(null); void loadFirst(false); }}
          className={`mt-3 px-4 py-1.5 text-xs font-medium rounded-lg ${t.btn}`}
        >
          Try again
        </button>
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className={`${t.card} py-16 px-4 flex flex-col items-center gap-2 text-center`} data-testid="downloads-empty">
        <FolderDown className={`w-8 h-8 ${t.faint}`} aria-hidden="true" />
        <p className={`text-sm ${t.strong}`}>No downloads yet</p>
        <p className={`text-xs ${t.muted} max-w-sm`}>
          When you download a large report, it is prepared in the background and shows up here.
        </p>
      </div>
    );
  } else {
    body = (
      <div className={t.card}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[760px]">
            <caption className="sr-only">Your report downloads, newest first</caption>
            <thead>
              <tr className={t.thead}>
                <th scope="col" className="text-left px-4 py-3">Report</th>
                <th scope="col" className="text-left px-4 py-3">Requested</th>
                <th scope="col" className="text-left px-4 py-3">Status</th>
                <th scope="col" className="text-left px-4 py-3">Ready at</th>
                <th scope="col" className="text-right px-4 py-3">Size</th>
                <th scope="col" className="text-right px-4 py-3">Rows</th>
                <th scope="col" className="text-right px-4 py-3"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody className={t.tbody}>
              {items.map((item) => {
                const status = displayStatus(item, now);
                const err = rowError[item.id];
                return (
                  <tr key={item.id} data-testid={`download-row-${item.id}`} className="align-top">
                    <td className="px-4 py-3 max-w-[260px]">
                      <p className={`${t.strong} break-words`}>{item.label}</p>
                      {item.paramsSummary && <p className={`${t.muted} break-words`}>{item.paramsSummary}</p>}
                    </td>
                    <td className={`px-4 py-3 whitespace-nowrap ${t.muted}`}>{formatWhen(item.createdAt)}</td>
                    <td className="px-4 py-3 max-w-[240px]">
                      <StatusBadge status={status} tone={tone} />
                      {status === 'FAILED' && (
                        <p className={`mt-1 break-words ${t.errText}`}>
                          {item.error || 'The file could not be prepared. Please request it again.'}
                        </p>
                      )}
                      {status === 'READY' && item.expiresAt && (
                        <p className={`mt-1 ${t.faint}`}>Available until {formatWhen(item.expiresAt)}</p>
                      )}
                      {status === 'EXPIRED' && (
                        <p className={`mt-1 ${t.faint}`}>No longer available — request the report again.</p>
                      )}
                    </td>
                    <td className={`px-4 py-3 whitespace-nowrap ${t.muted}`}>
                      {item.status === 'READY' || item.status === 'EXPIRED' ? formatWhen(item.finishedAt) : '—'}
                    </td>
                    <td className={`px-4 py-3 text-right whitespace-nowrap ${t.muted}`}>{formatBytes(item.sizeBytes)}</td>
                    <td className={`px-4 py-3 text-right whitespace-nowrap ${t.muted}`}>{formatRows(item.rowCount)}</td>
                    <td className="px-4 py-3 text-right">
                      {status === 'READY' && (
                        <button
                          type="button"
                          onClick={() => { void download(item); }}
                          disabled={!!rowBusy[item.id]}
                          aria-label={`Download ${item.label}`}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-60 whitespace-nowrap ${t.primary}`}
                        >
                          {rowBusy[item.id]
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                            : <Download className="w-3.5 h-3.5" aria-hidden="true" />}
                          {rowBusy[item.id] ? 'Downloading…' : 'Download'}
                        </button>
                      )}
                      {err && <p role="alert" className={`mt-1 text-left break-words ${t.errText}`}>{err}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {(nextCursor || loadMoreError) && (
          <div className={`px-4 py-3 flex flex-col items-center gap-1 border-t ${t.divider}`}>
            {nextCursor && (
              <button
                type="button"
                onClick={() => { void loadMore(); }}
                disabled={loadingMore}
                className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg disabled:opacity-60 ${t.btn}`}
              >
                {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
            {loadMoreError && <p role="alert" className={`text-xs ${t.errText}`}>{loadMoreError}</p>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {header}
      {refreshError && !loadError && (
        <div role="alert" className={`flex items-center gap-2 rounded-xl px-4 py-3 text-xs ${t.errorBox}`}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Couldn&apos;t refresh the list: {refreshError}</span>
        </div>
      )}
      {hasActive && !loading && !loadError && (
        <p className={`text-xs ${t.faint}`} aria-live="polite">
          {visible ? 'This list updates by itself while files are being prepared.' : 'Updates paused while this tab is in the background.'}
        </p>
      )}
      {body}
    </div>
  );
}
