'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Clock,
  CheckCircle,
  XCircle,
  Download,
  BarChart2,
  ChevronDown,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import { jsonToSheetSafe } from '@/lib/xlsx-safe';
import { downloadBlob } from '@/lib/download';
import BatchEvidencePanel from './_components/BatchEvidencePanel';
import ReversalEngineAttentionBanner from './_components/ReversalEngineAttentionBanner';
import { formatInrPaise } from '@/lib/money-format';
import { ENTRY_STATUS_TEXT } from '@/lib/payout-reversal-copy';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  PENDING_CONFIRM: {
    bg: 'bg-amber-50',  text: 'text-amber-700',
    icon: <Clock className="w-3.5 h-3.5" />,
  },
  CONFIRMED: {
    bg: 'bg-emerald-50', text: 'text-emerald-700',
    icon: <CheckCircle className="w-3.5 h-3.5" />,
  },
  PARTIALLY_REVERSED: {
    bg: 'bg-orange-50',  text: 'text-orange-700',
    icon: <XCircle className="w-3.5 h-3.5" />,
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface BatchSummary {
  id:               string;
  batchCode:        string;
  period:           string;
  status:           string;
  uploadedBy:       string;
  uploadedAt:       string;
  confirmedBy?:     string;
  confirmedAt?:     string;
  totalOutlets:     number;
  totalPoints:      string | number;
  /** totalPayoutPaise from the API — integer paise (BigInt serialised to number). */
  totalPayoutPaise: string | number;
}

interface BatchRow {
  rowNum:    number;
  outletId:  string;
  outletName: string;
  fieldId:   string;
  fieldName: string;
  amount:    number;
  narration: string;
  awardType: 'POINTS' | 'PAYOUT';
  status:    'OK' | 'ERROR' | 'SKIP';
  errors:    string[];
}

interface BatchDetail extends BatchSummary {
  rows: BatchRow[];
}

interface Pagination {
  page:  number;
  limit: number;
  total: number;
  pages: number;
}

const PAGE_SIZE = 50;

interface ReversalTarget {
  batchId:      string;
  outletId:     string;
  outletName:   string;
  fieldId:      string;
  fieldName:    string;
  period:       string;
  awardType:    'POINTS' | 'PAYOUT';
  /** Original amount in integer paise (PAYOUT) or whole points (POINTS). */
  originalPaise: number;
}

/** WP5 — a payout entry a PAYOUT reversal may pick (reversal engine V2 only — SHADOW = LEGACY for payouts, owner 2026-11-16). */
interface PayoutReversalEntry {
  id:          string;
  /** Integer paise. */
  amountPaise: number;
  status:      'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'REVERSED' | string;
  period:      string;
  createdAt:   string;
  selectable:  boolean;
  blockedBy:   'REVERSED' | 'RESERVED' | 'CONSUMED' | 'ZERO' | 'PAID_194C' | null;
}

const ENTRY_BLOCK_TEXT: Record<string, string> = {
  REVERSED: 'Already reversed',
  RESERVED: 'Held by another pending reversal',
  CONSUMED: 'Already covered by an approved reversal',
  ZERO:     'No amount',
  // Owner D1 (2026-11-19): every tenant — the server refuses it too.
  PAID_194C: "Paid 194C payout — 194C payouts can't be reversed once paid",
};

/** Only unpaid entries are pre-ticked; an already-paid entry becomes money owed back, so it is an explicit choice (#7). */
const PRE_TICK_STATUSES = new Set(['PENDING', 'FAILED']);

/** Loading state of the PAYOUT-row entry lookup (decides LEGACY amount form vs V2 entry picker). */
type EntryLoad = 'idle' | 'loading' | 'ready' | 'error';

const ATTENTION_URL = '/api/admin/credits/reversal-engine/attention';
const REMARKS_MAX = 1000;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const inr = formatInrPaise;

// ─── Component ────────────────────────────────────────────────────────────────

export default function PayoutStatusPage() {
  const session = useAdminSession();

  const [batches,      setBatches]      = useState<BatchSummary[]>([]);
  const [batchDetails, setBatchDetails] = useState<Record<string, BatchDetail>>({});
  const [expanded,     setExpanded]     = useState<string | null>(null);
  const [filterPeriod, setFilterPeriod] = useState('');
  const [page,         setPage]         = useState(1);
  const [pagination,   setPagination]   = useState<Pagination | null>(null);
  const [loading,      setLoading]      = useState(true);
  /** The batch whose evidence upload is running. While set, nothing may unmount its panel (collapse,
   *  switching batch, paging, filtering, or the list's loading state) — that would orphan the loop. */
  const [uploadingBatchId, setUploadingBatchId] = useState<string | null>(null);
  const setBatchUploading = useCallback((id: string, uploading: boolean) => {
    setUploadingBatchId((cur) => (uploading ? id : cur === id ? null : cur));
  }, []);

  // Reversal state
  const [revTarget,  setRevTarget]  = useState<ReversalTarget | null>(null);
  const [revAmount,  setRevAmount]  = useState('');
  // Final item 8: an amount the user TYPED in the amount form (mode not known yet) — never dropped silently if the
  // entries read then says V2 (refs: read inside the async loader, after the user may have typed).
  const revAmountTypedRef = useRef<string | null>(null);
  const [revSwitchNotice, setRevSwitchNotice] = useState<string | null>(null);
  const [revRemarks, setRevRemarks] = useState('');
  const [revMsg,     setRevMsg]     = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [revLoading, setRevLoading] = useState(false);
  // WP5 entry picker: set only when the tenant's reversal engine is V2 (LEGACY and SHADOW keep the amount form).
  const [revEntries,  setRevEntries]  = useState<PayoutReversalEntry[] | null>(null);
  const [revSelected, setRevSelected] = useState<string[]>([]);
  // Load state of the payout-entries read. Re-audit B2: on a tenant KNOWN to be V2 the modal waits for it (loading →
  // picker, or an error with Retry — never a silent fallback); on LEGACY / SHADOW (or before the mode is known) the
  // amount form shows at once, exactly as in 7ba69566.
  const [revEntryLoad, setRevEntryLoad] = useState<EntryLoad>('idle');
  const revRequestRef = useRef(0);
  const revDialogRef  = useRef<HTMLDivElement>(null);
  const revTriggerRef = useRef<HTMLElement | null>(null);

  // Reversal engine mode for this tenant: the attention call-out banner is mounted only once the mode is known and
  // is not LEGACY (a LEGACY tenant — Deoleo — sees the screen exactly as before; a failed read mounts nothing).
  const [engineMode, setEngineMode] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res  = await fetch(ATTENTION_URL);
        const json = await res.json();
        if (alive && json?.success && typeof json.data?.mode === 'string') setEngineMode(json.data.mode);
      } catch {
        // Unknown mode → no banner.
      }
    })();
    return () => { alive = false; };
  }, []);

  // Period options for the filter dropdown. Derived from the UNFILTERED first page so
  // selecting a period does not collapse the dropdown to that single option. Grows as
  // pages are seen; never shrinks.
  const [allPeriods, setAllPeriods] = useState<string[]>([]);

  const fetchBatches = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (filterPeriod) params.set('period', filterPeriod);
      const res  = await fetch(`/api/admin/credits/batches?${params.toString()}`);
      const json = await res.json();
      if (json.success && json.data) {
        setBatches(json.data.batches ?? []);
        setPagination(json.data.pagination ?? null);
        // Only merge period options from an UNFILTERED response (full set for this page).
        if (!filterPeriod) {
          setAllPeriods((prev) =>
            [...new Set([...prev, ...(json.data.batches ?? []).map((b: BatchSummary) => b.period)])]
              .sort()
              .reverse(),
          );
        }
      }
    } finally {
      setLoading(false);
    }
  }, [page, filterPeriod]);

  useEffect(() => { fetchBatches(); }, [fetchBatches]);

  // Changing the period filter restarts from page 1 (a stale page index is meaningless
  // for a different result set). fetchBatches re-fires via its `page` dependency.
  useEffect(() => { setPage(1); }, [filterPeriod]);

  async function expandBatch(id: string) {
    // Keep the uploading batch open (collapsing / switching would unmount its evidence panel mid-run).
    if (uploadingBatchId) return;
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (batchDetails[id]) return;
    const res  = await fetch(`/api/admin/credits/batches/${id}`);
    const json = await res.json();
    if (json.success) {
      setBatchDetails((prev) => ({ ...prev, [id]: json.data as BatchDetail }));
    }
  }

  // Period filtering is now SERVER-SIDE (?period=YYYY-MM); the returned `batches` are
  // already the current page of the filtered+paginated set.
  const periods = allPeriods;
  // A background refresh (e.g. after a reversal request) must not swap the list for the loading
  // placeholder while an evidence upload is running — that would unmount the panel.
  const showLoading = loading && !uploadingBatchId;

  // ─── Report download ────────────────────────────────────────────────────────

  function downloadReport(batch: BatchSummary, detail?: BatchDetail) {
    if (!detail) return;
    import('xlsx').then((XLSX) => {
      const rows = detail.rows
        .filter((r) => r.status === 'OK')
        .map((r) => ({
          'Outlet ID':    r.outletId,
          'Outlet Name':  r.outletName,
          'Field':        r.fieldName,
          'Award Type':   r.awardType,
          'Amount':       r.amount,
          'Narration':    r.narration,
          'Batch Code':   batch.batchCode,
          'Period':       batch.period,
          'Status':       batch.status,
          'Confirmed At': batch.confirmedAt ?? '',
        }));
      const ws  = jsonToSheetSafe(rows);
      const wb  = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout Status');
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      downloadBlob(blob, `payout-status-${batch.period}-${batch.batchCode}.xlsx`);
    });
  }

  // ─── Reversal ───────────────────────────────────────────────────────────────

  function openReversal(batch: BatchSummary, row: BatchRow, trigger?: HTMLElement | null) {
    revTriggerRef.current = trigger ?? (document.activeElement as HTMLElement | null);
    setRevTarget({
      batchId:       batch.id,
      outletId:      row.outletId,
      outletName:    row.outletName,
      fieldId:       row.fieldId,
      fieldName:     row.fieldName,
      period:        batch.period,
      awardType:     row.awardType,
      // row.amount is paise for PAYOUT rows; whole points for POINTS rows
      originalPaise: row.amount,
    });
    // Pre-fill in human units: rupees for PAYOUT, points for POINTS
    setRevAmount(row.awardType === 'PAYOUT' ? String(row.amount / 100) : String(row.amount));
    setRevRemarks('');
    setRevMsg(null);
    setRevEntries(null);
    setRevSelected([]);
    revAmountTypedRef.current = null;
    setRevSwitchNotice(null);
    setRevEntryLoad(row.awardType === 'PAYOUT' ? 'loading' : 'idle');
    if (row.awardType === 'PAYOUT') void loadPayoutEntries(batch.id, row.outletId, row.fieldId);
    else revRequestRef.current++;
  }

  /**
   * WP5: under the V2 reversal engine a payout reversal picks whole entries; LEGACY → the amount form as before.
   * Audit B5 / re-audit B2: on a tenant known to be V2 (the attention read above) the modal shows "Loading payout
   * entries…" and Submit waits; a failed read shows an error with Retry. On LEGACY / SHADOW — or while the tenant's mode
   * is not known yet — the amount form shows at once exactly as in 7ba69566; an answered V2 still switches to the picker
   * (and a V2 server refuses an amount-only request in plain words).
   * `keepSelection` (after a failed submit, #6): keep only the previously ticked entries that are still selectable.
   */
  async function loadPayoutEntries(batchId: string, outletId: string, fieldId: string, keepSelection?: string[]) {
    const reqId = ++revRequestRef.current;
    setRevEntryLoad('loading');
    try {
      const params = new URLSearchParams({ outletId, fieldId });
      const res  = await fetch(`/api/admin/credits/batches/${batchId}/payout-reversal-entries?${params.toString()}`);
      const json = await res.json();
      if (reqId !== revRequestRef.current) return; // the modal moved on
      const data = json?.success ? json.data : null;
      if (!data) throw new Error('entries not loaded');
      if (data.mode !== 'LEGACY' && Array.isArray(data.entries)) {
        const entries = data.entries as PayoutReversalEntry[];
        setRevEntries(entries);
        const typed = !keepSelection && revAmountTypedRef.current !== null ? revAmountTypedRef.current : null;
        if (typed !== null) {
          // The user typed an amount in the amount form before the answer came: say it was cleared, pre-tick nothing.
          const rupeesTyped = Number(typed);
          setRevSwitchNotice(
            `This programme now reverses by payout entry — your typed amount ` +
              `${Number.isFinite(rupeesTyped) ? inr(Math.round(rupeesTyped * 100)) : typed} was cleared; pick entries`,
          );
          setRevAmount('');
          setRevSelected([]);
        } else {
          setRevSelected(
            keepSelection
              ? keepSelection.filter((id) => entries.some((e) => e.id === id && e.selectable))
              : entries.filter((e) => e.selectable && PRE_TICK_STATUSES.has(e.status)).map((e) => e.id),
          );
        }
      } else if (data.mode === 'LEGACY' || data.mode === 'SHADOW') {
        setRevEntries(null); // amount form (SHADOW = LEGACY for payouts)
      } else {
        throw new Error('entries not loaded');
      }
      setRevEntryLoad('ready');
    } catch {
      if (reqId !== revRequestRef.current) return;
      setRevEntryLoad('error');
    }
  }

  function retryPayoutEntries() {
    if (!revTarget) return;
    void loadPayoutEntries(revTarget.batchId, revTarget.outletId, revTarget.fieldId, revEntries ? revSelected : undefined);
  }

  function closeReversal() {
    revRequestRef.current++;
    setRevTarget(null);
    setRevAmount('');
    setRevRemarks('');
    setRevMsg(null);
    setRevEntries(null);
    setRevSelected([]);
    setRevEntryLoad('idle');
    const trigger = revTriggerRef.current;
    revTriggerRef.current = null;
    if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) trigger.focus();
  }

  // #20: focus the first control when the dialog opens.
  const revOpen = !!revTarget;
  useEffect(() => {
    if (!revOpen) return;
    const first = revDialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, [revOpen]);

  /** #20: Escape closes; Tab / Shift+Tab cycle inside the dialog. */
  function onDialogKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeReversal();
      return;
    }
    if (e.key !== 'Tab' || !revDialogRef.current) return;
    const items = Array.from(revDialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last  = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !revDialogRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !revDialogRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  const trimmedRemarks = revRemarks.trim();

  const revPickedPaise = (revEntries ?? [])
    .filter((e) => revSelected.includes(e.id))
    .reduce((s, e) => s + e.amountPaise, 0);

  async function submitPayoutEntryReversal() {
    if (!revTarget || !revEntries) return;
    if (revSelected.length === 0) {
      setRevMsg({ type: 'err', text: 'Select at least one payout entry to reverse.' });
      return;
    }
    setRevLoading(true);
    setRevMsg(null);
    const target   = revTarget;
    const selected = revSelected;
    const modalReq = revRequestRef.current;
    let failure: string | null = null;
    try {
      const res = await fetch(`/api/admin/credits/batches/${target.batchId}/reversals`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outletId:       target.outletId,
          outletName:     target.outletName,
          fieldId:        target.fieldId,
          fieldName:      target.fieldName,
          awardType:      target.awardType,
          originalPaise:  target.originalPaise,
          requestedPaise: revPickedPaise,
          payoutEntryIds: selected,
          ...(trimmedRemarks ? { remarks: trimmedRemarks } : {}),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!json?.success) {
        failure = json?.error ?? `Failed to submit reversal (HTTP ${res.status})`;
      } else {
        setRevMsg({ type: 'ok', text: `Reversal request for ${inr(revPickedPaise)} submitted — the selected entries are held out of bank files until Gifsy approves or rejects it.` });
        fetchBatches();
      }
    } catch (e) {
      failure = `Failed to submit reversal: ${String(e)}`;
    } finally {
      setRevLoading(false);
    }
    if (failure && revRequestRef.current === modalReq) { // skip if the modal was closed / moved on meanwhile
      // #6: an entry may have been taken by another request meanwhile — keep the form open, reload the entries,
      // keep only the ticks that are still selectable, and show why.
      setRevMsg({ type: 'err', text: `${failure} The payout entries were reloaded — check your selection and submit again.` });
      void loadPayoutEntries(target.batchId, target.outletId, target.fieldId, selected);
    }
  }

  async function submitReversal() {
    if (!revTarget) return;
    if (revEntries) return submitPayoutEntryReversal();
    const inputAmt = Number(revAmount);
    if (!inputAmt || inputAmt <= 0) {
      setRevMsg({ type: 'err', text: 'Please enter a valid amount.' });
      return;
    }
    // Convert user input back to paise (for PAYOUT rows); POINTS rows already whole numbers.
    const requestedPaise = revTarget.awardType === 'PAYOUT'
      ? Math.round(inputAmt * 100)
      : inputAmt;
    if (requestedPaise > revTarget.originalPaise) {
      const origDisplay = revTarget.awardType === 'PAYOUT'
        ? inr(revTarget.originalPaise)
        : `${revTarget.originalPaise.toLocaleString('en-IN')} pts`;
      setRevMsg({ type: 'err', text: `Amount cannot exceed ${origDisplay}.` });
      return;
    }
    setRevLoading(true);
    setRevMsg(null);
    try {
      const res = await fetch(`/api/admin/credits/batches/${revTarget.batchId}/reversals`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outletId:       revTarget.outletId,
          outletName:     revTarget.outletName,
          fieldId:        revTarget.fieldId,
          fieldName:      revTarget.fieldName,
          awardType:      revTarget.awardType,
          // DTO now expects paise field names
          originalPaise:  revTarget.originalPaise,
          requestedPaise,
          ...(trimmedRemarks ? { remarks: trimmedRemarks } : {}),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!json?.success) {
        setRevMsg({ type: 'err', text: json?.error ?? `Failed to submit reversal (HTTP ${res.status})` });
      } else {
        setRevMsg({ type: 'ok', text: `Reversal request submitted — awaiting Gifsy approval.` });
        fetchBatches();
      }
    } catch (e) {
      setRevMsg({ type: 'err', text: `Failed to submit reversal: ${String(e)}` });
    } finally {
      setRevLoading(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <BarChart2 className="w-5 h-5 text-[var(--brand-primary)]" />
        <div>
          <h2 className="text-lg font-bold text-gray-900">Payout Status</h2>
          <p className="text-xs text-gray-500">
            View upload batch status. PENDING = awaiting Gifsy UTR; CONFIRMED = credited/paid.
          </p>
        </div>
      </div>

      {engineMode !== null && engineMode !== 'LEGACY' && (
        <ReversalEngineAttentionBanner canLiftPause={session.role === 'GIFSY_ADMIN'} />
      )}

      {/* Filter */}
      {periods.length > 1 && (
        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-gray-600">Filter by period:</label>
          <select
            value={filterPeriod}
            onChange={(e) => setFilterPeriod(e.target.value)}
            disabled={!!uploadingBatchId}
            title={uploadingBatchId ? 'Wait for the evidence upload to finish' : undefined}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          >
            <option value="">All periods</option>
            {periods.map((p) => (
              <option key={p} value={p}>{monthLabel(p)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Loading */}
      {showLoading && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-10 text-center">
          <p className="text-sm text-gray-500 animate-pulse">Loading batches…</p>
        </div>
      )}

      {/* No batches */}
      {!showLoading && batches.length === 0 && (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-10 text-center">
          <BarChart2 className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No upload batches found.</p>
          <p className="text-xs text-gray-400 mt-1">Upload data via "Upload Credits" to see batches here.</p>
        </div>
      )}

      {/* Batch list */}
      {!showLoading && batches.length > 0 && (
        <div className="space-y-3">
          {batches.map((batch) => {
            const style      = STATUS_STYLES[batch.status] ?? STATUS_STYLES['PENDING_CONFIRM'];
            const isOpen     = expanded === batch.id;
            const isConfirmed = batch.status === 'CONFIRMED' || batch.status === 'PARTIALLY_REVERSED';
            const detail     = batchDetails[batch.id];

            return (
              <div key={batch.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div
                  className={`flex items-center gap-4 px-5 py-4 hover:bg-gray-50 ${uploadingBatchId ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  onClick={() => expandBatch(batch.id)}
                  data-testid={`batch-header-${batch.id}`}
                  aria-expanded={isOpen}
                  aria-disabled={uploadingBatchId ? true : undefined}
                  title={uploadingBatchId ? 'Wait for the evidence upload to finish' : undefined}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">{monthLabel(batch.period)}</span>
                      <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${style.bg} ${style.text}`}>
                        {style.icon}
                        {batch.status === 'PENDING_CONFIRM' ? 'Pending Approval'
                         : batch.status === 'CONFIRMED'     ? 'Confirmed'
                         :                                    'Partially Reversed'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 font-mono">{batch.batchCode}</p>
                  </div>

                  <div className="flex items-center gap-6 text-xs text-gray-600">
                    {Number(batch.totalPoints) > 0 && (
                      <span>{Number(batch.totalPoints).toLocaleString('en-IN')} pts</span>
                    )}
                    {Number(batch.totalPayoutPaise) > 0 && (
                      // totalPayoutPaise is integer paise; divide by 100 for human display
                      <span>{inr(batch.totalPayoutPaise)}</span>
                    )}
                    <span>{batch.totalOutlets} outlets</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {detail && (
                      <button
                        onClick={(e) => { e.stopPropagation(); downloadReport(batch, detail); }}
                        className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
                        title="Download report"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                    <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-gray-100">
                    <div className="px-5 py-3 bg-gray-50 flex flex-wrap gap-6 text-xs text-gray-500">
                      <span>Uploaded by: <strong className="text-gray-700">{batch.uploadedBy}</strong></span>
                      <span>At: <strong className="text-gray-700">{new Date(batch.uploadedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</strong></span>
                      {batch.confirmedAt && (
                        <span>Confirmed: <strong className="text-gray-700">{new Date(batch.confirmedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</strong></span>
                      )}
                    </div>

                    {!detail ? (
                      <p className="px-5 py-4 text-xs text-gray-400 animate-pulse">Loading rows…</p>
                    ) : (
                      <div className="overflow-x-auto max-h-72">
                        <table className="w-full text-xs">
                          <thead className="bg-gray-50 border-b border-gray-100 sticky top-0">
                            <tr>
                              {['Outlet ID', 'Outlet Name', 'Field', 'Award', 'Amount', 'Narration', ...(isConfirmed ? [''] : [])].map((h, i) => (
                                <th key={i} className="px-4 py-2 text-left font-semibold text-gray-600">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {detail.rows
                              .filter((r) => r.status === 'OK')
                              .slice(0, 20)
                              .map((r, i) => (
                                <tr key={i} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 font-mono text-gray-700">{r.outletId}</td>
                                  <td className="px-4 py-2 text-gray-700">{r.outletName}</td>
                                  <td className="px-4 py-2 text-gray-700">{r.fieldName}</td>
                                  <td className="px-4 py-2">
                                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium
                                      ${r.awardType === 'POINTS' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                      {r.awardType}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2 text-gray-700">
                                    {r.awardType === 'PAYOUT'
                                      // amount is integer paise for PAYOUT rows; divide by 100 for display
                                      ? inr(r.amount)
                                      : r.amount.toLocaleString('en-IN')}
                                  </td>
                                  <td className="px-4 py-2 text-gray-500">{r.narration || '—'}</td>
                                  {isConfirmed && (
                                    <td className="px-4 py-2">
                                      <button
                                        onClick={(e) => openReversal(batch, r, e.currentTarget)}
                                        className="flex items-center gap-1 px-2 py-1 text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-lg"
                                      >
                                        <RotateCcw className="w-3 h-3" />
                                        Reverse
                                      </button>
                                    </td>
                                  )}
                                </tr>
                              ))}
                          </tbody>
                        </table>
                        {detail.rows.filter((r) => r.status === 'OK').length > 20 && (
                          <p className="px-4 py-2 text-xs text-gray-400 text-center">
                            Showing first 20 rows. Download report for full list.
                          </p>
                        )}
                      </div>
                    )}

                    <BatchEvidencePanel
                      batchId={batch.id}
                      canDelete={!isConfirmed}
                      onUploadingChange={(u) => setBatchUploading(batch.id, u)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination controls */}
      {!showLoading && pagination && pagination.pages > 1 && (
        <div className="flex items-center justify-between gap-3 flex-wrap text-sm text-gray-500">
          <span>
            Page <strong className="text-gray-900">{pagination.page}</strong> of{' '}
            <strong className="text-gray-900">{pagination.pages}</strong> ·{' '}
            <strong className="text-gray-900">{pagination.total}</strong> total
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pagination.page <= 1 || !!uploadingBatchId}
              className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={pagination.page >= pagination.pages || !!uploadingBatchId}
              className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Reversal modal */}
      {revTarget && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div
            ref={revDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reversal-dialog-title"
            onKeyDown={onDialogKeyDown}
            className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 id="reversal-dialog-title" className="font-bold text-gray-900">Request Reversal</h3>
              <button onClick={closeReversal} aria-label="Close" className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
            </div>

            <div className="bg-gray-50 rounded-xl p-4 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-500">Outlet</span>
                <span className="font-medium text-gray-800">{revTarget.outletName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Field</span>
                <span className="font-medium text-gray-800">{revTarget.fieldName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Award Type</span>
                <span className="font-medium text-gray-800">{revTarget.awardType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Original Amount</span>
                <span className="font-medium text-gray-800">
                  {revTarget.awardType === 'PAYOUT'
                    // originalPaise is integer paise; divide by 100 for human display
                    ? inr(revTarget.originalPaise)
                    : `${revTarget.originalPaise.toLocaleString('en-IN')} pts`}
                </span>
              </div>
            </div>

            {revMsg && (
              <div
                role={revMsg.type === 'err' ? 'alert' : 'status'}
                className={`rounded-xl px-4 py-3 text-xs ${revMsg.type === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}
              >
                {revMsg.text}
              </div>
            )}

            {revMsg?.type !== 'ok' && (
              <>
                {engineMode === 'V2' && revTarget.awardType === 'PAYOUT' && revEntryLoad === 'loading' && !revEntries ? (
                  <p role="status" data-testid="payout-entries-loading" className="text-xs text-gray-500 animate-pulse">
                    Loading payout entries…
                  </p>
                ) : engineMode === 'V2' && revTarget.awardType === 'PAYOUT' && revEntryLoad === 'error' && !revEntries ? (
                  <div role="alert" data-testid="payout-entries-error" className="flex items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">
                    <span>Couldn&apos;t load payout entries — retry</span>
                    <button
                      type="button"
                      onClick={retryPayoutEntries}
                      className="px-2.5 py-1 rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50"
                    >
                      Retry
                    </button>
                  </div>
                ) : revEntries ? (
                <fieldset className="space-y-2" data-testid="payout-entry-picker">
                  {revSwitchNotice && (
                    <p role="status" data-testid="payout-mode-switch-notice" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      {revSwitchNotice}
                    </p>
                  )}
                  <legend className="text-xs font-medium text-gray-700">Payout entries to reverse</legend>
                  {revEntries.length === 0 ? (
                    <p className="text-xs text-gray-500">No payout entries exist for this outlet and field in this batch.</p>
                  ) : (
                    <ul className="max-h-56 overflow-y-auto divide-y divide-gray-100 border border-gray-200 rounded-lg">
                      {revEntries.map((e) => {
                        const checked = revSelected.includes(e.id);
                        const statusText = ENTRY_STATUS_TEXT[e.status] ?? e.status;
                        const blockText  = ENTRY_BLOCK_TEXT[e.blockedBy ?? ''] ?? 'Not available';
                        return (
                          <li key={e.id} className={`px-3 py-2 ${e.selectable ? '' : 'bg-gray-50'}`}>
                            <label className={`flex items-start gap-2 text-xs ${e.selectable ? 'cursor-pointer' : 'cursor-not-allowed text-gray-400'}`}>
                              <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={checked}
                                disabled={!e.selectable || revLoading}
                                onChange={() =>
                                  setRevSelected((cur) => (cur.includes(e.id) ? cur.filter((x) => x !== e.id) : [...cur, e.id]))
                                }
                                aria-label={
                                  e.selectable
                                    ? `Payout entry ${inr(e.amountPaise)} (${e.status})`
                                    : `Payout entry ${inr(e.amountPaise)} (${e.status}) — not selectable: ${blockText}`
                                }
                              />
                              <span className="flex-1">
                                <span className={`font-medium ${e.selectable ? 'text-gray-800' : ''}`}>{inr(e.amountPaise)}</span>
                                <span className="block text-gray-500">
                                  {e.selectable ? statusText : blockText}
                                </span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <p className="text-xs text-gray-700" aria-live="polite">
                    Reversal amount: <strong>{inr(revPickedPaise)}</strong> ({revSelected.length} of {revEntries.filter((e) => e.selectable).length} available entries)
                  </p>
                  <p className="text-xs text-gray-500">
                    Payout reversals cover whole payout entries. Selected entries are held out of bank files until Gifsy approves or rejects the request.
                  </p>
                </fieldset>
                ) : (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-gray-700">
                    Reversal Amount {revTarget.awardType === 'PAYOUT' ? '(₹)' : '(pts)'}
                  </label>
                  <input
                    type="number"
                    value={revAmount}
                    onChange={(e) => {
                      revAmountTypedRef.current = e.target.value;
                      setRevAmount(e.target.value);
                    }}
                    max={revTarget.awardType === 'PAYOUT' ? revTarget.originalPaise / 100 : revTarget.originalPaise}
                    min={1}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
                  />
                  <p className="text-xs text-gray-500">
                    {revTarget.awardType === 'PAYOUT'
                      ? 'Payout reversals cover whole payout entries only: enter the full amount of one or more entries for this outlet and field. Unpaid entries are cancelled; a paid one becomes a receivable to recover off-platform.'
                      : 'Points are removed from the outlet’s wallet (never below 0; points already redeemed are reported as a shortfall). While a wallet carries a negative balance, reversals on it are paused — contact Gifsy.'}
                  </p>
                </div>
                )}
                <div className="space-y-2">
                  <label htmlFor="reversal-remarks" className="text-xs font-medium text-gray-700">Remarks (optional)</label>
                  <textarea
                    id="reversal-remarks"
                    value={revRemarks}
                    onChange={(e) => setRevRemarks(e.target.value)}
                    maxLength={REMARKS_MAX}
                    rows={2}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 resize-none"
                  />
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={submitReversal}
                    disabled={
                      revLoading ||
                      // Final item 8: on a known-V2 tenant Submit waits for the entries read; once it has answered
                      // (picker, or LEGACY → the amount form) Submit is available.
                      (engineMode === 'V2' && revTarget.awardType === 'PAYOUT' && revEntryLoad !== 'ready') ||
                      (!!revEntries && revSelected.length === 0)
                    }
                    className="flex-1 py-2.5 bg-amber-600 text-white rounded-xl text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
                  >
                    {revLoading ? 'Submitting…' : 'Submit Reversal Request'}
                  </button>
                  <button
                    onClick={closeReversal}
                    className="px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
