'use client';

/**
 * Reward STOCK HISTORY (owner-approved 2026-11-26, all clients).
 *
 *   StockHistoryPanel  — inside the Edit Reward window: opening / baseline, redeemed, returned, adjusted, current,
 *                        then every movement (when, type, change, stock after, order, who, details) + a download.
 *   StockReviewBanner  — on the catalogue: cancelled / failed / returned orders that were confirmed BEFORE stock
 *                        history existed. Their stock is never returned automatically — an admin decides
 *                        (Return to stock / Keep as is) and the decision is recorded.
 *
 * Data: GET  /api/admin/rewards/catalog/:id/stock-history          (summary + movements + open reviews)
 *       GET  /api/admin/rewards/catalog/:id/stock-history/export   (.xlsx)
 *       GET  /api/admin/rewards/stock-reviews                      (the tenant's open reviews)
 *       POST /api/admin/rewards/stock-reviews/:id/resolve          { action: RETURN | KEEP, note }
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Download, History, Loader2, XCircle } from 'lucide-react';
import { api } from '@/lib/api-client';
import { downloadOrQueue } from '@/lib/exports/download';
import { formatISTDateTime } from '@/lib/ist-date';

export type StockMovementType = 'OPENING' | 'REDEEMED' | 'RETURNED' | 'ADJUSTED';

export interface StockMovement {
  id: string;
  type: StockMovementType;
  isBaseline: boolean;
  quantity: number;
  balanceAfter: number | null;
  orderId: string | null;
  orderNumber: string | null;
  reason: string | null;
  actorId: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface StockReviewItem {
  id: string;
  orderId: string;
  orderNumber: string;
  quantity: number;
  orderStatus: string;
  createdAt: string;
  rewardId?: string;
  rewardName?: string | null;
  rewardCode?: string | null;
  currentStock?: number | null;
}

export interface StockHistory {
  reward: { id: string; code: string; name: string; status: string; stockQuantity: number | null; deleted: boolean };
  summary: {
    opening: number | null;
    openingAt: string | null;
    openingIsBaseline: boolean;
    redeemed: number;
    returned: number;
    adjusted: number;
    current: number | null;
    historyStartedAt: string | null;
  };
  movements: StockMovement[];
  total: number;
  truncated: boolean;
  canOpenOrder: boolean;
  pendingReviews: StockReviewItem[];
}

const TYPE_LABEL: Record<StockMovementType, string> = {
  OPENING: 'Opening',
  REDEEMED: 'Redeemed',
  RETURNED: 'Returned',
  ADJUSTED: 'Adjusted',
};

const TYPE_BADGE: Record<StockMovementType, string> = {
  OPENING: 'bg-gray-100 text-gray-700 border-gray-200',
  REDEEMED: 'bg-red-50 text-red-700 border-red-200',
  RETURNED: 'bg-green-50 text-green-700 border-green-200',
  ADJUSTED: 'bg-blue-50 text-blue-700 border-blue-200',
};

const ORDER_STATUS_WORD: Record<string, string> = { CANCELLED: 'Cancelled', FAILED: 'Failed', RETURNED: 'Returned' };

export function movementTypeLabel(m: Pick<StockMovement, 'type' | 'isBaseline'>): string {
  return m.isBaseline ? 'Opening (baseline at go-live of stock history)' : TYPE_LABEL[m.type] ?? m.type;
}

/** Signed change as shown in the table: +3 / −2 / 0. */
export function formatChange(q: number): string {
  if (q > 0) return `+${q}`;
  if (q < 0) return `−${Math.abs(q)}`;
  return '0';
}

function whoLabel(m: StockMovement): string {
  if (m.actorName) return m.actorName;
  if (m.isBaseline) return 'System (go-live baseline)';
  if (m.actorId) return 'Unknown user';
  return 'System';
}

/** A reply we can render (never trust the shape blindly — an odd reply shows an error, not a crash). */
export function isStockHistory(v: unknown): v is StockHistory {
  const d = v as Partial<StockHistory> | null | undefined;
  return !!d && typeof d === 'object' && !!d.summary && !!d.reward && Array.isArray(d.movements) && Array.isArray(d.pendingReviews);
}

/* ─── Stock history (Edit Reward window) ─────────────────────────────────────── */

export function StockHistoryPanel({ rewardId }: { rewardId: string }) {
  const [data, setData] = useState<StockHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState<{ text: string; kind: 'error' | 'info' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const res = await api.get<StockHistory>(`/api/admin/rewards/catalog/${rewardId}/stock-history`);
    if (res.success && isStockHistory(res.data)) setData(res.data);
    else setError(res.success ? 'The stock history could not be read.' : res.error || 'The stock history could not be loaded.');
    setLoading(false);
  }, [rewardId]);

  useEffect(() => { void load(); }, [load]);

  const download = async () => {
    setDownloading(true);
    setDownloadMsg(null);
    const out = await downloadOrQueue(`/api/admin/rewards/catalog/${rewardId}/stock-history/export`, {
      fallbackFileName: `stock-history-${new Date().toISOString().slice(0, 10)}.xlsx`,
    });
    if (out.kind === 'error') setDownloadMsg({ text: out.message, kind: 'error' });
    else if (out.kind === 'queued') setDownloadMsg({ text: out.message, kind: 'info' });
    setDownloading(false);
  };

  return (
    <section className="rounded-xl border border-gray-100 p-4 space-y-3" aria-label="Stock history">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <History className="h-4 w-4 text-gray-400" /> Stock history
        </h3>
        <button
          type="button"
          onClick={download}
          disabled={downloading || loading || !!error}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {downloading ? 'Preparing…' : 'Download'}
        </button>
      </div>
      {downloadMsg && (
        <p
          className={`text-xs ${downloadMsg.kind === 'error' ? 'text-red-700' : 'text-gray-600'}`}
          role={downloadMsg.kind === 'error' ? 'alert' : 'status'}
        >
          {downloadMsg.text}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-gray-500" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading stock history…
        </div>
      ) : error ? (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          <span className="flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5 shrink-0" /> {error}</span>
          <button type="button" onClick={() => void load()} className="font-semibold underline">Try again</button>
        </div>
      ) : data ? (
        <StockHistoryBody data={data} />
      ) : null}
    </section>
  );
}

function StockHistoryBody({ data }: { data: StockHistory }) {
  const s = data.summary;
  const tiles: { label: string; value: string; tone: string }[] = [
    {
      label: s.openingIsBaseline ? 'Opening (baseline at go-live)' : 'Opening',
      value: s.opening == null ? '—' : String(s.opening),
      tone: 'text-gray-900',
    },
    { label: 'Redeemed', value: String(s.redeemed), tone: 'text-red-600' },
    { label: 'Returned', value: String(s.returned), tone: 'text-green-600' },
    { label: 'Adjusted (net)', value: formatChange(s.adjusted), tone: 'text-blue-600' },
    { label: 'Current', value: s.current == null ? 'Unlimited' : String(s.current), tone: 'text-gray-900' },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {tiles.map((t, i) => (
          <div
            key={t.label}
            className={`rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2 ${i === tiles.length - 1 ? 'col-span-2 sm:col-span-1' : ''}`}
          >
            <p className={`text-base font-bold ${t.tone}`}>{t.value}</p>
            <p className="text-[10px] text-gray-500 leading-tight">{t.label}</p>
          </div>
        ))}
      </div>

      {s.openingIsBaseline && s.openingAt ? (
        <p className="text-[11px] text-gray-500">
          Stock history started on {formatISTDateTime(s.openingAt)}. The opening figure is the stock at that moment
          (baseline at go-live of stock history); movements before it are not reconstructed.
        </p>
      ) : s.opening == null ? (
        <p className="text-[11px] text-gray-500">
          No stock movements recorded yet. {data.reward.stockQuantity == null ? 'This reward does not track stock (unlimited).' : ''}
        </p>
      ) : null}

      {data.pendingReviews.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            {data.pendingReviews.length} cancelled, failed or returned order{data.pendingReviews.length === 1 ? '' : 's'} (
            {data.pendingReviews.map((r) => r.orderNumber).join(', ')}) {data.pendingReviews.length === 1 ? 'was' : 'were'}{' '}
            confirmed before stock history started, so {data.pendingReviews.length === 1 ? 'its' : 'their'} stock was not
            returned automatically. An admin who manages the catalogue decides this on the catalogue page under
            “Stock returns to review”.
          </span>
        </div>
      )}

      {data.truncated && (
        <p className="text-[11px] text-amber-700">
          Showing the newest {data.movements.length} of {data.total} movements. The totals above include all of them.
        </p>
      )}

      {data.movements.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-100 max-h-72">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-gray-100 text-left text-[10px] text-gray-400">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium text-right">Change</th>
                <th className="px-3 py-2 font-medium text-right">Stock after</th>
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">By</th>
                <th className="px-3 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.movements.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{formatISTDateTime(m.createdAt)}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${TYPE_BADGE[m.type] ?? TYPE_BADGE.OPENING}`}>
                      {movementTypeLabel(m)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{m.type === 'OPENING' ? m.quantity : formatChange(m.quantity)}</td>
                  <td className="px-3 py-2 text-right font-mono">{m.balanceAfter == null ? 'Unlimited' : m.balanceAfter}</td>
                  <td className="px-3 py-2">
                    {m.orderId && m.orderNumber ? (
                      data.canOpenOrder ? (
                        <Link href={`/admin/gift-orders/${m.orderId}`} className="text-[var(--brand-primary)] underline">
                          {m.orderNumber}
                        </Link>
                      ) : (
                        <span className="font-mono">{m.orderNumber}</span>
                      )
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{whoLabel(m)}</td>
                  <td className="px-3 py-2 text-gray-500 min-w-[12rem]">{m.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─── Stock returns to review (catalogue) ────────────────────────────────────── */

export function StockReviewBanner({
  canDecide,
  permissionsPending = false,
  permissionsError = false,
  onChanged,
}: {
  canDecide: boolean;
  /** GIFSY_STAFF whose permissions are still loading — show "checking", not a denial. */
  permissionsPending?: boolean;
  /** The staff permission fetch failed — say so instead of showing a denial. */
  permissionsError?: boolean;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<StockReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [retrying, setRetrying] = useState(false);
  // Per-row state: several rows can be in progress at once without stepping on each other.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [keepNote, setKeepNote] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Record<string, 'confirm-return' | 'keep' | undefined>>({});
  const [done, setDone] = useState('');
  const doneRef = useRef<HTMLParagraphElement | null>(null);

  const load = useCallback(async () => {
    const res = await api.get<{ total: number; items: StockReviewItem[] }>('/api/admin/rewards/stock-reviews');
    if (res.success && res.data && Array.isArray(res.data.items)) {
      setItems(res.data.items);
      setTotal(typeof res.data.total === 'number' ? res.data.total : res.data.items.length);
      setLoadError('');
    } else {
      setLoadError(
        'We could not check for orders that need a stock decision, so some may be waiting.' +
          (res.success ? '' : res.error ? ` (${res.error})` : ''),
      );
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const retry = async () => {
    setRetrying(true);
    await load();
    setRetrying(false);
  };

  const decide = async (item: StockReviewItem, action: 'RETURN' | 'KEEP') => {
    const note = (keepNote[item.id] ?? '').trim();
    if (action === 'KEEP' && !note) {
      setRowError((e) => ({ ...e, [item.id]: 'Write why the stock stays as it is.' }));
      return;
    }
    setBusy((b) => ({ ...b, [item.id]: true }));
    setRowError((e) => ({ ...e, [item.id]: '' }));
    const res = await api.post<{ status: string; stockAfter?: number; backInStock?: boolean }>(
      `/api/admin/rewards/stock-reviews/${item.id}/resolve`,
      { action, ...(note ? { note } : {}) },
    );
    setBusy((b) => ({ ...b, [item.id]: false }));
    if (!res.success) {
      setRowError((e) => ({ ...e, [item.id]: res.error || 'The decision could not be saved. Refresh and try again.' }));
      return;
    }
    setMode((m) => ({ ...m, [item.id]: undefined }));
    setDone(
      action === 'RETURN'
        ? `Order ${item.orderNumber}: ${item.quantity} returned to stock${res.data?.stockAfter != null ? ` (now ${res.data.stockAfter})` : ''}${res.data?.backInStock ? '. The reward is back in stock and Active' : ''}. It is recorded in the reward’s Stock history.`
        : `Order ${item.orderNumber}: stock kept as is. Your decision and note are recorded.`,
    );
    await load();
    onChanged?.();
  };

  const statusLine = done ? (
    <p ref={doneRef} tabIndex={-1} className="text-xs text-green-700 outline-none" role="status">{done}</p>
  ) : null;

  if (loadError) {
    return (
      <section className="space-y-2" aria-label="Stock returns to review">
        {statusLine}
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
          <span className="flex items-center gap-2"><XCircle className="w-4 h-4 shrink-0" aria-hidden="true" /> {loadError}</span>
          <button type="button" onClick={() => void retry()} disabled={retrying} className="text-xs font-semibold underline disabled:opacity-50">
            {retrying ? 'Checking…' : 'Try again'}
          </button>
        </div>
      </section>
    );
  }
  if (total === 0) return statusLine ? <section aria-label="Stock returns to review">{statusLine}</section> : null;

  const decisionCell = (it: StockReviewItem) => {
    if (permissionsPending) return <span className="text-gray-600">Checking your permissions…</span>;
    if (permissionsError) return <span className="text-gray-600">Your permissions could not be loaded. Refresh the page to decide.</span>;
    if (!canDecide) return <span className="text-gray-600">Needs an admin who manages the catalogue</span>;
    const isBusy = !!busy[it.id];
    const m = mode[it.id];
    if (m === 'keep') {
      return (
        <div className="flex flex-col items-end gap-1.5">
          <input
            autoFocus
            value={keepNote[it.id] ?? ''}
            onChange={(e) => setKeepNote((n) => ({ ...n, [it.id]: e.target.value }))}
            placeholder="Why does the stock stay as it is?"
            aria-label={`Reason to keep stock for ${it.orderNumber}`}
            maxLength={500}
            className="w-56 max-w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5"
          />
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setMode((x) => ({ ...x, [it.id]: undefined }))} className="px-2 py-1 text-xs border border-gray-200 rounded-lg">Back</button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void decide(it, 'KEEP')}
              className="px-2 py-1 text-xs font-semibold bg-gray-800 text-white rounded-lg disabled:opacity-50"
            >
              {isBusy ? 'Saving…' : 'Confirm keep as is'}
            </button>
          </div>
        </div>
      );
    }
    if (m === 'confirm-return') {
      return (
        <div className="flex flex-col items-end gap-1.5">
          <p className="text-[11px] text-gray-700">
            Add {it.quantity} back to stock{it.currentStock != null ? ` (${it.currentStock} → ${it.currentStock + it.quantity})` : ''}?
          </p>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setMode((x) => ({ ...x, [it.id]: undefined }))} className="px-2 py-1 text-xs border border-gray-200 rounded-lg">Back</button>
            <button
              type="button"
              autoFocus
              disabled={isBusy}
              onClick={() => void decide(it, 'RETURN')}
              className="px-2 py-1 text-xs font-semibold bg-[var(--brand-primary)] text-white rounded-lg disabled:opacity-50"
            >
              {isBusy ? 'Saving…' : 'Confirm return to stock'}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          disabled={isBusy || it.currentStock == null}
          title={it.currentStock == null ? 'This reward no longer tracks stock (unlimited) — choose Keep as is' : undefined}
          onClick={() => setMode((x) => ({ ...x, [it.id]: 'confirm-return' }))}
          className="px-2 py-1 text-xs font-semibold bg-[var(--brand-primary)] text-white rounded-lg disabled:opacity-50"
        >
          Return {it.quantity} to stock
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setMode((x) => ({ ...x, [it.id]: 'keep' }))}
          className="px-2 py-1 text-xs border border-gray-200 rounded-lg"
        >
          Keep as is
        </button>
      </div>
    );
  };

  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-3" aria-label="Stock returns to review">
      <div className="flex items-start gap-2 text-sm text-amber-900">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <p className="font-semibold">Stock returns to review ({total})</p>
          <p className="text-xs mt-0.5">
            These orders were cancelled, failed or returned, but they were confirmed before stock history started, so we
            cannot tell whether their stock was taken. Their stock was NOT returned automatically. Choose for each one.
          </p>
        </div>
      </div>
      {statusLine}
      {items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-amber-100 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-left text-[10px] text-gray-500">
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">Reward</th>
                <th className="px-3 py-2 font-medium">Order status</th>
                <th className="px-3 py-2 font-medium text-right">Quantity</th>
                <th className="px-3 py-2 font-medium text-right">Stock now</th>
                <th className="px-3 py-2 font-medium text-right">Decision</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.map((it) => (
                <tr key={it.id} className="align-top">
                  <td className="px-3 py-2 font-mono">{it.orderNumber}</td>
                  <td className="px-3 py-2">
                    {it.rewardName ?? '—'}
                    {it.rewardCode ? <span className="block text-[10px] text-gray-500 font-mono">{it.rewardCode}</span> : null}
                  </td>
                  <td className="px-3 py-2">{ORDER_STATUS_WORD[it.orderStatus] ?? it.orderStatus}</td>
                  <td className="px-3 py-2 text-right">{it.quantity}</td>
                  <td className="px-3 py-2 text-right">{it.currentStock == null ? 'Unlimited' : it.currentStock}</td>
                  <td className="px-3 py-2 text-right space-y-1.5">
                    {decisionCell(it)}
                    {rowError[it.id] && <p className="text-[11px] text-red-600" role="alert">{rowError[it.id]}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > items.length && (
        <p className="text-[11px] text-amber-800">Showing the first {items.length} of {total}. Decide these to see the rest.</p>
      )}
    </section>
  );
}
