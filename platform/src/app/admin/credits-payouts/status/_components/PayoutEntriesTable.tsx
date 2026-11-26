'use client';

/**
 * Row drill-down of one upload's payout rows (every admin role): outlet, field, period, amount, status, bank file,
 * UTR, paid date, failure reason, cancellation. Filters: status, field, search; paged (50 a page).
 *
 * Cancel actions (only when `canCancel` — GIFSY_ADMIN working inside the client): tick rows (only rows whose
 * cancelKind matches an action can be ticked) or pick "All unpaid / failed rows in this upload" (limited to the
 * field filter when one is set). The parent opens the confirmation dialog (onCancel).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apiJson, entryStatusLabel, fmtDate, inr, KIND_ACTION_LABEL, plural, ENTRY_STATUS_LABEL,
  type CancelKind, type PayoutEntryRow,
} from './payout-cancel-shared';

const PAGE_SIZE = 50;

export interface CancelRequest {
  kind: CancelKind;
  /** Ticked rows … */
  entryIds?: string[];
  /** … or every row of this kind in the upload (optionally one field). */
  batchId?: string;
  fieldId?: string;
  /** Plain-words description of what was chosen (shown in the dialog). */
  scopeLabel: string;
}

interface Props {
  batchId: string;
  refreshKey: number;
  fields: Array<{ fieldId: string; fieldName: string }>;
  status: string;
  fieldId: string;
  onStatusChange: (s: string) => void;
  onFieldChange: (f: string) => void;
  canCancel: boolean;
  onCancel: (req: CancelRequest) => void;
}

interface EntriesData {
  rows: PayoutEntryRow[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

export default function PayoutEntriesTable({
  batchId, refreshKey, fields, status, fieldId, onStatusChange, onFieldChange, canCancel, onCancel,
}: Props) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<EntriesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Ticked rows (kept across pages) → their cancel kind. */
  const [ticked, setTicked] = useState<Map<string, CancelKind>>(() => new Map());
  const [scope, setScope] = useState<'TICKED' | 'ALL'>('TICKED');
  const reqRef = useRef(0);

  // A new filter starts from page 1.
  useEffect(() => { setPage(1); }, [status, fieldId, search]);
  // After a cancellation (refreshKey) the ticks are stale — clear them.
  useEffect(() => { setTicked(new Map()); }, [refreshKey, batchId]);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ batchId, page: String(page), pageSize: String(PAGE_SIZE) });
    if (status) params.set('status', status);
    if (fieldId) params.set('fieldId', fieldId);
    if (search) params.set('search', search);
    const r = await apiJson<EntriesData>(`/api/admin/credits/payout-entries?${params.toString()}`);
    if (req !== reqRef.current) return;
    setLoading(false);
    if (!r.ok || !Array.isArray(r.data?.rows)) {
      setError(r.ok ? 'The payout rows came back empty.' : r.error);
      return;
    }
    setData(r.data);
  }, [batchId, page, status, fieldId, search]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const fieldName = useMemo(() => fields.find((f) => f.fieldId === fieldId)?.fieldName ?? null, [fields, fieldId]);

  function toggle(row: PayoutEntryRow) {
    if (!row.cancelKind) return;
    setTicked((cur) => {
      const next = new Map(cur);
      if (next.has(row.id)) next.delete(row.id); else next.set(row.id, row.cancelKind as CancelKind);
      return next;
    });
  }

  const tickedOf = (k: CancelKind) => [...ticked.entries()].filter(([, kind]) => kind === k).map(([id]) => id);

  function startCancel(kind: CancelKind) {
    const word = kind === 'UNPAID' ? 'unpaid' : 'failed';
    if (scope === 'TICKED') {
      const ids = tickedOf(kind);
      if (ids.length === 0) return;
      onCancel({ kind, entryIds: ids, scopeLabel: `${plural(ids.length, `ticked ${word} row`, `ticked ${word} rows`)}` });
    } else {
      onCancel({
        kind,
        batchId,
        ...(fieldId ? { fieldId } : {}),
        scopeLabel: `All ${word} rows in this upload${fieldName ? ` — field ${fieldName} only` : ''}`,
      });
    }
  }

  const rows = data?.rows ?? [];
  const pg = data?.pagination;

  return (
    <section aria-label="Payout rows" data-testid="payout-entries" className="px-5 py-4 border-b border-gray-100 space-y-3">
      <h4 className="text-sm font-semibold text-gray-900">Payout rows</h4>

      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-1 text-gray-600">
          Status
          <select
            value={status}
            onChange={(e) => onStatusChange(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1.5"
            aria-label="Filter payout rows by status"
          >
            <option value="">All statuses</option>
            {Object.entries(ENTRY_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-gray-600">
          Field
          <select
            value={fieldId}
            onChange={(e) => onFieldChange(e.target.value)}
            className="border border-gray-300 rounded-lg px-2 py-1.5"
            aria-label="Filter payout rows by field"
          >
            <option value="">All fields</option>
            {fields.map((f) => <option key={f.fieldId} value={f.fieldId}>{f.fieldName}</option>)}
          </select>
        </label>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); }}
        >
          <label className="flex flex-col gap-1 text-gray-600">
            Outlet
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              maxLength={100}
              placeholder="Outlet code or name"
              aria-label="Search payout rows by outlet"
              className="border border-gray-300 rounded-lg px-2 py-1.5"
            />
          </label>
          <button type="submit" className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50">Search</button>
        </form>
        {(status || fieldId || search) && (
          <button
            type="button"
            onClick={() => { onStatusChange(''); onFieldChange(''); setSearch(''); setSearchInput(''); }}
            className="px-3 py-1.5 text-gray-600 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {canCancel && (
        <div className="rounded-xl border border-red-200 bg-red-50/40 p-3 space-y-2 text-xs" data-testid="cancel-actions">
          <fieldset className="flex flex-wrap gap-4">
            <legend className="sr-only">Which rows to cancel</legend>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name={`cancel-scope-${batchId}`} checked={scope === 'TICKED'} onChange={() => setScope('TICKED')} />
              The rows I ticked ({tickedOf('UNPAID').length} unpaid, {tickedOf('FAILED').length} failed)
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name={`cancel-scope-${batchId}`} checked={scope === 'ALL'} onChange={() => setScope('ALL')} />
              All unpaid / failed rows in this upload{fieldName ? ` — field ${fieldName} only` : ''}
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            {(['UNPAID', 'FAILED'] as CancelKind[]).map((k) => {
              const disabled = scope === 'TICKED' && tickedOf(k).length === 0;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => startCancel(k)}
                  disabled={disabled}
                  aria-describedby={disabled ? `cancel-hint-${batchId}-${k}` : undefined}
                  className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {KIND_ACTION_LABEL[k]}
                </button>
              );
            })}
          </div>
          {scope === 'TICKED' && (
            <>
              {tickedOf('UNPAID').length === 0 && (
                <p id={`cancel-hint-${batchId}-UNPAID`} className="text-gray-600">Tick unpaid rows below (or choose “All … rows in this upload”) to cancel unpaid payouts.</p>
              )}
              {tickedOf('FAILED').length === 0 && (
                <p id={`cancel-hint-${batchId}-FAILED`} className="text-gray-600">Tick failed rows below (or choose “All … rows in this upload”) to cancel failed payouts.</p>
              )}
            </>
          )}
          <p className="text-gray-600">
            Only rows that were never paid can be cancelled. You will see exactly which rows (and any that can&apos;t be cancelled) before anything changes.
          </p>
        </div>
      )}

      {error ? (
        <div role="alert" data-testid="payout-entries-load-error" className="flex items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">
          <span>Couldn&apos;t load the payout rows: {error}</span>
          <button type="button" onClick={() => void load()} className="px-2.5 py-1 rounded-lg border border-red-200 bg-white hover:bg-red-50">
            Retry loading payout rows
          </button>
        </div>
      ) : !data ? (
        <p role="status" className="text-xs text-gray-500 animate-pulse">Loading payout rows…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-500" data-testid="payout-entries-empty">
          No payout rows{status || fieldId || search ? ' match these filters' : ' in this upload'}.
        </p>
      ) : (
        <div className={`overflow-x-auto max-h-96 border border-gray-200 rounded-lg ${loading ? 'opacity-60' : ''}`} aria-busy={loading || undefined}>
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-100 sticky top-0">
              <tr>
                {canCancel && <th className="px-2 py-2"><span className="sr-only">Tick to cancel</span></th>}
                {['Outlet', 'Field', 'Period', 'Amount', 'Status', 'Bank file', 'UTR', 'Paid on', 'Failure', 'Cancelled'].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((r) => (
                <tr key={r.id} data-testid={`entry-row-${r.id}`}>
                  {canCancel && (
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={ticked.has(r.id)}
                        disabled={!r.cancelKind}
                        onChange={() => toggle(r)}
                        aria-label={
                          r.cancelKind
                            ? `Tick ${r.outletName} ${inr(r.amountPaise)} (${entryStatusLabel(r.status)}) to cancel`
                            : `${r.outletName} ${inr(r.amountPaise)} (${entryStatusLabel(r.status)}) — can't be cancelled`
                        }
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 text-gray-800">
                    <span className="font-medium">{r.outletName}</span>
                    <span className="block font-mono text-gray-500">{r.outletId}</span>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{r.fieldName}</td>
                  <td className="px-3 py-2 text-gray-700">{r.period}</td>
                  <td className="px-3 py-2 text-right text-gray-900 whitespace-nowrap">
                    {inr(r.amountPaise)}
                    {r.tdsDeductedPaise > 0 && <span className="block text-gray-500">TDS {inr(r.tdsDeductedPaise)}</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="text-gray-800">{entryStatusLabel(r.status)}</span>
                    {r.heldByReversal && <span className="block text-amber-700">Held by a pending reversal</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-700">{r.bankFileCode ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-gray-700">{r.settledByTds ? <span className="font-sans">Settled by TDS</span> : r.utr ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{fmtDate(r.paidAt)}</td>
                  <td className="px-3 py-2 text-gray-700">
                    {r.failureReason ? (
                      <>
                        {r.failureReason}
                        {r.attemptedAt && <span className="block text-gray-500">attempted {fmtDate(r.attemptedAt)}</span>}
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {r.cancelledAt ? (
                      <>
                        {fmtDate(r.cancelledAt)}
                        {r.cancelReason && <span className="block text-gray-500">{r.cancelReason}</span>}
                      </>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pg && pg.total > 0 && (
        <div className="flex items-center justify-between gap-3 text-xs text-gray-600">
          <span>
            {plural(pg.total, 'row', 'rows')} · page {pg.page} of {Math.max(1, pg.pages)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pg.page <= 1 || loading}
              className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40"
            >
              Previous rows
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={pg.page >= pg.pages || loading}
              className="px-3 py-1 border border-gray-200 rounded-lg disabled:opacity-40"
            >
              Next rows
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
