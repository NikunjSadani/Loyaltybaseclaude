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
import Link from 'next/link';
import { useAdminSession } from '@/lib/admin-session';
import { jsonToSheetSafe } from '@/lib/xlsx-safe';
import { downloadBlob } from '@/lib/download';
import BatchEvidencePanel from './_components/BatchEvidencePanel';
import ReversalEngineAttentionBanner from './_components/ReversalEngineAttentionBanner';
import WalletsInDebtSection from './_components/WalletsInDebtSection';
import BatchPayoutPanel, { useCanCancelPayouts } from './_components/BatchPayoutPanel';
import CancelPayoutsFileSection from './_components/CancelPayoutsFileSection';
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

/** A deduction the server actually wrote to a wallet (GET batch detail `deductionLines`). */
interface DeductionLine {
  outletId:          string;
  fieldId:           string;
  /** Points deducted (positive). */
  points:            number;
  /** Points already given back by approved undos. */
  givenBack:         number;
  /** Set when the deduction can't be undone any more (e.g. already repaid by later points). */
  undoBlockedReason: string | null;
  /** Undoing the whole remaining amount would give back this many points already past their expiry. */
  pastExpiryPoints?: number;
}

/** "N pts would come back already past their expiry and will expire at the next sweep." (never silent) */
function pastExpiryText(points: number | undefined | null): string | null {
  const n = Number(points ?? 0);
  return n > 0 ? `${n.toLocaleString('en-IN')} pts would come back already past their expiry and will expire at the next sweep.` : null;
}

/** A row the confirm did NOT apply (GET batch detail `notApplied`, batches confirmed after the acknowledgement release). */
interface NotAppliedEntry {
  outletId:  string;
  fieldName: string;
  points:    number;
  reason:    string;
  kind?:     'DEDUCTION';
}

interface BatchDetail extends BatchSummary {
  rows: BatchRow[];
  /** Present only when the batch has actual wallet deduction rows. */
  deductionLines?: DeductionLine[];
  notApplied?:     NotAppliedEntry[];
  acknowledged?:   string[];
}

const NOT_APPLIED_REASON: Record<string, string> = {
  OUTLET_NOT_FOUND:             'Outlet ID not found in this tenant',
  OUTLET_NOT_LINKED_TO_PARTNER: 'Outlet is not linked to a partner account (onboard/KYC the outlet first)',
};
const notAppliedReason = (r: string) => NOT_APPLIED_REASON[r] ?? r;

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
  /** Original amount in integer paise (PAYOUT) or whole points (POINTS). A deduction: its POSITIVE magnitude. */
  originalPaise: number;
  /** An upload DEDUCTION row (negative points) — the request undoes it (gives the points back). */
  isDeduction?: boolean;
  /** Deductions: points already given back (shown in the modal; the undo cap is originalPaise − givenBack). */
  givenBack?: number;
  /** Deductions: points of the remaining amount already past their expiry (from the deduction line). */
  pastExpiryPoints?: number;
}

/** An OK POINTS row with a negative amount = an upload deduction row (tenant negative-deductions setting). */
function isDeductionRow(r: BatchRow): boolean {
  return r.status === 'OK' && r.awardType === 'POINTS' && r.amount < 0;
}

/** The wallet deduction the server actually wrote for this row (undo works only on these). */
function deductionLineFor(detail: BatchDetail, r: BatchRow): DeductionLine | undefined {
  return detail.deductionLines?.find((l) => l.outletId === r.outletId && l.fieldId === r.fieldId);
}

/**
 * A confirmed batch's negative row with no actual wallet deduction behind it was NOT deducted (outlet skipped /
 * switch off) — never offer an undo for it. An unconfirmed batch hasn't deducted anything yet (planned deduction).
 */
function deductionState(detail: BatchDetail, r: BatchRow, confirmed: boolean): 'DEDUCTED' | 'NOT_DEDUCTED' | 'PLANNED' {
  if (!confirmed) return 'PLANNED';
  return deductionLineFor(detail, r) ? 'DEDUCTED' : 'NOT_DEDUCTED';
}

/** WP5 — a payout entry a PAYOUT reversal picks (every tenant — a payout reversal always covers whole entries). */
interface PayoutReversalEntry {
  id:          string;
  /** Integer paise. */
  amountPaise: number;
  status:      'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'REVERSED' | 'CANCELLED' | string;
  period:      string;
  createdAt:   string;
  selectable:  boolean;
  blockedBy:   'REVERSED' | 'CANCELLED' | 'RESERVED' | 'CONSUMED' | 'ZERO' | 'PAID_194C' | null;
}

const ENTRY_BLOCK_TEXT: Record<string, string> = {
  REVERSED: 'Already reversed',
  CANCELLED: 'Cancelled by Gifsy (never paid)',
  RESERVED: 'Held by another pending reversal',
  CONSUMED: 'Already covered by an approved reversal',
  ZERO:     'No amount',
  // Owner D1 (2026-11-19): every tenant — the server refuses it too.
  PAID_194C: "Paid 194C payout — 194C payouts can't be reversed once paid",
};

/** Only unpaid entries are pre-ticked; an already-paid entry becomes money owed back, so it is an explicit choice (#7). */
const PRE_TICK_STATUSES = new Set(['PENDING', 'FAILED']);

/** Loading state of the PAYOUT-row entry lookup (the modal waits for it — loading → picker, or error + Retry). */
type EntryLoad = 'idle' | 'loading' | 'ready' | 'error';
const REMARKS_MAX = 1000;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const inr = formatInrPaise;

// ─── Component ────────────────────────────────────────────────────────────────

export default function PayoutStatusPage() {
  const session = useAdminSession();
  // Payout cancellation: GIFSY_ADMIN working inside the client only (the server re-checks).
  const canCancelPayouts = useCanCancelPayouts();
  /** Bumped after a client-wide cancellation by file — every open upload's payout panel reloads. */
  const [payoutRefresh, setPayoutRefresh] = useState(0);

  const [batches,      setBatches]      = useState<BatchSummary[]>([]);
  const [batchDetails, setBatchDetails] = useState<Record<string, BatchDetail>>({});
  const [expanded,     setExpanded]     = useState<string | null>(null);
  /** U9: batches whose expanded table shows ONLY the deduction rows — all of them, so each is reachable for Undo. */
  const [deductionsOnly, setDeductionsOnly] = useState<Set<string>>(() => new Set());
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
  // Amount form — POINTS rows only (a PAYOUT reversal always picks whole payout entries).
  const [revAmount,  setRevAmount]  = useState('');
  const [revRemarks, setRevRemarks] = useState('');
  const [revMsg,     setRevMsg]     = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [revLoading, setRevLoading] = useState(false);
  // WP5 entry picker for PAYOUT rows (every tenant).
  const [revEntries,  setRevEntries]  = useState<PayoutReversalEntry[] | null>(null);
  const [revSelected, setRevSelected] = useState<string[]>([]);
  // Load state of the payout-entries read: the modal waits for it (loading → picker, or an error with Retry — never a
  // silent fallback to an amount form).
  const [revEntryLoad, setRevEntryLoad] = useState<EntryLoad>('idle');
  const revRequestRef = useRef(0);
  const revDialogRef  = useRef<HTMLDivElement>(null);
  const revTriggerRef = useRef<HTMLElement | null>(null);

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
    // "Type" only when the batch has deduction rows (a credit-only report is unchanged).
    const withType = detail.rows.some(isDeductionRow);
    const confirmed = batch.status === 'CONFIRMED' || batch.status === 'PARTIALLY_REVERSED';
    const typeOf = (r: BatchRow) =>
      !isDeductionRow(r) ? 'Credit'
        : deductionState(detail, r, confirmed) === 'NOT_DEDUCTED' ? 'Deduction (NOT deducted)' : 'Deduction';
    import('xlsx').then((XLSX) => {
      const rows = detail.rows
        .filter((r) => r.status === 'OK')
        .map((r) => ({
          'Outlet ID':    r.outletId,
          'Outlet Name':  r.outletName,
          'Field':        r.fieldName,
          'Award Type':   r.awardType,
          ...(withType ? { 'Type': typeOf(r) } : {}),
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
      // What the confirm did NOT apply (batches confirmed after the acknowledgement release) — absent otherwise.
      if (detail.notApplied && detail.notApplied.length > 0) {
        XLSX.utils.book_append_sheet(wb, jsonToSheetSafe(detail.notApplied.map((n) => ({
          'Outlet ID': n.outletId,
          'Field':     n.fieldName,
          'Type':      n.kind === 'DEDUCTION' ? 'Deduction (NOT deducted)' : 'Credit (NOT credited)',
          'Points':    n.points,
          'Reason':    notAppliedReason(n.reason),
        }))), 'Not applied');
      }
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      downloadBlob(blob, `payout-status-${batch.period}-${batch.batchCode}.xlsx`);
    });
  }

  // ─── Reversal ───────────────────────────────────────────────────────────────

  function openReversal(batch: BatchSummary, row: BatchRow, trigger?: HTMLElement | null, line?: DeductionLine) {
    revTriggerRef.current = trigger ?? (document.activeElement as HTMLElement | null);
    if (isDeductionRow(row) && line) {
      // Undo of an ACTUAL wallet deduction: same POINTS request shape; original = points deducted, prefill = what is
      // still deducted (points − given back).
      const magnitude = Math.abs(line.points);
      const remaining = Math.max(0, magnitude - Math.max(0, line.givenBack ?? 0));
      setRevTarget({
        batchId:       batch.id,
        outletId:      row.outletId,
        outletName:    row.outletName,
        fieldId:       row.fieldId,
        fieldName:     row.fieldName,
        period:        batch.period,
        awardType:     'POINTS',
        originalPaise: magnitude,
        isDeduction:   true,
        givenBack:     magnitude - remaining,
        pastExpiryPoints: Math.max(0, Number(line.pastExpiryPoints ?? 0)),
      });
      setRevAmount(String(remaining));
      setRevRemarks('');
      setRevMsg(null);
      setRevEntries(null);
      setRevSelected([]);
      setRevEntryLoad('idle');
      revRequestRef.current++;
      return;
    }
    // A negative row with no wallet deduction behind it was NOT deducted — there is nothing to undo or reverse.
    if (isDeductionRow(row)) return;
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
    // Pre-fill the amount form (POINTS rows only — PAYOUT rows pick entries).
    setRevAmount(row.awardType === 'PAYOUT' ? '' : String(row.amount));
    setRevRemarks('');
    setRevMsg(null);
    setRevEntries(null);
    setRevSelected([]);
    setRevEntryLoad(row.awardType === 'PAYOUT' ? 'loading' : 'idle');
    if (row.awardType === 'PAYOUT') void loadPayoutEntries(batch.id, row.outletId, row.fieldId);
    else revRequestRef.current++;
  }

  /**
   * WP5: a payout reversal picks whole entries (every tenant). The modal shows "Loading payout entries…" and Submit
   * waits; a failed read (or an answer without an entries list) shows an error with Retry — never an amount form.
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
      if (!Array.isArray(data.entries)) throw new Error('entries not loaded');
      const entries = data.entries as PayoutReversalEntry[];
      setRevEntries(entries);
      setRevSelected(
        keepSelection
          ? keepSelection.filter((id) => entries.some((e) => e.id === id && e.selectable))
          : entries.filter((e) => e.selectable && PRE_TICK_STATUSES.has(e.status)).map((e) => e.id),
      );
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
    // A PAYOUT reversal always picks entries — never an amount-only request.
    if (revTarget.awardType === 'PAYOUT') return;
    const inputAmt = Number(revAmount);
    if (!inputAmt || inputAmt <= 0) {
      setRevMsg({ type: 'err', text: 'Please enter a valid amount.' });
      return;
    }
    // POINTS rows: whole points (the DTO field is named requestedPaise for both award types).
    const requestedPaise = inputAmt;
    // A deduction undo can give back at most what is still deducted.
    const cap = revTarget.originalPaise - (revTarget.givenBack ?? 0);
    if (requestedPaise > cap) {
      setRevMsg({ type: 'err', text: `Amount cannot exceed ${cap.toLocaleString('en-IN')} pts.` });
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
        const expiryNote = revTarget.isDeduction ? pastExpiryText(json?.data?.pastExpiryPoints) : null;
        setRevMsg({
          type: 'ok',
          text: revTarget.isDeduction
            ? `Undo request submitted — awaiting Gifsy approval.${expiryNote ? ` ${expiryNote}` : ''}`
            : `Reversal request submitted — awaiting Gifsy approval.`,
        });
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

      {/* Every tenant: renders nothing when there is nothing to report. */}
      <ReversalEngineAttentionBanner canLiftPause={session.role === 'GIFSY_ADMIN'} />
      {/* Audit item 9 + owner D2 (2026-11-19): every wallet below zero on ANY tenant (e.g. imported negatives) + the
          reversal(s) behind it when there are any. Renders nothing when no wallet is below zero. */}
      <WalletsInDebtSection />

      {/* Owner 2026-11-25: bulk cancel of unpaid / failed payouts by Excel — client-wide. */}
      {canCancelPayouts && <CancelPayoutsFileSection onApplied={() => setPayoutRefresh((n) => n + 1)} />}

      {session.role === 'GIFSY_ADMIN' && (
        <p className="text-xs">
          <Link href="/admin/credits-payouts/tds-old-timing" className="text-[var(--brand-primary)] hover:underline" data-testid="tds-old-timing-link">
            Check: 194C TDS raised at the bank file on payouts never paid
          </Link>
        </p>
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

                    {/* Payout status breakdown, row drill-down, cancellations (confirmed uploads only — an
                        unconfirmed upload has no payout rows yet). */}
                    {isConfirmed && (
                      <BatchPayoutPanel
                        batchId={batch.id}
                        batchCode={batch.batchCode}
                        canCancel={canCancelPayouts}
                        externalRefresh={payoutRefresh}
                      />
                    )}

                    {detail && detail.rows.some(isDeductionRow) && (() => {
                      const ok = detail.rows.filter((r) => r.status === 'OK' && r.awardType === 'POINTS');
                      const credited = ok.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
                      // Confirmed: what was ACTUALLY deducted (wallet rows); unconfirmed: what the file plans to deduct.
                      const lines = isConfirmed
                        ? (detail.deductionLines ?? []).map((l) => Math.abs(l.points))
                        : ok.filter((r) => r.amount < 0).map((r) => Math.abs(r.amount));
                      const deductedPts = lines.reduce((s, p) => s + p, 0);
                      return (
                        <p className="px-5 py-2 text-xs text-gray-600 border-b border-gray-100" data-testid="batch-credit-deduct-totals">
                          {isConfirmed ? 'Credited' : 'To credit'} {credited.toLocaleString('en-IN')} pts · {isConfirmed ? 'Deducted' : 'To deduct'}{' '}
                          {deductedPts.toLocaleString('en-IN')} pts ({lines.length} row{lines.length !== 1 ? 's' : ''})
                        </p>
                      );
                    })()}

                    {detail?.notApplied && detail.notApplied.length > 0 && (
                      <div className="px-5 py-3 border-b border-amber-100 bg-amber-50" data-testid="batch-not-applied">
                        <p className="text-xs font-semibold text-amber-800">Not applied ({detail.notApplied.length})</p>
                        <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                          {detail.notApplied.slice(0, 20).map((n, i) => (
                            <li key={i} className="text-xs text-amber-900">
                              {n.outletId} · {n.fieldName} ·{' '}
                              {n.kind === 'DEDUCTION'
                                ? `−${Math.abs(n.points).toLocaleString('en-IN')} pts · NOT deducted`
                                : `${n.points.toLocaleString('en-IN')} pts · NOT credited`}
                              {' — '}{notAppliedReason(n.reason)}
                            </li>
                          ))}
                        </ul>
                        {detail.notApplied.length > 20 && (
                          <p className="text-xs text-amber-800 mt-1">…and {detail.notApplied.length - 20} more — download the report for the full list.</p>
                        )}
                      </div>
                    )}

                    {detail && detail.rows.some(isDeductionRow) && (
                      <div className="px-5 py-2 border-b border-gray-100">
                        <label className="inline-flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={deductionsOnly.has(batch.id)}
                            onChange={() => setDeductionsOnly((cur) => {
                              const next = new Set(cur);
                              if (next.has(batch.id)) next.delete(batch.id); else next.add(batch.id);
                              return next;
                            })}
                          />
                          Deductions only (shows every deduction row)
                        </label>
                      </div>
                    )}

                    {!detail ? (
                      <p className="px-5 py-4 text-xs text-gray-400 animate-pulse">Loading rows…</p>
                    ) : (() => {
                      const onlyDed = deductionsOnly.has(batch.id) && detail.rows.some(isDeductionRow);
                      const okRows = detail.rows.filter((r) => r.status === 'OK');
                      // Deductions only: EVERY deduction row (no 20-row cut) so each one can be undone from here.
                      const shown = onlyDed ? okRows.filter(isDeductionRow) : okRows.slice(0, 20);
                      return (
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
                            {shown
                              .map((r, i) => {
                                const dState = isDeductionRow(r) ? deductionState(detail, r, isConfirmed) : null;
                                const dLine = dState === 'DEDUCTED' ? deductionLineFor(detail, r) : undefined;
                                return (
                                <tr key={i} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 font-mono text-gray-700">{r.outletId}</td>
                                  <td className="px-4 py-2 text-gray-700">{r.outletName}</td>
                                  <td className="px-4 py-2 text-gray-700">{r.fieldName}</td>
                                  <td className="px-4 py-2">
                                    {dState === 'NOT_DEDUCTED' ? (
                                      <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700" data-testid="row-not-deducted">
                                        Not deducted
                                      </span>
                                    ) : dState ? (
                                      <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">
                                        Deduction
                                      </span>
                                    ) : (
                                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium
                                      ${r.awardType === 'POINTS' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                      {r.awardType}
                                    </span>
                                    )}
                                  </td>
                                  <td className="px-4 py-2 text-gray-700">
                                    {r.awardType === 'PAYOUT'
                                      // amount is integer paise for PAYOUT rows; divide by 100 for display
                                      ? inr(r.amount)
                                      : isDeductionRow(r)
                                        ? `−${Math.abs(r.amount).toLocaleString('en-IN')}`
                                        : r.amount.toLocaleString('en-IN')}
                                  </td>
                                  <td className="px-4 py-2 text-gray-500">{r.narration || '—'}</td>
                                  {isConfirmed && (
                                    <td className="px-4 py-2">
                                      {dState === 'NOT_DEDUCTED' ? (
                                        <span className="text-xs text-gray-500">—</span>
                                      ) : dLine ? (
                                        <div className="space-y-1">
                                          <button
                                            onClick={(e) => openReversal(batch, r, e.currentTarget, dLine)}
                                            disabled={!!dLine.undoBlockedReason}
                                            aria-describedby={dLine.undoBlockedReason ? `undo-blocked-${batch.id}-${i}` : undefined}
                                            className="flex items-center gap-1 px-2 py-1 text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                                          >
                                            <RotateCcw className="w-3 h-3" />
                                            Undo deduction
                                          </button>
                                          {dLine.undoBlockedReason && (
                                            <p id={`undo-blocked-${batch.id}-${i}`} className="text-xs text-gray-600 max-w-[16rem]" data-testid="undo-blocked-reason">
                                              {dLine.undoBlockedReason}
                                            </p>
                                          )}
                                        </div>
                                      ) : (
                                      <button
                                        onClick={(e) => openReversal(batch, r, e.currentTarget)}
                                        className="flex items-center gap-1 px-2 py-1 text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-lg"
                                      >
                                        <RotateCcw className="w-3 h-3" />
                                        Reverse
                                      </button>
                                      )}
                                    </td>
                                  )}
                                </tr>
                                );
                              })}
                          </tbody>
                        </table>
                        {!onlyDed && okRows.length > 20 && (
                          <p className="px-4 py-2 text-xs text-gray-400 text-center">
                            Showing first 20 rows. Download report for full list
                            {detail.rows.some(isDeductionRow) ? ', or tick "Deductions only" to see every deduction row' : ''}.
                          </p>
                        )}
                      </div>
                      );
                    })()}

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
              <h3 id="reversal-dialog-title" className="font-bold text-gray-900">
                {revTarget.isDeduction ? 'Request undo of deduction' : 'Request Reversal'}
              </h3>
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
                <span className="text-gray-500">{revTarget.isDeduction ? 'Deducted' : 'Original Amount'}</span>
                <span className="font-medium text-gray-800">
                  {revTarget.awardType === 'PAYOUT'
                    // originalPaise is integer paise; divide by 100 for human display
                    ? inr(revTarget.originalPaise)
                    : `${revTarget.originalPaise.toLocaleString('en-IN')} pts`}
                </span>
              </div>
              {revTarget.isDeduction && pastExpiryText(revTarget.pastExpiryPoints) && (
                <p className="text-amber-700 pt-1" data-testid="undo-past-expiry">{pastExpiryText(revTarget.pastExpiryPoints)}</p>
              )}
              {revTarget.isDeduction && (revTarget.givenBack ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Already given back</span>
                  <span className="font-medium text-gray-800">{(revTarget.givenBack ?? 0).toLocaleString('en-IN')} pts</span>
                </div>
              )}
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
                {revTarget.awardType === 'PAYOUT' && revEntryLoad === 'error' && !revEntries ? (
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
                ) : revTarget.awardType === 'PAYOUT' && !revEntries ? (
                  <p role="status" data-testid="payout-entries-loading" className="text-xs text-gray-500 animate-pulse">
                    Loading payout entries…
                  </p>
                ) : revEntries ? (
                <fieldset className="space-y-2" data-testid="payout-entry-picker">
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
                    {revTarget.isDeduction ? 'Points to give back (pts)' : 'Reversal Amount (pts)'}
                  </label>
                  <input
                    type="number"
                    value={revAmount}
                    onChange={(e) => setRevAmount(e.target.value)}
                    max={revTarget.originalPaise}
                    min={1}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
                  />
                  {revTarget.isDeduction ? (
                  <p className="text-xs text-gray-500">
                    Gives the deducted points back to the wallet that was charged. If the deduction took the balance below zero, the points first clear that debt. Gifsy approves the request.
                  </p>
                  ) : (
                  <p className="text-xs text-gray-500">
                    {/* Owner decision 2026-11-19: an over-reversal becomes wallet debt, never a write-off. */}
                    Points are taken back from the wallet that received the credit. Points of that credit that already expired count as recovered — nothing is taken for them. Points it no longer holds (already redeemed) are recorded as debt on that wallet and repaid from its future earnings — nothing is written off. The outlet can’t redeem while the balance is below zero.
                  </p>
                  )}
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
                      // A PAYOUT reversal's Submit waits for the entries read (picker shown).
                      (revTarget.awardType === 'PAYOUT' && (revEntryLoad !== 'ready' || !revEntries)) ||
                      (!!revEntries && revSelected.length === 0)
                    }
                    className="flex-1 py-2.5 bg-amber-600 text-white rounded-xl text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
                  >
                    {revLoading ? 'Submitting…' : revTarget.isDeduction ? 'Submit Undo Request' : 'Submit Reversal Request'}
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
