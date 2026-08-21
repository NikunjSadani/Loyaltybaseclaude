'use client';

/**
 * /admin/whatsapp-broadcasts/[id] — campaign detail (Gifsy-operator only).
 *
 * Status funnel (Queued → Sent → Delivered → Read / Failed) + failure-reason
 * breakdown + Download Excel report + Resend-to-failed + Cancel + post-create
 * test-send. Data: GET /api/admin/whatsapp-broadcasts/:id.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Download,
  RefreshCw,
  RotateCcw,
  Ban,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { api, authHeader } from '@/lib/api-client';
import { downloadBlob } from '@/lib/download';
import { Modal } from '@/components/ui/modal';
import { StatusPill } from '@/components/whatsapp/status-pill';
import {
  type BroadcastDetail,
  deliveryFunnel,
  funnelSegments,
  shouldPollBroadcast,
  canCancelBroadcast,
  canResendFailed,
} from '@/lib/whatsapp-broadcasts';

const FUNNEL_COLORS: Record<string, string> = {
  queued: 'bg-gray-400',
  sent: 'bg-blue-500',
  delivered: 'bg-emerald-500',
  read: 'bg-indigo-500',
  failed: 'bg-red-500',
};

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BroadcastDetail | null>(null);
  // A background auto-refresh that fails must NOT blank the page — surface it as a
  // persistent non-blocking banner while the last good data stays on screen (fix 7).
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Latest data, read inside the polling callback without stale-closure churn.
  const dataRef = useRef<BroadcastDetail | null>(null);
  useEffect(() => { dataRef.current = data; }, [data]);

  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!id) return;
      const silent = opts?.silent ?? false;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      const res = await api.get<BroadcastDetail>(`/api/admin/whatsapp-broadcasts/${id}`);
      if (res.success) {
        setData(res.data);
        setError(null);
        setRefreshError(null);
      } else if (dataRef.current) {
        // We already have data on screen — keep it, surface a non-blocking banner.
        setRefreshError(res.error);
      } else {
        setError(res.error);
      }
      if (!silent) setLoading(false);
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the funnel live not only while SENDING but AFTER status→SENT too, so late
  // delivery/read webhooks keep updating it — bounded by shouldPollBroadcast, which
  // stops once every recipient is terminal or the post-send window elapses (fix 5).
  useEffect(() => {
    if (!shouldPollBroadcast(data, Date.now())) return;
    const t = setInterval(() => {
      if (!shouldPollBroadcast(dataRef.current, Date.now())) return;
      void load({ silent: true });
    }, 5000);
    return () => clearInterval(t);
  }, [
    data?.status,
    data?.sentAt,
    data?.recipientCount,
    data?.readCount,
    data?.failedCount,
    load,
  ]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const [downloading, setDownloading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<null | 'cancel' | 'resend'>(null);
  const [acting, setActing] = useState(false);

  async function handleDownload() {
    if (!id) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/admin/whatsapp-broadcasts/${id}/report`, {
        headers: authHeader(),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string };
          msg = j.error ?? msg;
        } catch {
          /* non-JSON error body */
        }
        showToast(`Download failed: ${msg}`, 'error');
        return;
      }
      const cd = res.headers.get('Content-Disposition') ?? '';
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? `whatsapp-broadcast-${id}.xlsx`;
      const blob = await res.blob();
      downloadBlob(blob, filename);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Download failed', 'error');
    } finally {
      setDownloading(false);
    }
  }

  async function runAction(kind: 'cancel' | 'resend') {
    if (!id) return;
    setActing(true);
    const url =
      kind === 'cancel'
        ? `/api/admin/whatsapp-broadcasts/${id}/cancel`
        : `/api/admin/whatsapp-broadcasts/${id}/resend-failed`;
    const res = await api.post<{ id?: string }>(url, {});
    setActing(false);
    setConfirmAction(null);
    if (res.success) {
      if (kind === 'resend' && res.data?.id) {
        showToast('Created a resend broadcast for failed recipients.');
        router.push(`/admin/whatsapp-broadcasts/${res.data.id}`);
      } else {
        showToast(kind === 'cancel' ? 'Broadcast cancelled.' : 'Resend queued.');
        void load();
      }
    } else {
      showToast(res.error, 'error');
    }
  }

  return (
    <div className="space-y-5 fade-in max-w-4xl">
      <Link
        href="/admin/whatsapp-broadcasts"
        className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All broadcasts
      </Link>

      {loading && !data && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading broadcast…
        </div>
      )}

      {error && !data && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm">
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{error}</p>
          <button
            onClick={() => void load()}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          {/* Non-blocking auto-refresh failure banner (fix 7) — the last good data
              stays visible; only the background poll failed. */}
          {refreshError && (
            <div
              role="status"
              data-testid="refresh-error-banner"
              className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="flex-1">
                Couldn’t refresh the latest status ({refreshError}). Showing the last
                loaded data — retrying automatically.
              </span>
              <button
                onClick={() => void load()}
                className="font-semibold underline hover:no-underline whitespace-nowrap"
              >
                Retry now
              </button>
            </div>
          )}

          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-bold text-gray-900">{data.title}</h1>
                <StatusPill status={data.status} />
              </div>
              {data.templateName && (
                <p className="text-xs text-gray-500 mt-0.5">{data.templateName}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void load()}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50"
                title="Refresh"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
              <button
                onClick={() => void handleDownload()}
                disabled={downloading}
                data-testid="download-report-btn"
                className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26] disabled:opacity-50"
              >
                {downloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                Download report
              </button>
            </div>
          </div>

          {/* Funnel */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <p className="text-xs font-semibold text-gray-700 mb-3">Delivery funnel</p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {deliveryFunnel(data).map((f) => (
                <div key={f.key} className="text-center" data-testid={`funnel-${f.key}`}>
                  <div className="flex items-center justify-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${FUNNEL_COLORS[f.key]}`} />
                    <span className="text-[11px] text-gray-500">{f.label}</span>
                  </div>
                  <p className="text-2xl font-bold text-gray-900 tabular-nums mt-1">
                    {f.count.toLocaleString('en-IN')}
                  </p>
                </div>
              ))}
            </div>
            {/* Progress bar */}
            <FunnelBar data={data} />
          </div>

          {/* Failure reasons */}
          {data.failureReasons && data.failureReasons.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <p className="text-xs font-semibold text-gray-700 mb-3">
                Failure reasons ({data.failedCount.toLocaleString('en-IN')} failed)
              </p>
              <div className="space-y-2">
                {data.failureReasons.map((fr) => (
                  <div
                    key={fr.reason}
                    className="flex items-center justify-between text-xs"
                    data-testid={`failure-${fr.reason}`}
                  >
                    <span className="text-gray-600 flex items-center gap-1.5">
                      <XCircle className="w-3.5 h-3.5 text-red-400" />
                      {fr.reason}
                    </span>
                    <span className="font-semibold text-gray-900 tabular-nums">
                      {fr.count.toLocaleString('en-IN')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            {canResendFailed(data) && (
              <button
                onClick={() => setConfirmAction('resend')}
                data-testid="resend-failed-btn"
                className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Resend to failed ({data.failedCount})
              </button>
            )}
            {canCancelBroadcast(data.status) && (
              <button
                onClick={() => setConfirmAction('cancel')}
                data-testid="cancel-btn"
                className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg border border-red-300 text-red-700 font-semibold hover:bg-red-50"
              >
                <Ban className="w-3.5 h-3.5" />
                Cancel broadcast
              </button>
            )}
          </div>
        </>
      )}

      {/* Confirm action modal */}
      <Modal
        open={confirmAction !== null}
        onOpenChange={(o) => !o && setConfirmAction(null)}
        title={confirmAction === 'cancel' ? 'Cancel this broadcast?' : 'Resend to failed recipients?'}
        description={
          confirmAction === 'cancel'
            ? 'Queued messages that have not yet been sent will be stopped. Already-sent messages cannot be recalled.'
            : 'A new broadcast will be created targeting only the recipients that failed or were not delivered.'
        }
      >
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => setConfirmAction(null)}
            disabled={acting}
            className="text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 disabled:opacity-50"
          >
            Keep
          </button>
          <button
            onClick={() => confirmAction && void runAction(confirmAction)}
            disabled={acting}
            data-testid="confirm-action-btn"
            className={`inline-flex items-center gap-1.5 text-xs px-5 py-2 rounded-lg text-white font-semibold disabled:opacity-50 ${
              confirmAction === 'cancel'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-[var(--brand-primary)] hover:bg-[#a50d26]'
            }`}
          >
            {acting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : confirmAction === 'cancel' ? (
              <Ban className="w-3.5 h-3.5" />
            ) : (
              <RotateCcw className="w-3.5 h-3.5" />
            )}
            {confirmAction === 'cancel' ? 'Cancel broadcast' : 'Create resend'}
          </button>
        </div>
      </Modal>

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[70] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg"
        >
          {toast.type === 'error' ? (
            <XCircle className="w-4 h-4 text-red-400" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-green-400" />
          )}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function FunnelBar({ data }: { data: BroadcastDetail }) {
  // Mutually-exclusive segments (every recipient in exactly one bucket) so widths
  // can never overlap or sum past 100% (fix 4). Prefers the backend by-state funnel.
  const segments = funnelSegments(data);
  return (
    <div className="mt-4">
      <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-100">
        {segments.map((f) =>
          f.pct > 0 ? (
            <div
              key={f.key}
              className={FUNNEL_COLORS[f.key]}
              style={{ width: `${f.pct}%` }}
              title={`${f.label}: ${f.count.toLocaleString('en-IN')}`}
            />
          ) : null,
        )}
      </div>
      <p className="text-[11px] text-gray-400 mt-1.5">
        {data.recipientCount.toLocaleString('en-IN')} total recipients
      </p>
    </div>
  );
}
