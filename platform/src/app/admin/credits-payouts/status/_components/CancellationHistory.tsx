'use client';

/** Cancellation history of one upload (every admin role): when, who, how many, ₹, reason, on screen / by file. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson, fmtDateTime, inr, plural } from './payout-cancel-shared';

export interface CancellationHistoryItem {
  id: string;
  at: string;
  by: string | null;
  cancellationId: string | null;
  source: 'SCREEN' | 'FILE' | null;
  reason: string | null;
  count: number;
  amountPaise: number;
  invoicesVoided: unknown[];
  file: unknown;
}

function fileName(file: unknown): string | null {
  if (!file) return null;
  if (typeof file === 'string') return file;
  if (typeof file === 'object' && file !== null && typeof (file as { name?: unknown }).name === 'string') return (file as { name: string }).name;
  return null;
}

export default function CancellationHistory({ batchId, refreshKey }: { batchId: string; refreshKey: number }) {
  const [items, setItems] = useState<CancellationHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setError(null);
    const r = await apiJson<CancellationHistoryItem[]>(`/api/admin/credits/batches/${encodeURIComponent(batchId)}/cancellations`);
    if (req !== reqRef.current) return;
    if (!r.ok || !Array.isArray(r.data)) {
      setError(r.ok ? 'The history came back empty.' : r.error);
      return;
    }
    setItems(r.data);
  }, [batchId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <section aria-label="Cancellation history" data-testid="cancellation-history" className="px-5 py-4 border-b border-gray-100 space-y-2">
      <h4 className="text-sm font-semibold text-gray-900">Cancellations of this upload</h4>
      {error ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">
          <span>Couldn&apos;t load the cancellation history: {error}</span>
          <button type="button" onClick={() => void load()} className="px-2.5 py-1 rounded-lg border border-red-200 bg-white hover:bg-red-50">
            Retry loading the cancellation history
          </button>
        </div>
      ) : !items ? (
        <p role="status" className="text-xs text-gray-500 animate-pulse">Loading cancellation history…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-gray-500">No payout of this upload has been cancelled.</p>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg text-xs">
          {items.map((h) => {
            const f = fileName(h.file);
            const voided = Array.isArray(h.invoicesVoided) ? h.invoicesVoided.length : 0;
            return (
              <li key={h.id} className="px-3 py-2 text-gray-700" data-testid={`cancellation-${h.id}`}>
                <span className="font-medium text-gray-900">{fmtDateTime(h.at)}</span> · {h.by ?? 'unknown'} ·{' '}
                {plural(Number(h.count) || 0, 'payout', 'payouts')} · {inr(h.amountPaise)} ·{' '}
                {h.source === 'FILE' ? `by file${f ? ` (${f})` : ''}` : h.source === 'SCREEN' ? 'on screen' : 'source not recorded'}
                {voided > 0 && ` · ${plural(voided, 'invoice', 'invoices')} voided`}
                {h.reason && <span className="block text-gray-500">Reason: {h.reason}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
