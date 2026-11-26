'use client';

/* ─── Off-portal payments register (/admin/off-portal-payments) ─────────────────────────────────────────
   Payments ALREADY MADE outside the portal (bank / UPI / gift), recorded so TDS (194R / 194C), Fund Reconciliation,
   the outlet's payout history and the Payments Report count them. Backend: api/src/off-portal-payments.

   Who: GIFSY_ADMIN (assumed into the client) uploads + voids — the page shows those controls ONLY when the register API
   says `canWrite`. CLIENT_ADMIN sees the register read-only; phone / PAN / bank / UPI are masked for them (`piiMasked`).
   Sections: Upload (canWrite only) · Register (filters, totals, paged table, export, void) · Upload history.
──────────────────────────────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, EyeOff, RefreshCw } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';
import { formatISTDate, formatISTDateTime } from '@/lib/ist-date';
import {
  categoryShort,
  formatPaiseString,
  MODE_LABEL,
  offPortalApi,
  STREAM_LABEL,
  VOID_REASON_MAX,
  VOID_REASON_MIN,
  type OffPortalFilters,
  type OffPortalList,
  type OffPortalPayment,
  type OffPortalUpload,
} from '@/lib/off-portal-payments';
import { EmptyBlock, ErrorBlock, LoadingBlock, inputCls } from '../fund/_components/fund-ui';
import { OffPortalUploadPanel } from './_components/upload-panel';

const PAGE_SIZE = 50;
const EMPTY_FILTERS: OffPortalFilters = { from: '', to: '', q: '', stream: '', mode: '', status: 'ACTIVE', uploadId: '' };

export default function OffPortalPaymentsPage() {
  const [draft, setDraft] = useState<OffPortalFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<OffPortalFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<OffPortalList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<OffPortalPayment | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const exportAction = useDownloadAction();
  const reqRef = useRef(0);

  // Sequence guard: a slower earlier reply never overwrites a newer one (money + PII screen).
  useEffect(() => {
    const my = ++reqRef.current;
    setLoading(true);
    setError(null);
    void offPortalApi.list(applied, { page, pageSize: PAGE_SIZE }).then((r) => {
      if (my !== reqRef.current) return;
      if (r.ok && r.data && Array.isArray(r.data.rows)) setList(r.data);
      else setError(r.ok ? 'The register could not be read. Please refresh the page.' : r.message);
      setLoading(false);
    });
  }, [applied, page, tick]);

  const refreshAll = useCallback(() => {
    setTick((t) => t + 1);
    setHistoryTick((t) => t + 1);
  }, []);

  function applyFilters(e?: React.FormEvent) {
    e?.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) {
      setFilterError('"Paid from" is after "Paid to" — the register was not updated.');
      return;
    }
    setFilterError(null);
    setPage(1);
    setApplied({ ...draft });
    setTick((t) => t + 1);
  }

  function showUpload(uploadId: string) {
    const f = { ...EMPTY_FILTERS, status: 'ALL' as const, uploadId };
    setDraft(f);
    setApplied(f);
    setPage(1);
  }

  const canWrite = !!list?.canWrite;
  const filtersDirty = JSON.stringify(draft) !== JSON.stringify(applied);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A2E]">Off-portal payments</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            Payments made outside the portal (bank transfer, UPI or gift), recorded so that TDS, Fund Reconciliation, each
            outlet&apos;s payout history and the Payments Report include them.
            {list && !canWrite && ' Read-only view — Gifsy records and voids these payments.'}
          </p>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden /> Refresh
        </button>
      </div>

      {canWrite && <OffPortalUploadPanel onRecorded={refreshAll} />}

      {/* ── Register ── */}
      <section aria-labelledby="opp-register-h" className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id="opp-register-h" className="text-sm font-semibold text-gray-900">Register</h2>
          <div className="flex flex-col items-end gap-1.5">
            <button
              type="button"
              onClick={() => void exportAction.run(offPortalApi.exportUrl(applied), { fallbackFileName: 'off-portal-payments.xlsx' })}
              disabled={exportAction.blocked || !list}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> {downloadButtonLabel(exportAction, 'Export Excel')}
            </button>
            <DownloadActionStatus action={exportAction} />
          </div>
        </div>

        <form onSubmit={applyFilters} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-3 lg:grid-cols-7" aria-label="Register filters">
          <FilterField id="opp-from" label="Paid from">
            <input id="opp-from" type="date" className={inputCls} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </FilterField>
          <FilterField id="opp-to" label="Paid to">
            <input id="opp-to" type="date" className={inputCls} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </FilterField>
          <FilterField id="opp-q" label="Search">
            <input id="opp-q" type="search" maxLength={100} placeholder="Outlet ID, name or UTR" className={inputCls} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </FilterField>
          <FilterField id="opp-stream" label="Type">
            <select id="opp-stream" className={inputCls} value={draft.stream} onChange={(e) => setDraft({ ...draft, stream: e.target.value as OffPortalFilters['stream'] })}>
              <option value="">All types</option>
              <option value="INCENTIVE">Incentive</option>
              <option value="VISIBILITY">Visibility</option>
            </select>
          </FilterField>
          <FilterField id="opp-mode" label="Cash or gift">
            <select id="opp-mode" className={inputCls} value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as OffPortalFilters['mode'] })}>
              <option value="">Cash and gift</option>
              <option value="CASH">Cash</option>
              <option value="GIFT">Gift</option>
            </select>
          </FilterField>
          <FilterField id="opp-status" label="Status">
            <select id="opp-status" className={inputCls} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as OffPortalFilters['status'] })}>
              <option value="ACTIVE">Recorded (not void)</option>
              <option value="VOIDED">Void only</option>
              <option value="ALL">All</option>
            </select>
          </FilterField>
          <div className="flex gap-2">
            <button type="submit" disabled={loading && !filtersDirty} className="rounded-lg bg-[var(--brand-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
              Apply
            </button>
            <button
              type="button"
              onClick={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); setPage(1); setFilterError(null); }}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Clear
            </button>
          </div>
        </form>
        {applied.uploadId && (
          <p className="text-xs text-gray-600">Showing one upload only (all statuses). Use Clear to see the whole register.</p>
        )}
        {filterError && <p role="alert" className="text-xs font-medium text-red-700">{filterError}</p>}
        {filtersDirty && !filterError && <p className="text-xs text-amber-800">Filters changed — press Apply to update the register.</p>}

        {notice && (
          <div role="status" data-testid="opp-notice" className="flex flex-wrap items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="ml-auto text-xs font-medium underline">Dismiss</button>
          </div>
        )}

        {list?.piiMasked && (
          <p data-testid="opp-pii-masked" className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
            <EyeOff className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            Phone, PAN, bank account and UPI ID are partly hidden on this screen and in the export. Gifsy can see them in full.
          </p>
        )}

        {error && <ErrorBlock message={list ? `${error} The figures below are from the last successful load.` : error} onRetry={() => setTick((t) => t + 1)} />}
        {loading && !list && <LoadingBlock label="Loading the register…" />}

        {list && (
          <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={loading || undefined}>
            <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-xl" data-testid="opp-totals">
              <Total label="Payments matching the filters" value={`${list.totals.count.toLocaleString('en-IN')} · ${formatPaiseString(list.totals.amountPaise)}`} />
              {applied.status !== 'ACTIVE' && (
                <Total label="Of which recorded (not void)" value={`${list.totals.liveCount.toLocaleString('en-IN')} · ${formatPaiseString(list.totals.liveAmountPaise)}`} />
              )}
            </div>

            {list.rows.length === 0 ? (
              <EmptyBlock>No off-portal payments match these filters.</EmptyBlock>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-xs" data-testid="opp-register-table">
                  <thead className="bg-gray-50 text-left text-gray-600">
                    <tr>
                      <th className="px-3 py-2">Paid on</th><th className="px-3 py-2">Outlet</th><th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Type</th><th className="px-3 py-2">Month</th><th className="px-3 py-2">UTR / reference</th>
                      <th className="px-3 py-2">PAN</th><th className="px-3 py-2">Phone · Bank · UPI</th><th className="px-3 py-2">TDS</th>
                      <th className="px-3 py-2">Warnings</th><th className="px-3 py-2">Status</th>
                      {canWrite && <th className="px-3 py-2"><span className="sr-only">Actions</span></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {list.rows.map((r) => (
                      <tr key={r.id} className={`align-top ${r.voidedAt ? 'bg-gray-50 text-gray-500' : ''}`}>
                        <td className="px-3 py-2 whitespace-nowrap">{formatISTDate(r.paymentDate) || r.paymentDate}</td>
                        <td className="px-3 py-2">
                          <div className="font-mono">{r.outletCode}</div>
                          <div>{r.outletName}</div>
                          {!r.onPortalNow && <div className="text-gray-500">Not on the portal</div>}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${r.voidedAt ? 'line-through' : ''}`}>{formatPaiseString(r.amountPaise)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{STREAM_LABEL[r.payoutStream] ?? r.payoutStream} · {MODE_LABEL[r.paymentMode] ?? r.paymentMode}</td>
                        <td className="px-3 py-2">{r.period}</td>
                        <td className="px-3 py-2 font-mono">{r.utr || '—'}</td>
                        <td className="px-3 py-2 font-mono">
                          {r.panNumber || '—'}
                          <div className="font-sans text-gray-500">{r.panSource === 'FILE' ? 'from file' : r.panSource === 'PORTAL' ? 'from portal' : 'no PAN'}</div>
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px]">
                          <div>{r.phone || '—'}</div>
                          {(r.bankAccountNumber || r.ifsc) && <div>{r.bankAccountNumber || '—'}{r.ifsc ? ` · ${r.ifsc}` : ''}</div>}
                          {r.upiId && <div>{r.upiId}</div>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {r.tdsSection} · {r.tdsMethodology === 'DEDUCT' ? 'Deduct' : 'Gross-up'}
                          {r.replacesTdsEntry && <div className="text-gray-500">replaces an earlier TDS entry</div>}
                        </td>
                        <td className="px-3 py-2">
                          {r.flags.length ? (
                            <span className="flex flex-wrap gap-1">
                              {r.flags.map((f) => <span key={f} className="rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-800">{categoryShort(f)}</span>)}
                            </span>
                          ) : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-3 py-2 min-w-[9rem]">
                          {r.voidedAt ? (
                            <>
                              <span className="inline-block rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-700">Void</span>
                              <div className="mt-0.5 text-[11px]">{formatISTDate(r.voidedAt)}{r.voidReason ? ` — ${r.voidReason}` : ''}</div>
                            </>
                          ) : (
                            <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800">Recorded</span>
                          )}
                        </td>
                        {canWrite && (
                          <td className="px-3 py-2">
                            {!r.voidedAt && (
                              <button
                                type="button"
                                onClick={() => setVoiding(r)}
                                className="rounded border border-red-200 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50"
                                aria-label={`Void ${formatPaiseString(r.amountPaise)} paid to ${r.outletCode} on ${r.paymentDate}`}
                              >
                                Void
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {list.totalPages > 1 && (
              <div className="mt-3 flex items-center justify-between text-xs text-gray-600">
                <span>Page {list.page} of {list.totalPages} · {list.totalRows.toLocaleString('en-IN')} payments</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setPage(list.page - 1)} disabled={loading || list.page <= 1} className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 disabled:opacity-50">
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Previous
                  </button>
                  <button type="button" onClick={() => setPage(list.page + 1)} disabled={loading || list.page >= list.totalPages} className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 disabled:opacity-50">
                    Next <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <UploadHistory refreshKey={historyTick} onShow={showUpload} />

      {voiding && (
        <VoidDialog
          payment={voiding}
          onClose={() => setVoiding(null)}
          onVoided={(message) => {
            setVoiding(null);
            setNotice(message);
            setTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

function FilterField({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      {children}
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 px-4 py-3">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="mt-0.5 text-base font-bold tabular-nums text-gray-900">{value}</p>
    </div>
  );
}

/** Void one entry: a reason (≥ 5 characters) is required; one click = one request; server errors shown as-is. */
function VoidDialog({ payment, onClose, onVoided }: { payment: OffPortalPayment; onClose: () => void; onVoided: (message: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const trimmed = reason.trim();
  const valid = trimmed.length >= VOID_REASON_MIN && trimmed.length <= VOID_REASON_MAX;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const r = await offPortalApi.void(payment.id, trimmed);
    inFlight.current = false;
    setBusy(false);
    if (r.ok) onVoided(r.data.message || 'Voided.');
    else setError(r.status ? r.message : `${r.message} It may or may not have been voided — refresh the register to check.`);
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o && !busy) onClose(); }}
      title="Void this off-portal payment?"
      description={`${formatPaiseString(payment.amountPaise)} to ${payment.outletName} (${payment.outletCode}), paid on ${formatISTDate(payment.paymentDate) || payment.paymentDate}.`}
    >
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-gray-600">
          Use this only for an entry recorded by mistake. A voided payment stops counting in TDS, payout history and the
          Payments Report, and Fund Reconciliation shows it returned today. It stays in the register, marked void. This
          cannot be undone — record it again if needed.
        </p>
        <div>
          <label htmlFor="opp-void-reason" className="mb-1 block text-xs font-medium text-gray-700">Reason (required, at least {VOID_REASON_MIN} characters)</label>
          <textarea
            id="opp-void-reason"
            className={inputCls}
            rows={3}
            maxLength={VOID_REASON_MAX}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            aria-describedby="opp-void-count"
          />
          <p id="opp-void-count" className="mt-1 text-xs text-gray-500">{trimmed.length}/{VOID_REASON_MAX}</p>
        </div>
        {error && <ErrorBlock message={error} />}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            Keep it
          </button>
          <button type="submit" disabled={!valid || busy} className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? 'Voiding…' : 'Void payment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UploadHistory({ refreshKey, onShow }: { refreshKey: number; onShow: (uploadId: string) => void }) {
  const [rows, setRows] = useState<OffPortalUpload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const reqRef = useRef(0);

  useEffect(() => {
    const my = ++reqRef.current;
    setError(null);
    void offPortalApi.uploads().then((r) => {
      if (my !== reqRef.current) return;
      if (r.ok && Array.isArray(r.data)) setRows(r.data);
      else setError(r.ok ? 'The upload history could not be read.' : r.message);
    });
  }, [refreshKey, retry]);

  return (
    <section aria-labelledby="opp-history-h" className="space-y-3 rounded-xl border border-gray-200 bg-white p-5">
      <h2 id="opp-history-h" className="text-sm font-semibold text-gray-900">Upload history</h2>
      {error && <ErrorBlock message={`Could not load the upload history: ${error}`} onRetry={() => setRetry((t) => t + 1)} />}
      {!rows && !error && <LoadingBlock label="Loading upload history…" />}
      {rows && rows.length === 0 && <EmptyBlock>No files uploaded yet.</EmptyBlock>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-xs" data-testid="opp-history-table">
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-3 py-2">Uploaded</th><th className="px-3 py-2">File</th><th className="px-3 py-2 text-right">Rows in file</th>
                <th className="px-3 py-2 text-right">Recorded</th><th className="px-3 py-2 text-right">Not recorded (errors)</th>
                <th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Warnings ticked</th><th className="px-3 py-2">By</th>
                <th className="px-3 py-2"><span className="sr-only">Show</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((u) => {
                const acks = u.acknowledged && typeof u.acknowledged === 'object' ? Object.entries(u.acknowledged) : [];
                return (
                  <tr key={u.id} className="align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{formatISTDateTime(u.createdAt)}</td>
                    <td className="px-3 py-2 break-all">{u.fileName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{u.rowsInFile}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{u.recordedCount}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${u.skippedCount ? 'font-semibold text-red-700' : ''}`}>{u.skippedCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatPaiseString(u.totalPaise)}</td>
                    <td className="px-3 py-2">{acks.length ? acks.map(([c, n]) => `${categoryShort(c)} (${n})`).join(', ') : 'None'}</td>
                    <td className="px-3 py-2">{u.uploadedBy ?? '—'}</td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => onShow(u.id)} className="text-[11px] font-medium text-[var(--brand-primary)] underline">
                        Show in register
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
