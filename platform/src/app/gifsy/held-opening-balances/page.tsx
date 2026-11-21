'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Hourglass, Loader2, AlertTriangle, CheckCircle2, Lock, Search, X, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { getStoredUser } from '@/lib/auth-client';

// ── Types (mirror the backend held-opening-balances contract) ──────────────────────

type HeldStatus = 'PENDING' | 'APPLIED' | 'FAILED' | 'CANCELLED';
type ApplyMode = 'FULL_PASSBOOK' | 'OPENING_ADJUSTMENT';

interface HeldRow {
  id: string;
  outletCode: string;
  outletName: string | null;
  outletExists: boolean;
  hasWallet: boolean;
  walletHasActivity: boolean;
  closingPoints: number;
  eventCount: number;
  source: string;
  status: HeldStatus;
  appliedAt: string | null;
  appliedWalletId: string | null;
  applyMode: ApplyMode | null;
  sequencing: string | null;
  failureReason: string | null;
  cancelReason: string | null;
  createdAt: string;
}

interface Bucket { count: number; points: number }

interface ListPayload {
  clientId: string;
  total: number;
  page: number;
  pageSize: number;
  totals: Record<HeldStatus, Bucket>;
  rows: HeldRow[];
}

interface Preview {
  id: string;
  outletCode: string;
  closingPoints: number;
  canApply: boolean;
  blockedReason: string | null;
  mode: ApplyMode | null;
  walletId: string | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
  eventCount: number;
}

interface ApplyResult {
  id: string;
  status: HeldStatus;
  appliedAt: string | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
  failureReason: string | null;
}

interface ClientOption { slug: string; internalName: string; status: string }

const PAGE_SIZE = 50;
const STATUSES: HeldStatus[] = ['PENDING', 'APPLIED', 'FAILED', 'CANCELLED'];
const STATUS_LABEL: Record<HeldStatus, string> = {
  PENDING: 'Waiting',
  APPLIED: 'Applied',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};
const STATUS_BADGE: Record<HeldStatus, string> = {
  PENDING: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  APPLIED: 'bg-green-500/15 text-green-300 border-green-500/30',
  FAILED: 'bg-red-500/15 text-red-300 border-red-500/30',
  CANCELLED: 'bg-white/5 text-white/50 border-white/15',
};

// ── Formatting helpers ──────────────────────────────────────────────────────────

const fmtPts = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('en-IN');

/** dd Mon yyyy in IST, e.g. "21 Nov 2026". */
function fmtDateIst(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
}

function modeText(mode: ApplyMode | null, points: number): string {
  if (mode === 'FULL_PASSBOOK') return 'Post the full dated vendor passbook (wallet is empty)';
  if (mode === 'OPENING_ADJUSTMENT') {
    return `Wallet already has activity — post ONE opening-balance adjustment of ${fmtPts(points)} pts today; the dated vendor history stays on this record`;
  }
  return '—';
}

const canAct = (r: HeldRow) => r.status === 'PENDING' || r.status === 'FAILED';
const rowReason = (r: HeldRow) => r.failureReason ?? r.cancelReason ?? null;

function readClientIdFromUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('clientId') ?? '';
  } catch {
    return '';
  }
}

/** Keep ?clientId= in the URL (native History API — Next integrates it with the router). */
function writeClientIdToUrl(clientId: string) {
  try {
    const url = new URL(window.location.href);
    if (clientId) url.searchParams.set('clientId', clientId);
    else url.searchParams.delete('clientId');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* non-critical */
  }
}

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30';

// ── Page ─────────────────────────────────────────────────────────────────────────

export default function GifsyHeldOpeningBalancesPage() {
  const [role, setRole] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setRole(getStoredUser()?.role ?? null);
    setReady(true);
  }, []);
  const isOwner = role === 'GIFSY_ADMIN';

  // Client picker
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');

  // Filters
  const [status, setStatus] = useState<HeldStatus | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  // List
  const [data, setData] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reqSeq = useRef(0);

  // Actions
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [applyTarget, setApplyTarget] = useState<{ row: HeldRow; preview: Preview } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<HeldRow | null>(null);

  useEffect(() => {
    if (!ready || !isOwner) return;
    setClientId(readClientIdFromUrl());
    void (async () => {
      const res = await api.get<{ clients: ClientOption[] }>('/api/gifsy/clients');
      if (res.success) setClients(res.data?.clients ?? []);
      else setClientsError(res.error || 'Could not load clients');
    })();
  }, [ready, isOwner]);

  const load = useCallback(async () => {
    if (!clientId) { setData(null); return; }
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ clientId, page: String(page), pageSize: String(PAGE_SIZE) });
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    const res = await api.get<ListPayload>(`/api/admin/held-opening-balances?${params.toString()}`);
    if (seq !== reqSeq.current) return; // a newer request superseded this one
    if (res.success) setData(res.data);
    else { setData(null); setError(res.error || 'Could not load held opening balances'); }
    setLoading(false);
  }, [clientId, status, q, page]);

  useEffect(() => { if (ready && isOwner) void load(); }, [ready, isOwner, load]);

  function chooseClient(id: string) {
    setClientId(id);
    setPage(1);
    setNotice(null);
    setError(null);
    writeClientIdToUrl(id);
  }

  async function startApply(row: HeldRow) {
    setPreviewingId(row.id);
    setError(null);
    setNotice(null);
    const res = await api.get<Preview>(
      `/api/admin/held-opening-balances/${encodeURIComponent(row.id)}/preview?clientId=${encodeURIComponent(clientId)}`,
    );
    setPreviewingId(null);
    if (res.success) setApplyTarget({ row, preview: res.data });
    else setError(`Could not preview ${row.outletCode}: ${res.error}`);
  }

  if (!ready) return null;
  if (!isOwner) {
    return (
      <div className="max-w-lg mx-auto mt-10 border border-white/10 rounded-xl px-6 py-8 text-center">
        <Lock className="w-6 h-6 mx-auto text-white/40" />
        <h1 className="text-lg font-bold text-white mt-3">Owner-only</h1>
        <p className="text-sm text-white/50 mt-1">
          Only the platform owner (GIFSY_ADMIN) can view held opening balances.
        </p>
      </div>
    );
  }

  const totals = data?.totals;
  const rows = data?.rows ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / (data.pageSize || PAGE_SIZE))) : 1;
  const busy = previewingId !== null;

  return (
    <div className="space-y-6 min-w-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Hourglass className="w-5 h-5 text-white/60" />Held opening balances
          </h1>
          <p className="text-sm text-white/50 mt-0.5">
            Vendor closing balances for outlets that had no wallet at migration. Each is posted
            automatically when the outlet&apos;s wallet is created (KYC approval).
          </p>
        </div>
        <div className="w-full sm:w-64">
          <label htmlFor="held-client" className="block text-xs font-medium text-white/50 mb-1.5">Client</label>
          <select
            id="held-client"
            value={clientId}
            onChange={(e) => chooseClient(e.target.value)}
            className={INPUT_CLS}
          >
            <option value="">Choose a client…</option>
            {clientId && !clients.some((c) => c.slug === clientId) && (
              <option value={clientId}>{clientId}</option>
            )}
            {clients.map((c) => (
              <option key={c.slug} value={c.slug}>{c.internalName} ({c.slug})</option>
            ))}
          </select>
        </div>
      </div>

      {clientsError && <ErrorBanner message={`Could not load clients: ${clientsError}`} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && (
        <div role="status" className="flex items-start gap-2 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3 text-sm text-green-300">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /><span className="min-w-0 break-words">{notice}</span>
        </div>
      )}

      {!clientId && (
        <div className="border border-white/10 rounded-xl px-4 py-12 text-center text-white/40 text-sm">
          Choose a client to see its held opening balances.
        </div>
      )}

      {clientId && (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="totals">
            {STATUSES.map((s) => {
              const b = totals?.[s] ?? { count: 0, points: 0 };
              const red = s === 'FAILED' && b.count > 0;
              return (
                <div
                  key={s}
                  data-testid={`tile-${s}`}
                  className={`rounded-xl border px-4 py-3 min-w-0 ${red ? 'border-red-500/40 bg-red-500/10' : 'border-white/10'}`}
                >
                  <p className={`text-xs ${red ? 'text-red-300' : 'text-white/50'}`}>{STATUS_LABEL[s]}</p>
                  <p className={`text-lg font-bold ${red ? 'text-red-300' : 'text-white'}`}>{fmtPts(b.count)}</p>
                  <p className={`text-xs truncate ${red ? 'text-red-300/80' : 'text-white/40'}`}>{fmtPts(b.points)} pts</p>
                </div>
              );
            })}
          </div>

          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="w-full sm:w-48">
              <label htmlFor="held-status" className="block text-xs font-medium text-white/50 mb-1.5">Status</label>
              <select
                id="held-status"
                value={status}
                onChange={(e) => { setStatus(e.target.value as HeldStatus | ''); setPage(1); }}
                className={INPUT_CLS}
              >
                <option value="">All</option>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
            <form
              className="flex gap-2 w-full sm:w-auto sm:flex-1 sm:max-w-md items-end"
              onSubmit={(e) => { e.preventDefault(); setQ(searchInput.trim()); setPage(1); }}
            >
              <div className="flex-1 min-w-0">
                <label htmlFor="held-search" className="block text-xs font-medium text-white/50 mb-1.5">Outlet code</label>
                <input
                  id="held-search"
                  type="search"
                  value={searchInput}
                  placeholder="Search outlet code"
                  onChange={(e) => setSearchInput(e.target.value)}
                  className={INPUT_CLS}
                />
              </div>
              <button
                type="submit"
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-white/15 text-white/70 rounded-lg hover:bg-white/5"
              >
                <Search className="w-4 h-4" />Search
              </button>
            </form>
          </div>

          {/* List */}
          {loading && (
            <div className="border border-white/10 rounded-xl px-4 py-12 text-center text-white/40 text-sm">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-hidden="true" />Loading held opening balances…
            </div>
          )}
          {!loading && data && rows.length === 0 && (
            <div className="border border-white/10 rounded-xl px-4 py-12 text-center text-white/40 text-sm">
              {status || q ? 'No held opening balances match these filters.' : 'No held opening balances for this client'}
            </div>
          )}
          {!loading && rows.length > 0 && (
            <>
              {/* md+ : table */}
              <div className="hidden md:block border border-white/10 rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-white/40 border-b border-white/10">
                      <th scope="col" className="px-4 py-2.5 font-medium">Outlet code</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Outlet name</th>
                      <th scope="col" className="px-4 py-2.5 font-medium text-right">Points</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Applied</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Reason</th>
                      <th scope="col" className="px-4 py-2.5 font-medium"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} data-testid={`row-${r.id}`} className="border-b border-white/5 last:border-0 align-top">
                        <td className="px-4 py-3 font-mono text-white">{r.outletCode}</td>
                        <td className="px-4 py-3"><OutletName row={r} /></td>
                        <td className="px-4 py-3 text-right font-mono text-white">{fmtPts(r.closingPoints)}</td>
                        <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                        <td className="px-4 py-3 text-white/60 whitespace-nowrap">{fmtDateIst(r.appliedAt)}</td>
                        <td className="px-4 py-3 max-w-xs"><Reason row={r} /></td>
                        <td className="px-4 py-3">
                          <RowActions row={r} busy={busy} previewingId={previewingId} onApply={startApply} onCancel={setCancelTarget} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* < md : stacked cards */}
              <ul className="md:hidden space-y-3">
                {rows.map((r) => (
                  <li key={r.id} data-testid={`card-${r.id}`} className="border border-white/10 rounded-xl px-4 py-3 space-y-2 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-white break-all">{r.outletCode}</p>
                        <OutletName row={r} />
                      </div>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="flex justify-between gap-3 text-sm">
                      <span className="text-white/40">Points</span>
                      <span className="font-mono text-white">{fmtPts(r.closingPoints)}</span>
                    </div>
                    <div className="flex justify-between gap-3 text-sm">
                      <span className="text-white/40">Applied</span>
                      <span className="text-white/60">{fmtDateIst(r.appliedAt)}</span>
                    </div>
                    <Reason row={r} />
                    <RowActions row={r} busy={busy} previewingId={previewingId} onApply={startApply} onCancel={setCancelTarget} />
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Pagination */}
          {data && data.total > 0 && (
            <nav aria-label="Pagination" className="flex items-center justify-between gap-3 text-sm text-white/50">
              <span>
                Page {data.page} of {totalPages} · {fmtPts(data.total)} rows
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={loading || page <= 1}
                  className="inline-flex items-center gap-1 px-3 py-1.5 border border-white/15 rounded-lg hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={loading || page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 border border-white/15 rounded-lg hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next<ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </nav>
          )}
        </>
      )}

      {applyTarget && (
        <ApplyDialog
          clientId={clientId}
          row={applyTarget.row}
          preview={applyTarget.preview}
          onClose={() => setApplyTarget(null)}
          onApplied={(msg) => { setApplyTarget(null); setNotice(msg); void load(); }}
          onFailedResult={() => { void load(); }}
        />
      )}

      {cancelTarget && (
        <CancelDialog
          clientId={clientId}
          row={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onCancelled={(msg) => { setCancelTarget(null); setNotice(msg); void load(); }}
        />
      )}
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────────

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-300">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="flex-1 min-w-0 break-words">{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss error" className="shrink-0 text-red-300/70 hover:text-red-200">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: HeldStatus }) {
  return (
    <span className={`inline-block shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border ${STATUS_BADGE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function OutletName({ row }: { row: HeldRow }) {
  if (!row.outletExists) return <span className="text-white/40 italic text-sm">Not on the portal yet</span>;
  return <span className="text-white/80 text-sm break-words">{row.outletName ?? '—'}</span>;
}

function Reason({ row }: { row: HeldRow }) {
  const reason = rowReason(row);
  if (!reason) return <span className="text-white/30 text-sm">—</span>;
  return (
    <span className={`text-sm break-words ${row.failureReason ? 'text-red-300' : 'text-white/60'}`}>{reason}</span>
  );
}

function RowActions({
  row, busy, previewingId, onApply, onCancel,
}: {
  row: HeldRow;
  busy: boolean;
  previewingId: string | null;
  onApply: (r: HeldRow) => void;
  onCancel: (r: HeldRow) => void;
}) {
  if (!canAct(row)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {row.hasWallet ? (
        <button
          type="button"
          onClick={() => onApply(row)}
          disabled={busy}
          aria-label={`Apply now for ${row.outletCode}`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--brand-primary)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {previewingId === row.id && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
          Apply now
        </button>
      ) : (
        row.status === 'PENDING' && (
          <span className="text-xs text-white/40">Waits for KYC approval — applied automatically</span>
        )
      )}
      <button
        type="button"
        onClick={() => onCancel(row)}
        disabled={busy}
        aria-label={`Cancel held balance for ${row.outletCode}`}
        className="px-3 py-1.5 text-xs font-medium border border-white/15 text-white/70 rounded-lg hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Cancel
      </button>
    </div>
  );
}

/** Radix dialog with an explicit role="dialog" + aria-modal and a focus trap. */
function ActionDialog({
  title, onClose, locked, children,
}: {
  title: string;
  onClose: () => void;
  locked: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o && !locked) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content
          role="dialog"
          aria-modal="true"
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100%-2rem)] max-w-lg max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-xl p-6"
        >
          <div className="flex items-start justify-between gap-4 mb-4">
            <Dialog.Title className="text-lg font-semibold text-gray-900">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={locked}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ApplyDialog({
  clientId, row, preview, onClose, onApplied, onFailedResult,
}: {
  clientId: string;
  row: HeldRow;
  preview: Preview;
  onClose: () => void;
  onApplied: (msg: string) => void;
  onFailedResult: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedReason, setFailedReason] = useState<string | null>(null);

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setFailedReason(null);
    const body = reason.trim() ? { reason: reason.trim() } : {};
    const res = await api.post<ApplyResult>(
      `/api/admin/held-opening-balances/${encodeURIComponent(row.id)}/apply?clientId=${encodeURIComponent(clientId)}`,
      body,
    );
    setSubmitting(false);
    if (!res.success) { setError(res.error || 'Apply failed'); return; }
    if (res.data?.status === 'APPLIED') {
      onApplied(
        `Applied ${fmtPts(preview.closingPoints)} pts to ${row.outletCode} — balance ${fmtPts(res.data.balanceBefore)} → ${fmtPts(res.data.balanceAfter)}.`,
      );
      return;
    }
    // Anything other than APPLIED (FAILED, or an unexpected status) is NOT a success — say so loudly.
    setFailedReason(
      res.data?.failureReason
        || `The apply did not complete (status ${res.data?.status ?? 'unknown'}).`,
    );
    onFailedResult();
  }

  return (
    <ActionDialog title={`Apply held balance — ${row.outletCode}`} onClose={onClose} locked={submitting}>
      <div className="space-y-4 text-sm text-gray-700">
        <dl className="space-y-2">
          <div className="flex justify-between gap-4">
            <dt className="text-gray-500">Outlet</dt>
            <dd className="text-right font-medium text-gray-900 break-words min-w-0">
              {row.outletCode}{row.outletName ? ` · ${row.outletName}` : ''}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-gray-500">Points</dt>
            <dd className="font-mono text-gray-900">{fmtPts(preview.closingPoints)}</dd>
          </div>
          <div>
            <dt className="text-gray-500">What will happen</dt>
            <dd className="text-gray-900 mt-0.5" data-testid="apply-mode">{modeText(preview.mode, preview.closingPoints)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-gray-500">Balance</dt>
            <dd className="font-mono text-gray-900" data-testid="apply-balance">
              {fmtPts(preview.balanceBefore)} → {fmtPts(preview.balanceAfter)}
            </dd>
          </div>
        </dl>

        {!preview.canApply && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{preview.blockedReason || 'This balance cannot be applied right now.'}</span>
          </div>
        )}

        <div>
          <label htmlFor="apply-reason" className="block text-xs font-medium text-gray-600 mb-1">Reason (optional)</label>
          <textarea
            id="apply-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            disabled={submitting}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-gray-500"
          />
        </div>

        {failedReason && (
          <div role="alert" data-testid="apply-failed" className="flex items-start gap-2 bg-red-50 border border-red-300 rounded-xl px-3 py-2.5 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span><strong>Apply failed:</strong> {failedReason}</span>
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {failedReason ? 'Close' : 'Back'}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={submitting}
            disabled={!preview.canApply || failedReason !== null}
            onClick={confirm}
            data-testid="confirm-apply"
          >
            Confirm apply
          </Button>
        </div>
      </div>
    </ActionDialog>
  );
}

function CancelDialog({
  clientId, row, onClose, onCancelled,
}: {
  clientId: string;
  row: HeldRow;
  onClose: () => void;
  onCancelled: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();

  async function confirm() {
    if (submitting || !trimmed) return;
    setSubmitting(true);
    setError(null);
    const res = await api.post<HeldRow>(
      `/api/admin/held-opening-balances/${encodeURIComponent(row.id)}/cancel?clientId=${encodeURIComponent(clientId)}`,
      { reason: trimmed },
    );
    setSubmitting(false);
    if (!res.success) { setError(res.error || 'Cancel failed'); return; }
    onCancelled(`Cancelled the held balance for ${row.outletCode}.`);
  }

  return (
    <ActionDialog title={`Cancel held balance — ${row.outletCode}`} onClose={onClose} locked={submitting}>
      <div className="space-y-4 text-sm text-gray-700">
        <p>
          {fmtPts(row.closingPoints)} pts held for <strong>{row.outletCode}</strong> will NOT be posted to the
          outlet&apos;s wallet — not now and not at KYC approval.
        </p>
        <div>
          <label htmlFor="cancel-reason" className="block text-xs font-medium text-gray-600 mb-1">
            Reason (required)
          </label>
          <textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            required
            aria-required="true"
            disabled={submitting}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-gray-500"
          />
          {!trimmed && <p className="text-[11px] text-gray-500 mt-1">A reason is required to cancel.</p>}
        </div>
        {error && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Back</Button>
          <Button
            type="button"
            variant="destructive"
            loading={submitting}
            disabled={!trimmed}
            onClick={confirm}
            data-testid="confirm-cancel"
          >
            Cancel held balance
          </Button>
        </div>
      </div>
    </ActionDialog>
  );
}
