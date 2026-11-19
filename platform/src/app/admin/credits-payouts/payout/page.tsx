'use client';

/**
 * Gifsy Payout Download, UTR Upload & Reversal Approval
 *
 * GIFSY_ADMIN only.
 *
 * Workflow:
 *  1. Select period + group type (STANDARD or SEPARATE field)
 *  2. Click "Generate Payout File" → POST /api/admin/credits/payout-downloads
 *     returns binary xlsx + creates CreditPayoutDownload record
 *  3. Gifsy fills UTR numbers in the downloaded file
 *  4. Upload filled file → preview UTR rows → confirm to apply
 *  5. Pending reversal requests shown for approval/rejection
 */

import { Fragment, useState, useRef, useCallback, useEffect } from 'react';
import {
  Download,
  Upload,
  CheckCircle,
  XCircle,
  AlertTriangle,
  FileSpreadsheet,
  Coins,
  Lock,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  BadgeCheck,
  RotateCcw,
  ThumbsUp,
  ThumbsDown,
  Info,
} from 'lucide-react';
import { formatInrPaise } from '@/lib/money-format';
import {
  ENTRY_STATUS_TEXT,
  PROCESSING_BLOCK_TEXT,
  PAID_ENTRY_OUTCOME,
  HELD_NOTICE,
  TDS_CREDIT_NOTICE,
  TDS_ADJUSTMENT_NOTICE,
} from '@/lib/payout-reversal-copy';
import { useAdminSession } from '@/lib/admin-session';
import DownloadErrorReportButton from '@/components/admin/DownloadErrorReportButton';
import { downloadBlob } from '@/lib/download';
import type { UtrParseResult, UtrUploadRow } from '@/types';
import { UploadTruncationNote } from '@/components/admin/UploadTruncationNote';
import {
  readJsonSafe,
  responseErrorMessage,
  networkErrorMessage,
  NOTHING_SAVED_NOTE,
  FILE_TOO_LARGE_MESSAGE,
} from '@/lib/safe-response';

/** Shown when the UTR APPLY response is lost (network drop / non-JSON 5xx). The apply may or may not
 *  have committed. Re-applying the same file is safe: the API serialises applies per download, only
 *  flips entries still PROCESSING (money is never paid twice), notifies only the entries it actually
 *  flipped in that call, derives the file status from the live entry statuses, and treats an
 *  all-already-applied file as a no-op. Still, the operator checks the status first, and Apply stays
 *  disabled until the file is previewed again (the fresh preview shows what a re-apply would change). */
const UTR_APPLY_UNCONFIRMED_MESSAGE =
  "We couldn't confirm whether the UTRs were applied. Refresh and check this payout file's status first — " +
  'if it shows Paid, it went through. If you still need to apply, upload the file again to re-check it; ' +
  're-applying the same file is safe (rows already applied are skipped and no one is notified twice).';

/** Preview of a file whose rows are all already applied (API `noop: true`). */
const UTR_NOOP_PREVIEW_NOTE = 'This file has already been applied — nothing will change.';

/** Shown next to the disabled Apply button after an unconfirmed apply. */
const UTR_APPLY_PAUSED_HINT =
  'Apply is paused until you upload the file again to re-check it.';

/** UTR preview (apply=false). The API returns EVERY parsed row again (`rows`, file order, capped at
 *  20,000 with rowCount/rowsTruncated) so the operator can check each OK row's outlet, UTR and payment
 *  date — and each skipped row's reason — BEFORE applying (same as e242b1a1). `problemRows` (≤ 500) feeds
 *  the error-report file. Older/other builds may send only one of the two lists; both are optional. */
/** A preview row; newer API builds add a plain `notice` on SKIP rows ("Already paid — no change."). */
type UtrPreviewRow = UtrUploadRow & { notice?: string };

/** An OK row the apply could not record (newer API builds), e.g. the payout was already recorded. */
interface UtrNotAppliedRow {
  outletId: string;
  rowNum?: number;
  reason: string;
}

type UtrPreviewResult = Omit<UtrParseResult, 'rows'> & {
  rows?: UtrPreviewRow[];
  rowCount?: number;
  rowsTruncated?: boolean;
  problemRows?: UtrPreviewRow[];
  problemRowCount?: number;
  problemRowsTruncated?: boolean;
  /** Every row is already applied — an apply would change nothing (newer API builds). */
  noop?: boolean;
};

/** Fallback reason for a skipped credits UTR row when the API sends no `notice` (older builds). */
const UTR_SKIP_REASON = 'Already paid — no change';

/** Tolerant read of the apply response's `notApplied` list (absent on older API builds). */
function readNotApplied(v: unknown): UtrNotAppliedRow[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      outletId: String(r.outletId ?? ''),
      rowNum: typeof r.rowNum === 'number' ? r.rowNum : undefined,
      reason: typeof r.reason === 'string' && r.reason.trim() ? r.reason : 'Not applied',
    }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPreviousMonth(): string {
  const now = new Date();
  const y   = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const m   = now.getMonth() === 0 ? 12 : now.getMonth();
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

const STATUS_COLOR: Record<string, string> = {
  OPEN:          'bg-blue-100 text-blue-800',
  PAID:          'bg-emerald-100 text-emerald-800',
  PARTIALLY_PAID:'bg-amber-100 text-amber-800',
  FAILED:        'bg-red-100 text-red-800',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreditField {
  id:              string;
  name:            string;
  isActive:        boolean;
  isSeparatePayout: boolean;
}

interface PayoutDownload {
  id:            string;
  downloadCode:  string;
  period:        string;
  groupType:     string;
  fieldId?:      string;
  fieldName?:    string;
  status:        string;
  downloadedAt:  string;
  /** Total payout in integer paise (BigInt serialised to number by the API). */
  totalAmountPaise: string | number;
  _count?: { entries: number };
}

interface Reversal {
  id:             string;
  outletId:       string;
  outletName:     string;
  fieldName:      string;
  period:         string;
  awardType:      string;
  /** Original award in integer paise (PAYOUT) or whole points (POINTS). */
  originalPaise:  string | number;
  /** Requested reversal in integer paise (PAYOUT) or whole points (POINTS). */
  requestedPaise: string | number;
  /** Approved reversal in integer paise (PAYOUT) or whole points (POINTS). */
  approvedPaise?: string | number;
  /**
   * The portion of approvedPaise that could NOT be clawed back because the partner
   * had already redeemed those points. Always 0 for PAYOUT reversals (no wallet).
   * In integer paise (PAYOUT) or whole points (POINTS).
   */
  shortfallPaise?: string | number;
  requestedAt:    string;
  approvedAt?:    string;
  status:         string;
  /** What the approver / rejecter typed (D5). */
  remarks?:       string | null;
  /** What the requester typed when raising the reversal (D5). */
  requestRemarks?: string | null;
  /** Approved POINTS reversals only: the server-written plain-words outcome (see PointsOutcome). */
  pointsOutcome?: PointsOutcome;
  /**
   * WP5 — present only for a PAYOUT reversal raised under the V2 reversal engine (or SHADOW before 2026-11-16): the whole entries it
   * holds (RESERVED while pending) or consumed. Absent for every LEGACY-engine reversal.
   */
  payoutEntries?: Array<{
    payoutEntryId:   string;
    /** Integer paise. */
    amountPaise:     number;
    allocationState: 'RESERVED' | 'APPLIED_CANCELLED' | 'APPLIED_RECEIVABLE' | 'RELEASED' | string;
    entryStatus:     string;
    tdsOffsetPaise?: number;
    /** Approved receivable only: the net amount owed back (amount less the TDS withheld). */
    receivablePaise?: number;
    /** Approved receivable only: the withheld TDS carried as a TDS credit on the PAN. */
    tdsCreditPaise?:  number;
    /** Owner D2: a PAID payout fully withheld as TDS, reversed — nothing reached the retailer, nothing owed. */
    fullyWithheld?:   boolean;
  }>;
}

/** GET /payout-downloads/latest-summary | /:id/summary — what the last bank file held back / adjusted (never silent). */
interface PayoutDownloadSummary {
  downloadId:   string;
  downloadCode: string;
  period:       string;
  createdAt:    string;
  reversalHeld: {
    count: number;
    paise: number;
    entries: Array<{ entryId: string; outletId: string; outletName: string; fieldName: string; amountPaise: number; status: string; creditReversalId: string }>;
  };
  tdsCreditApplied: {
    count: number;
    paise: number;
    lines: Array<{ entryId: string; outletId: string; outletName: string; duePaise: number; creditPaise: number; withheldPaise: number; otherProgrammePaise: number; panMasked: string; note: string }>;
  };
  tdsAdjustments?: {
    count: number;
    paise: number;
    lines: Array<{ entryId: string; outletId: string; outletName: string; panMasked: string; handBackPaise: number; note: string }>;
  };
}

/** The notices shown under "Generate & Download" — from the summary endpoint, or (fallback) the response headers. */
interface DownloadNotices {
  held:   { count: number; paise: number; entries: PayoutDownloadSummary['reversalHeld']['entries'] } | null;
  credit: { count: number; paise: number; lines: PayoutDownloadSummary['tdsCreditApplied']['lines'] } | null;
  adjust: { count: number; paise: number; lines: NonNullable<PayoutDownloadSummary['tdsAdjustments']>['lines'] } | null;
}

function isDownloadSummary(d: unknown): d is PayoutDownloadSummary {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const s = d as Partial<PayoutDownloadSummary>;
  return !!s.reversalHeld && typeof s.reversalHeld.count === 'number'
    && !!s.tdsCreditApplied && typeof s.tdsCreditApplied.count === 'number';
}

function noticesFromSummary(s: PayoutDownloadSummary): DownloadNotices {
  const arr = <T,>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  return {
    held: s.reversalHeld.count > 0
      ? { count: s.reversalHeld.count, paise: Number(s.reversalHeld.paise) || 0, entries: arr(s.reversalHeld.entries) }
      : null,
    credit: s.tdsCreditApplied.count > 0
      ? { count: s.tdsCreditApplied.count, paise: Number(s.tdsCreditApplied.paise) || 0, lines: arr(s.tdsCreditApplied.lines) }
      : null,
    adjust: s.tdsAdjustments && s.tdsAdjustments.count > 0
      ? { count: s.tdsAdjustments.count, paise: Number(s.tdsAdjustments.paise) || 0, lines: arr(s.tdsAdjustments.lines) }
      : null,
  };
}

/** Secondary path only — the proxy may strip these headers. */
function noticesFromHeaders(h: Headers | undefined): DownloadNotices {
  const num = (name: string) => Number(h?.get?.(name) ?? 0) || 0;
  const heldCount = num('X-Reversal-Held-Count');
  const creditCount = num('X-Tds-Credit-Applied-Count');
  const adjustCount = num('X-Tds-Adjustment-Count');
  return {
    held:   heldCount > 0 ? { count: heldCount, paise: num('X-Reversal-Held-Paise'), entries: [] } : null,
    credit: creditCount > 0 ? { count: creditCount, paise: num('X-Tds-Credit-Applied-Paise'), lines: [] } : null,
    adjust: adjustCount > 0 ? { count: adjustCount, paise: num('X-Tds-Adjustment-Paise'), lines: [] } : null,
  };
}

/**
 * The approve/reject result of a PAYOUT reversal (PATCH response `payoutOutcome`). Since policy round B
 * (owner 2026-11-16) every tenant gets it — LEGACY included — with a server-written `headline` + `lines`
 * ("Entry cancelled · ₹5,000 · will not be paid", "Recorded as owed · ₹9,800 · ₹200 TDS credit carried forward…").
 */
interface PayoutOutcome {
  headline?:       string;
  lines?:          Array<{ kind: string; entryId: string | null; text: string }>;
  cancelled:       Array<{ entryId: string; amountPaise: number; wasStatus: string; tdsOffsetPaise: number; tdsNote: string }>;
  receivable:      Array<{ entryId: string; amountPaise: number; receivablePaise?: number; tdsCreditPaise?: number; tdsNote: string }>;
  receivablePaise: number;
  tdsCreditPaise?: number;
  released:        Array<{ entryId: string; amountPaise: number }>;
}

/**
 * The plain-words outcome of a POINTS reversal (PATCH response + reversal list `pointsOutcome`, every tenant), written by
 * the server — shown verbatim. V2 (owner 2026-11-19): what the wallet no longer holds is "recorded as debt, repaid from
 * future earnings"; LEGACY: it is "not recovered — already spent, written off (settle off-platform)".
 */
interface PointsOutcome {
  headline: string;
  summary:  string;
  lines:    string[];
  reversed: number;
  recovered: number;
  debtRestored: number;
  owed: number;
  shortfall: number;
}

const rupees = formatInrPaise;

function describePayoutOutcome(o: PayoutOutcome, rev?: { outletName: string; fieldName: string }): { title: string; lines: string[] } {
  const who = rev ? ` — ${rev.outletName} / ${rev.fieldName}` : '';
  // Server-written summary (every tenant since policy round B) — shown verbatim, one line per entry.
  if (o.headline && Array.isArray(o.lines)) {
    return {
      title: `${o.headline}${who}`,
      lines: [
        ...o.lines.map((l) => l.text),
        ...(o.receivablePaise > 0
          ? [`Total recorded as owed ${rupees(o.receivablePaise)} — shown as "Pending" in Processed Reversals below.`]
          : []),
      ],
    };
  }
  if (o.released.length > 0 && o.cancelled.length === 0 && o.receivable.length === 0) {
    return {
      title: `Reversal rejected${who}`,
      lines: o.released.map((r) => `${rupees(r.amountPaise)} entry released — it goes into the next bank file again.`),
    };
  }
  return {
    title: `Reversal approved${who}`,
    lines: [
      ...o.cancelled.map((c) => `${rupees(c.amountPaise)} entry (${c.wasStatus === 'FAILED' ? 'bank payment had failed' : 'not yet sent to the bank'}) cancelled — ${c.tdsNote}.`),
      ...o.receivable.map((r) => `${rupees(r.amountPaise)} entry was already PAID — recorded as a receivable to recover off-platform; ${r.tdsNote}.`),
      ...(o.receivablePaise > 0
        ? [`Total receivable ${rupees(o.receivablePaise)} — shown as "Pending" in Processed Reversals below.`]
        : []),
    ],
  };
}

type ReversalEntry = NonNullable<Reversal['payoutEntries']>[number];

/** What an approved / rejected reversal did to one of its entries (Processed Reversals — L1/L3/L5). */
function processedEntryText(pe: ReversalEntry): string {
  const amount = rupees(pe.amountPaise);
  switch (pe.allocationState) {
    case 'APPLIED_RECEIVABLE': {
      const net = pe.receivablePaise ?? pe.amountPaise;
      const withheld = pe.receivablePaise != null ? Math.max(0, pe.amountPaise - pe.receivablePaise) : 0;
      return `${amount} entry (was paid) — ${PAID_ENTRY_OUTCOME(net, withheld, pe.tdsCreditPaise ?? 0)}`;
    }
    case 'APPLIED_CANCELLED':
      // B4 / owner D2: a fully withheld PAID payout is not "cancelled" — it was settled as TDS; reversed, nothing owed.
      if (pe.fullyWithheld) {
        return (
          `${amount} entry (was paid — fully withheld as TDS) — reversed · nothing reached the retailer, nothing owed` +
          ((pe.tdsCreditPaise ?? 0) > 0 ? ` · ${rupees(pe.tdsCreditPaise ?? 0)} TDS credit carried forward` : '') +
          ((pe.tdsOffsetPaise ?? 0) > 0 ? ` · ${rupees(pe.tdsOffsetPaise ?? 0)} withheld TDS reversed in the TDS ledger` : '')
        );
      }
      return `${amount} entry — cancelled · will not be paid${(pe.tdsOffsetPaise ?? 0) > 0 ? ` · ${rupees(pe.tdsOffsetPaise ?? 0)} withheld TDS offset` : ''}`;
    case 'RELEASED':
      return `${amount} entry — released · goes into the next bank file`;
    default:
      return `${amount} entry — ${pe.allocationState}`;
  }
}

interface Pagination {
  page:  number;
  limit: number;
  total: number;
  pages: number;
}

const REV_PAGE_SIZE = 50;

/** #18: info icon with an explanatory hover title + screen-reader text. */
function InfoHint({ text }: { text: string }) {
  return (
    <span role="img" aria-label={text} title={text} className="flex-shrink-0 mt-0.5">
      <Info className="w-3.5 h-3.5" aria-hidden />
    </span>
  );
}

/** #8: approval of a payout reversal waits while any held entry is with the bank (PROCESSING). */
function hasProcessingEntry(rev: Reversal): boolean {
  return (rev.payoutEntries ?? []).some((pe) => pe.entryStatus === 'PROCESSING');
}

// ─── Gate wrapper ─────────────────────────────────────────────────────────────

/** B-L2: decode a URI-encoded notice header without ever throwing (malformed → shown raw). */
function safeDecode(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export default function PayoutDownloadPage() {
  const session = useAdminSession();

  if (session.role !== 'GIFSY_ADMIN') {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-gray-500">
        <Lock className="w-8 h-8 text-gray-300" />
        <p className="text-sm font-medium">Gifsy Admin Access Only</p>
        <p className="text-xs text-gray-400">This page is restricted to Gifsy administrators.</p>
      </div>
    );
  }

  return <PayoutPageInner />;
}

// ─── Inner component ──────────────────────────────────────────────────────────

function PayoutPageInner() {
  const session = useAdminSession();

  const [period,    setPeriod]    = useState(getPreviousMonth());
  const [groupType, setGroupType] = useState<'STANDARD' | 'SEPARATE'>('STANDARD');
  const [fields,    setFields]    = useState<CreditField[]>([]);
  const [fieldId,   setFieldId]   = useState('');
  const [downloads, setDownloads] = useState<PayoutDownload[]>([]);
  const [reversals, setReversals] = useState<Reversal[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genError,   setGenError]   = useState('');
  // A-H2: payouts fully withheld as TDS are NOT in the bank file — the API names them in headers.
  const [fullyWithheldNote, setFullyWithheldNote] = useState('');
  // Owner rule "no silent pass-through": KYC-held payouts left out of the file.
  const [heldNote, setHeldNote] = useState('');
  // A-L3: every payout fully withheld as TDS → the API created no bank file.
  const [noBankFileMsg, setNoBankFileMsg] = useState('');
  // What the last bank file held back (pending reversals) or adjusted (TDS credit / TDS hand-back) — never silent.
  // Read from the summary endpoint after each download; the response headers are only a fallback.
  const [genNotices, setGenNotices] = useState<DownloadNotices | null>(null);
  // #18: the notices belong to one period / group / field — a change clears them, and a late summary for an old
  // scope is dropped.
  const scopeKey = `${period}|${groupType}|${fieldId}`;
  const scopeKeyRef = useRef(scopeKey);
  useEffect(() => {
    scopeKeyRef.current = scopeKey;
    setGenNotices(null);
  }, [scopeKey]);
  // WP5: what approving / rejecting an engine payout reversal did (cancelled / receivable / TDS / released).
  const [revOutcome, setRevOutcome] = useState<{ title: string; lines: string[] } | null>(null);
  const revOutcomeRef = useRef<HTMLDivElement>(null);
  // #20: move focus to the outcome summary once it appears.
  useEffect(() => {
    if (revOutcome) revOutcomeRef.current?.focus();
  }, [revOutcome]);

  // UTR upload state
  const [utrDownloadId,  setUtrDownloadId]  = useState('');
  const [utrFile,        setUtrFile]        = useState<File | null>(null);
  const [utrParsing,     setUtrParsing]     = useState(false);
  const [utrResult,      setUtrResult]      = useState<UtrPreviewResult | null>(null);
  const [utrApplying,    setUtrApplying]    = useState(false);
  const [utrApplied,     setUtrApplied]     = useState(false);
  const [utrApplyResult, setUtrApplyResult] = useState<{
    paidCount: number;
    failedCount: number;
    skippedCount: number;
    /** The API changed nothing (every row already applied) — show its `message`, not a "paid" banner. */
    noop?: boolean;
    message?: string;
    /** OK rows the apply could not record — always shown in amber, never behind a green banner. */
    notApplied: UtrNotAppliedRow[];
    /** Policy round B: TDS credit given back because the payout it covered failed (sent only when any). */
    tdsCreditReleased: Array<{ entryId: string; amountPaise: number; note: string }>;
  } | null>(null);
  const [utrMsg,         setUtrMsg]         = useState('');
  const [expandedUtr,    setExpandedUtr]    = useState(false);
  /** True after an apply whose outcome we couldn't confirm — Apply stays disabled until a fresh preview. */
  const [utrApplyUnconfirmed, setUtrApplyUnconfirmed] = useState(false);

  // Reversal state
  const [revAction,          setRevAction]          = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);
  const [revAmount,          setRevAmount]          = useState('');
  const [revRemarks,         setRevRemarks]         = useState('');
  const [revMsg,             setRevMsg]             = useState('');
  const [revLoading,         setRevLoading]         = useState(false);
  const [processedReversals, setProcessedReversals] = useState<Reversal[]>([]);

  // Pagination for the two REVERSALS lists (pending + processed). The downloads/fields
  // fetches are left un-paginated per scope.
  const [pendingPage,   setPendingPage]   = useState(1);
  const [pendingPg,     setPendingPg]     = useState<Pagination | null>(null);
  const [processedPage, setProcessedPage] = useState(1);
  const [processedPg,   setProcessedPg]   = useState<Pagination | null>(null);

  const utrFileRef = useRef<HTMLInputElement>(null);

  // ─── Load data ───────────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    const pendingParams = new URLSearchParams({
      status: 'PENDING_GIFSY',
      page:   String(pendingPage),
      limit:  String(REV_PAGE_SIZE),
    });
    const processedParams = new URLSearchParams({
      status: 'APPROVED',
      page:   String(processedPage),
      limit:  String(REV_PAGE_SIZE),
    });
    const [fieldsRes, downloadsRes, reversalsRes, processedRes] = await Promise.all([
      fetch('/api/admin/credits/fields?active=true').then((r) => r.json()),
      fetch(`/api/admin/credits/payout-downloads?period=${period}`).then((r) => r.json()),
      fetch(`/api/admin/credits/reversals?${pendingParams.toString()}`).then((r) => r.json()),
      fetch(`/api/admin/credits/reversals?${processedParams.toString()}`).then((r) => r.json()),
    ]);
    if (fieldsRes.success)    setFields(fieldsRes.data);
    if (downloadsRes.success) setDownloads(downloadsRes.data);
    // Reversals now come back as { reversals, pagination }.
    if (reversalsRes.success && reversalsRes.data) {
      setReversals(reversalsRes.data.reversals ?? []);
      setPendingPg(reversalsRes.data.pagination ?? null);
    }
    if (processedRes.success && processedRes.data) {
      setProcessedReversals(processedRes.data.reversals ?? []);
      setProcessedPg(processedRes.data.pagination ?? null);
    }
  }, [period, pendingPage, processedPage]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const separateFields = fields.filter((f) => f.isSeparatePayout);

  // ─── Generate payout file ─────────────────────────────────────────────────

  /** The summary of the download just made: by id when the header is readable, else the caller's latest for the scope. */
  async function fetchDownloadSummary(downloadId: string | null, body: Record<string, unknown>): Promise<PayoutDownloadSummary | null> {
    const read = async (url: string): Promise<PayoutDownloadSummary | null> => {
      try {
        const res  = await fetch(url);
        const json = await res.json();
        return json?.success && isDownloadSummary(json.data) ? json.data : null;
      } catch {
        return null;
      }
    };
    if (downloadId) {
      const byId = await read(`/api/admin/credits/payout-downloads/${encodeURIComponent(downloadId)}/summary`);
      if (byId) return byId;
    }
    const q = new URLSearchParams({ period: String(body.period), groupType: String(body.groupType) });
    if (body.fieldId) q.set('fieldId', String(body.fieldId));
    return read(`/api/admin/credits/payout-downloads/latest-summary?${q.toString()}`);
  }

  async function handleGeneratePayoutFile() {
    setGenerating(true);
    setGenError('');
    setFullyWithheldNote('');
    setHeldNote('');
    setNoBankFileMsg('');
    setGenNotices(null);
    const key = scopeKey;
    try {
      const body: Record<string, unknown> = { period, groupType };
      if (groupType === 'SEPARATE' && fieldId) {
        const field = fields.find((f) => f.id === fieldId);
        body.fieldId   = fieldId;
        body.fieldName = field?.name;
      }

      const res = await fetch('/api/admin/credits/payout-downloads', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: 'Request failed' }));
        setGenError(json.error ?? `HTTP ${res.status}`);
        return;
      }

      // A-L3: when EVERY payout was fully withheld as TDS the API answers JSON (no file) with the reason.
      const isJson = (res.headers?.get?.('Content-Type') ?? '').includes('application/json');
      const headerNotices = noticesFromHeaders(res.headers);
      let downloadId = res.headers?.get?.('X-Download-Id') ?? null;
      if (isJson) {
        const json = await res.json().catch(() => null);
        setNoBankFileMsg(json?.data?.message ?? json?.message ?? 'No bank file was created for this run.');
        downloadId = downloadId ?? json?.data?.downloadId ?? json?.downloadId ?? null;
      } else {
        // B-L2: save the file FIRST — reading the notice headers can never block or break the download.
        const blob = await res.blob();
        downloadBlob(blob, `payout-${period}-${groupType.toLowerCase()}.xlsx`);
      }

      // A-H2 / held: never silent — which payouts are NOT in this file, and why.
      const withheldCount = Number(res.headers?.get?.('X-Fully-Withheld-Count') ?? '0');
      if (withheldCount > 0) {
        setFullyWithheldNote(
          safeDecode(res.headers?.get?.('X-Fully-Withheld-Note')) ??
            `${withheldCount} payout(s) fully withheld as TDS — not sent to the bank.`,
        );
      }
      const heldCount = Number(res.headers?.get?.('X-Held-Count') ?? '0');
      if (heldCount > 0) {
        setHeldNote(safeDecode(res.headers?.get?.('X-Held-Note')) ?? `${heldCount} payout(s) held — KYC not approved.`);
      }

      loadAll();

      // WRE #1: what this file held back / adjusted — from the summary endpoint (headers may be stripped by the proxy).
      const summary = await fetchDownloadSummary(downloadId, body);
      if (scopeKeyRef.current !== key) return; // the operator moved to another period / group / field
      setGenNotices(summary ? noticesFromSummary(summary) : headerNotices);
    } catch {
      // B-L1: the request was cut (network / proxy timeout) — the file may or may not exist server-side.
      setGenError(
        'The connection was interrupted — the payout file may or may not have been created. Check the Download History below before trying again (generating twice would claim the same payouts only once, but check first).',
      );
      loadAll();
    } finally {
      setGenerating(false);
    }
  }

  // ─── UTR Upload ───────────────────────────────────────────────────────────

  async function handleUtrFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !utrDownloadId) return;
    setUtrFile(file);
    setUtrParsing(true);
    setUtrResult(null);
    setUtrApplied(false);
    setUtrMsg('');
    // A fresh preview is the re-check that re-enables Apply after an unconfirmed apply.
    setUtrApplyUnconfirmed(false);

    const fd = new FormData();
    fd.append('file', file);

    // Preview only (no apply) — nothing is written server-side, so a lost response is safe to retry.
    let res: Response;
    try {
      res = await fetch(
        `/api/admin/credits/payout-downloads/${utrDownloadId}/utr`,
        { method: 'POST', body: fd },
      );
    } catch {
      setUtrParsing(false);
      setUtrMsg(networkErrorMessage(NOTHING_SAVED_NOTE));
      return;
    }
    const json = await readJsonSafe(res);
    setUtrParsing(false);

    if (!json) {
      setUtrMsg(responseErrorMessage(res, json, NOTHING_SAVED_NOTE));
    } else if (!json.success) {
      setUtrMsg(json.error ?? 'Failed to parse UTR file');
    } else {
      setUtrResult(json.data.parseResult);
    }
  }

  /** The apply's outcome is unknown: pause Apply until the file is previewed again, clear the file
   *  input so re-picking the SAME file fires onChange, and refresh the status list for the operator. */
  function markApplyUnconfirmed() {
    setUtrApplyUnconfirmed(true);
    setUtrMsg(UTR_APPLY_UNCONFIRMED_MESSAGE);
    if (utrFileRef.current) utrFileRef.current.value = '';
    loadAll().catch(() => { /* status refresh is best-effort */ });
  }

  async function handleApplyUtr() {
    if (!utrResult?.canProceed || !utrDownloadId || !utrFile || utrApplyUnconfirmed) return;
    setUtrApplying(true);
    setUtrMsg('');

    const fd = new FormData();
    fd.append('file', utrFile);
    fd.append('apply', 'true');

    // apply=true MUST go in the query string — the backend reads it via @Query
    // (credits.controller uploadUtr). Sending it only in the multipart body made
    // every "Apply" silently run as a PREVIEW (nothing committed, batch stayed OPEN).
    let res: Response;
    try {
      res = await fetch(
        `/api/admin/credits/payout-downloads/${utrDownloadId}/utr?apply=true`,
        { method: 'POST', body: fd },
      );
    } catch {
      setUtrApplying(false);
      markApplyUnconfirmed();
      return;
    }
    const json = await readJsonSafe(res);
    setUtrApplying(false);

    if (!json) {
      // No readable answer: the apply may or may not have committed. Never claim either way.
      // (A 413 never reached the API, so nothing was applied — Apply stays available.)
      if (res.status === 413) setUtrMsg(FILE_TOO_LARGE_MESSAGE);
      else markApplyUnconfirmed();
    } else if (!json.success) {
      setUtrMsg(json.error ?? 'Failed to apply UTR results');
    } else {
      setUtrApplied(true);
      const noop = json.data?.noop === true;
      const serverMsg = typeof json.data?.message === 'string' && json.data.message.trim() ? json.data.message : undefined;
      setUtrApplyResult({
        paidCount:    Number(json.data.paidCount)    || 0,
        failedCount:  Number(json.data.failedCount)  || 0,
        skippedCount: Number(json.data.skippedCount) || 0,
        noop,
        message: serverMsg,
        notApplied: readNotApplied(json.data?.notApplied),
        tdsCreditReleased: Array.isArray(json.data?.tdsCreditReleased) ? json.data.tdsCreditReleased : [],
      });
      setUtrMsg(
        noop
          ? (serverMsg ?? 'Already applied — nothing to change')
          : `Applied: ${json.data.paidCount} paid, ${json.data.failedCount} failed, ${json.data.skippedCount} skipped.`,
      );
      loadAll();
    }
  }

  function resetUtrForm() {
    setUtrDownloadId('');
    setUtrFile(null);
    setUtrResult(null);
    setUtrApplied(false);
    setUtrApplyResult(null);
    setUtrMsg('');
    setExpandedUtr(false);
    setUtrApplyUnconfirmed(false);
    if (utrFileRef.current) utrFileRef.current.value = '';
  }

  // ─── Reversals ────────────────────────────────────────────────────────────

  async function handleReversalAction() {
    if (!revAction) return;
    const actionRev = reversals.find((r) => r.id === revAction.id);
    if (revAction.action === 'approve' && actionRev && hasProcessingEntry(actionRev)) {
      setRevMsg(PROCESSING_BLOCK_TEXT);
      return;
    }
    setRevLoading(true);
    setRevMsg('');
    setRevOutcome(null); // #16: never leave the previous decision's summary on screen

    const body: Record<string, unknown> = { action: revAction.action };
    // PAYOUT reversals are approved in full (whole payout entries) — no amount is sent.
    if (revAction.action === 'approve' && revAmount && actionRev?.awardType !== 'PAYOUT') {
      body.approvedPaise = Number(revAmount);
    }
    // D5: the approver's / rejecter's typed note is sent for every tenant (owner-approved platform-wide).
    const remarks = revRemarks.trim();
    if (remarks) body.remarks = remarks;

    try {
      const res  = await fetch(`/api/admin/credits/reversals/${revAction.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);

      if (!json?.success) {
        setRevMsg(json?.error ?? `Failed to process reversal (HTTP ${res.status})`);
      } else {
        const o = json.data?.payoutOutcome as PayoutOutcome | undefined;
        const po = json.data?.pointsOutcome as PointsOutcome | undefined;
        setRevOutcome(
          o
            ? describePayoutOutcome(o, actionRev)
            : po && typeof po.headline === 'string'
              ? {
                  title: `${po.headline}${actionRev ? ` — ${actionRev.outletName} / ${actionRev.fieldName}` : ''}`,
                  lines: Array.isArray(po.lines) && po.lines.length > 1 ? po.lines : [],
                }
              : null,
        );
        setRevAction(null);
        setRevAmount('');
        setRevRemarks('');
        loadAll();
      }
    } catch (e) {
      setRevMsg(`Couldn't reach the server — refresh to check whether the reversal was processed before trying again. (${String(e)})`);
    } finally {
      setRevLoading(false);
    }
  }

  // UTR preview lists (H3): every row when the API sends them, else the problem rows only.
  const utrRows: UtrPreviewRow[] = utrResult ? (utrResult.rows ?? utrResult.problemRows ?? []) : [];
  const utrRowTotal = utrResult
    ? (utrResult.rows ? (utrResult.rowCount ?? utrResult.rows.length) : (utrResult.problemRowCount ?? utrRows.length))
    : 0;
  const utrRowsCut = !!utrResult && (utrResult.rows ? !!utrResult.rowsTruncated : !!utrResult.problemRowsTruncated);
  const utrProblemRows: UtrUploadRow[] = utrResult
    ? (utrResult.problemRows ?? (utrResult.rows ?? []).filter((r) => r.status === 'ERROR'))
    : [];
  const utrProblemsCut = !!utrResult?.problemRowsTruncated;

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Coins className="w-5 h-5 text-[var(--brand-primary)]" />
        <div>
          <h2 className="text-lg font-bold text-gray-900">Payout Download</h2>
          <p className="text-xs text-gray-500">Generate payout files, upload UTR results, approve reversals.</p>
        </div>
      </div>

      {/* ── Section 1: Generate Payout File ─────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
          <Download className="w-4 h-4 text-gray-400" />
          Generate Payout File
        </h3>

        <div className="flex flex-wrap gap-4 items-end">
          {/* Period */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Period</label>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
            />
          </div>

          {/* Group type */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Group Type</label>
            <div className="flex gap-2">
              {(['STANDARD', 'SEPARATE'] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => { setGroupType(g); setFieldId(''); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                    ${groupType === g
                      ? 'bg-[var(--brand-primary)] text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          {/* Separate field picker */}
          {groupType === 'SEPARATE' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">Field</label>
              <select
                value={fieldId}
                onChange={(e) => setFieldId(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
              >
                <option value="">Select field…</option>
                {separateFields.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={handleGeneratePayoutFile}
            disabled={generating || (groupType === 'SEPARATE' && !fieldId)}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            {generating ? 'Generating…' : 'Generate & Download'}
          </button>
        </div>

        {noBankFileMsg && (
          <div
            data-testid="no-bank-file-notice"
            role="status"
            className="flex items-center gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3"
          >
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{noBankFileMsg}</span>
          </div>
        )}

        {heldNote && (
          <div
            data-testid="held-notice"
            role="status"
            className="flex items-center gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3"
          >
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{heldNote}</span>
          </div>
        )}

        {fullyWithheldNote && (
          <div
            data-testid="fully-withheld-notice"
            role="status"
            className="flex items-center gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3"
          >
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
              {fullyWithheldNote} Their whole amount was withheld as TDS, so they are already settled and will
              not appear in the bank&apos;s response file.
            </span>
          </div>
        )}

        {genNotices?.held && (
          <div role="status" data-testid="reversal-held-notice" className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p>{HELD_NOTICE(genNotices.held.count, genNotices.held.paise)}</p>
              {genNotices.held.entries.length > 0 && (
                <ul className="max-h-40 overflow-auto list-disc pl-4 space-y-0.5">
                  {genNotices.held.entries.map((e) => (
                    <li key={e.entryId}>
                      {e.outletName} ({e.outletId}) · {e.fieldName} · {rupees(e.amountPaise)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {genNotices?.credit && (
          <div role="status" data-testid="tds-credit-applied-notice" className="flex items-start gap-2 text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
            <InfoHint text="TDS credit: TDS already deposited for a reversed payout on the same PAN is used before withholding new TDS" />
            <div className="min-w-0 space-y-1">
              <p>{TDS_CREDIT_NOTICE(genNotices.credit.count, genNotices.credit.paise)}</p>
              {genNotices.credit.lines.length > 0 && (
                <ul className="max-h-40 overflow-auto list-disc pl-4 space-y-0.5">
                  {genNotices.credit.lines.map((l) => (
                    <li key={l.entryId}>
                      {l.outletName} · PAN {l.panMasked} · {rupees(l.creditPaise)} credit used
                      {l.otherProgrammePaise > 0 && (
                        <span className="ml-1 inline-block rounded bg-blue-100 px-1.5 text-[10px] font-medium">
                          another programme · {rupees(l.otherProgrammePaise)}
                        </span>
                      )}
                      {l.note && <span className="block text-blue-700">{l.note}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {genNotices?.adjust && (
          <div role="status" data-testid="tds-adjustment-notice" className="flex items-start gap-2 text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
            <InfoHint text="TDS adjustment: a reversal brought the PAN below the TDS limit, so TDS already deducted is handed back" />
            <div className="min-w-0 space-y-1">
              <p>{TDS_ADJUSTMENT_NOTICE(genNotices.adjust.count, genNotices.adjust.paise)}</p>
              {genNotices.adjust.lines.length > 0 && (
                <ul className="max-h-40 overflow-auto list-disc pl-4 space-y-0.5">
                  {genNotices.adjust.lines.map((l) => (
                    <li key={l.entryId}>
                      {l.outletName} · PAN {l.panMasked} · {rupees(l.handBackPaise)} handed back
                      {l.note && <span className="block text-blue-700">{l.note}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {genError && (
          <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 rounded-xl px-4 py-3">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {genError}
          </div>
        )}

        {/* Download history */}
        {downloads.length > 0 && (
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-100">
              <p className="text-xs font-semibold text-gray-600">Download History — {monthLabel(period)}</p>
            </div>
            <div className="divide-y divide-gray-50">
              {downloads.map((d) => (
                <div key={d.id} className="flex items-center justify-between px-4 py-3 text-xs">
                  <div>
                    <p className="font-mono font-medium text-gray-800">{d.downloadCode}</p>
                    <p className="text-gray-500">{d.groupType}{d.fieldName ? ` · ${d.fieldName}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* totalAmountPaise is integer paise; divide by 100 for human display */}
                    <span className="text-gray-600">{rupees(d.totalAmountPaise)}</span>
                    <span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[d.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {d.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Section 2: UTR Upload ────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
          <Upload className="w-4 h-4 text-gray-400" />
          Upload UTR Results
        </h3>

        {/* Select download */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">Select Payout Download</label>
          <select
            value={utrDownloadId}
            onChange={(e) => { setUtrDownloadId(e.target.value); resetUtrForm(); setUtrDownloadId(e.target.value); }}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 w-full max-w-sm"
          >
            <option value="">Select a download batch…</option>
            {downloads
              .filter((d) => d.status !== 'PAID')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.downloadCode} · {d.groupType}{d.fieldName ? ` / ${d.fieldName}` : ''} · {d.status}
                </option>
              ))}
          </select>
        </div>

        {utrDownloadId && (
          <>
            <div
              className="border-2 border-dashed border-gray-300 hover:border-gray-400 rounded-xl p-6 text-center cursor-pointer transition-colors"
              onClick={() => utrFileRef.current?.click()}
            >
              <FileSpreadsheet className="w-7 h-7 text-gray-400 mx-auto mb-2" />
              <p className="text-sm text-gray-600">
                {utrFile ? utrFile.name : 'Click to upload UTR result file (.xlsx)'}
              </p>
              <input
                ref={utrFileRef}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={handleUtrFileChange}
              />
            </div>

            {utrParsing && (
              <p className="text-xs text-gray-500 animate-pulse">Parsing file…</p>
            )}

            {utrMsg && !utrResult && (
              <div className={`text-xs px-4 py-3 rounded-xl ${utrApplied ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {utrMsg}
              </div>
            )}

            {utrResult && !utrApplied && (
              <div className="space-y-3">
                {utrResult.headerError && (
                  <div className="bg-red-50 text-red-700 text-xs px-4 py-3 rounded-xl">
                    {utrResult.headerError}
                  </div>
                )}

                {/* Summary */}
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'OK',      value: utrResult.summary.ok,          color: 'text-emerald-600' },
                    { label: 'Errors',  value: utrResult.summary.errors,       color: 'text-red-600' },
                    { label: 'Skipped', value: utrResult.summary.skipped,      color: 'text-gray-500' },
                    { label: 'Paid',    value: utrResult.summary.paidCount,    color: 'text-blue-600' },
                  ].map((c) => (
                    <div key={c.label} className="bg-gray-50 rounded-xl p-3 text-center">
                      <p className={`text-lg font-bold ${c.color}`}>{c.value}</p>
                      <p className="text-xs text-gray-500">{c.label}</p>
                    </div>
                  ))}
                </div>

                {utrResult.noop && (
                  <div
                    role="status"
                    data-testid="utr-noop-preview"
                    className="bg-gray-50 border border-gray-200 text-gray-700 text-xs px-4 py-3 rounded-xl"
                  >
                    {UTR_NOOP_PREVIEW_NOTE}
                  </div>
                )}

                {/* Errors block the apply — prominent warning so a green summary
                    grid can't be mistaken for "all good". No entry is changed
                    until every row is valid (the entry stays PROCESSING). */}
                {utrResult.summary.errors > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-800">Upload has errors — nothing applied</p>
                      <p className="text-xs text-amber-700 mt-0.5">
                        {utrResult.summary.errors} row{utrResult.summary.errors === 1 ? '' : 's'} could not be read
                        {utrResult.summary.ok > 0 ? ` (${utrResult.summary.ok} row${utrResult.summary.ok === 1 ? '' : 's'} OK)` : ''}.
                        Fix the highlighted rows and re-upload — no payout entry is changed until every row is valid.
                      </p>
                    </div>
                  </div>
                )}

                {/* Row details — EVERY row (OK: outlet, UTR, payment date; Skipped: why; Error: what to fix),
                    so the operator checks the file BEFORE "Apply UTR Results". */}
                {utrRows.length > 0 && (
                  <button
                    onClick={() => setExpandedUtr((v) => !v)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800"
                    aria-expanded={expandedUtr}
                  >
                    {expandedUtr ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    {expandedUtr ? 'Hide' : 'Show'} row details ({utrRowTotal.toLocaleString('en-IN')})
                  </button>
                )}

                {expandedUtr && (
                  <div className="space-y-1.5">
                    {/* Truncation note ABOVE the short scroll box. */}
                    <UploadTruncationNote
                      shown={utrRows.length}
                      total={utrRowTotal}
                      truncated={utrRowsCut}
                      noun={utrResult.rows ? 'rows' : 'problem rows'}
                      next={utrResult.rows
                        ? 'The counts above cover the whole file. Apply still uses every row.'
                        : 'Fix these in your file and upload it again to see the rest.'}
                    />
                    <div className="max-h-52 overflow-y-auto border border-gray-100 rounded-xl divide-y divide-gray-50" data-testid="utr-row-details">
                      {utrRows.map((r, i) => (
                        <div key={i} data-testid={`utr-row-${r.rowNum}`} className={`flex items-center justify-between gap-3 px-4 py-2.5 text-xs
                          ${r.status === 'ERROR' ? 'bg-red-50' : r.status === 'SKIP' ? 'bg-gray-50' : ''}`}
                        >
                          <div className="min-w-0">
                            <span className="text-gray-400 mr-2">Row {r.rowNum}</span>
                            <span className="font-mono text-gray-700">{r.outletId}</span>
                            {r.utr && <span className="ml-2 text-gray-500">UTR: {r.utr}</span>}
                            {r.paymentDate && (
                              <span className="ml-2 text-gray-400">Paid: {new Date(r.paymentDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
                            )}
                            {r.status === 'OK' && r.success === false && (
                              <span className="ml-2 text-amber-700">Marked failed{r.remarks ? `: ${r.remarks}` : ''}</span>
                            )}
                            {r.errors.length > 0 && (
                              <p className="text-red-600 mt-0.5">{r.errors.join(' · ')}</p>
                            )}
                            {r.status === 'SKIP' && (
                              <p className="text-gray-500 mt-0.5">{r.notice?.trim() || UTR_SKIP_REASON}</p>
                            )}
                          </div>
                          <span className={`shrink-0 px-2 py-0.5 rounded-full font-medium
                            ${r.status === 'OK' ? 'bg-emerald-100 text-emerald-700'
                             : r.status === 'ERROR' ? 'bg-red-100 text-red-700'
                             : 'bg-gray-100 text-gray-500'}`}>
                            {r.status === 'SKIP' ? 'Skipped' : r.status === 'ERROR' ? 'Error' : 'OK'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Apply failure. The message block above only renders with no preview loaded, so an
                    apply error (incl. the "couldn't confirm" lost-response case) was previously invisible. */}
                {utrMsg && (
                  <div role="alert" className="bg-red-50 text-red-700 text-xs px-4 py-3 rounded-xl">
                    {utrMsg}
                  </div>
                )}
                {utrApplyUnconfirmed && utrResult.canProceed && (
                  <p id="utr-apply-paused-hint" data-testid="utr-apply-paused-hint" className="text-xs text-gray-600">
                    {UTR_APPLY_PAUSED_HINT}
                  </p>
                )}

                {/* Apply / Reset */}
                <div className="flex gap-3">
                  {utrResult.canProceed && (
                    <button
                      onClick={handleApplyUtr}
                      disabled={utrApplying || utrApplyUnconfirmed}
                      aria-describedby={utrApplyUnconfirmed ? 'utr-apply-paused-hint' : undefined}
                      className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <BadgeCheck className="w-4 h-4" />
                      {utrApplying ? 'Applying…' : 'Apply UTR Results'}
                    </button>
                  )}
                  <button
                    onClick={resetUtrForm}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Reset
                  </button>
                  <DownloadErrorReportButton
                    columns={['Row', 'Outlet ID', 'Batch ID', 'UTR', 'Status']}
                    rows={utrProblemRows
                      .filter(r => r.errors.length > 0)
                      .map(r => ({
                        Row:        r.rowNum,
                        'Outlet ID': r.outletId,
                        'Batch ID':  r.batchId,
                        UTR:        r.utr,
                        Status:     r.status,
                        __errors:   r.errors,
                      }))}
                    errorsByRow={(row) => (row.__errors as string[]) ?? []}
                    filename="utr-upload-errors.xlsx"
                    sheetName="UTR Errors"
                    truncation={{ shown: utrProblemRows.filter(r => r.errors.length > 0).length, total: utrResult.problemRowCount ?? utrResult.summary.errors, truncated: utrProblemsCut, noun: 'problems' }}
                  />
                </div>
              </div>
            )}

            {utrApplied && utrApplyResult && utrApplyResult.notApplied.length > 0 && (
              <div
                role="alert"
                data-testid="utr-not-applied"
                className="rounded-xl p-4 border bg-amber-50 border-amber-200 space-y-1.5"
              >
                <p className="text-sm font-semibold text-amber-800 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  These rows were not applied:
                </p>
                <ul className="max-h-52 overflow-y-auto list-disc pl-6 space-y-0.5 text-xs text-amber-800">
                  {utrApplyResult.notApplied.map((r, i) => (
                    <li key={`${r.outletId}-${r.rowNum ?? i}`}>
                      {r.rowNum != null && <span className="text-amber-600">Row {r.rowNum} · </span>}
                      <span className="font-mono">{r.outletId}</span> — {r.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {utrApplied && utrApplyResult && utrApplyResult.tdsCreditReleased.length > 0 && (
              <div role="status" data-testid="utr-tds-credit-released" className="rounded-xl p-4 border bg-blue-50 border-blue-200 space-y-1 text-xs text-blue-800">
                <p className="text-sm font-semibold">TDS credit returned</p>
                <ul className="list-disc pl-5 space-y-0.5">
                  {utrApplyResult.tdsCreditReleased.map((r) => <li key={r.entryId}>{r.note}</li>)}
                </ul>
              </div>
            )}

            {utrApplied && utrApplyResult?.noop && (
              // Nothing changed (every row was already applied) — a neutral note with the server's own
              // message, never the green "UTR results applied · 0 paid · 0 failed · N skipped" banner.
              <div
                role="status"
                data-testid="utr-apply-noop"
                className="rounded-xl p-4 flex items-center gap-3 border bg-gray-50 border-gray-200"
              >
                <CheckCircle className="w-5 h-5 text-gray-500 flex-shrink-0" />
                <p className="text-sm text-gray-700">{utrApplyResult.message ?? 'Already applied — nothing to change'}</p>
                <button onClick={resetUtrForm} className="ml-auto text-xs text-gray-600 hover:underline">
                  Upload another
                </button>
              </div>
            )}

            {utrApplied && utrApplyResult && !utrApplyResult.noop && (() => {
              // Amber (not green) whenever some rows were marked FAILED — a bank
              // bounce is a real-money outcome the operator must see, never a
              // green "success" banner. Green ONLY when every applied row paid.
              // Rows the apply could NOT record are an issue too — never a green banner alone.
              const hasIssues = utrApplyResult.failedCount > 0 || utrApplyResult.notApplied.length > 0;
              return (
                <div className={`rounded-xl p-4 flex items-center gap-3 border ${
                  hasIssues ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'
                }`}>
                  {hasIssues
                    ? <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                    : <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />}
                  <div>
                    <p className={`text-sm font-semibold ${hasIssues ? 'text-amber-800' : 'text-emerald-800'}`}>
                      {hasIssues ? 'Applied with issues' : 'UTR results applied'}
                    </p>
                    <p className={`text-xs mt-0.5 ${hasIssues ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {utrApplyResult.paidCount} paid · {utrApplyResult.failedCount} failed · {utrApplyResult.skippedCount} skipped
                    </p>
                  </div>
                  <button
                    onClick={resetUtrForm}
                    className={`ml-auto text-xs hover:underline ${hasIssues ? 'text-amber-700' : 'text-emerald-700'}`}
                  >
                    Upload another
                  </button>
                </div>
              );
            })()}
          </>
        )}
      </div>

      {/* ── Section 3: Pending Reversals ────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
          <RotateCcw className="w-4 h-4 text-gray-400" />
          Pending Reversal Requests
          {(pendingPg?.total ?? reversals.length) > 0 && (
            <span className="ml-auto bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-medium">
              {pendingPg?.total ?? reversals.length}
            </span>
          )}
        </h3>

        {revOutcome && (
          <div
            ref={revOutcomeRef}
            tabIndex={-1}
            role="status"
            data-testid="reversal-outcome"
            className="text-xs text-gray-800 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 space-y-1 focus:outline-none focus:ring-2 focus:ring-blue-300"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold">{revOutcome.title}</p>
              <button onClick={() => setRevOutcome(null)} className="text-gray-500 hover:text-gray-800" aria-label="Dismiss">×</button>
            </div>
            <ul className="list-disc pl-4 space-y-0.5">
              {revOutcome.lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </div>
        )}

        {reversals.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">No pending reversal requests.</p>
        ) : (
          <div className="space-y-3">
            {reversals.map((rev) => (
              <div key={rev.id} className="border border-amber-200 bg-amber-50 rounded-xl p-4 space-y-3">
                <div className="flex flex-wrap gap-4 text-xs">
                  <div>
                    <p className="text-gray-500">Outlet</p>
                    <p className="font-medium text-gray-800">{rev.outletName}</p>
                    <p className="text-gray-400 font-mono">{rev.outletId}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Field</p>
                    <p className="font-medium text-gray-800">{rev.fieldName}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Period</p>
                    <p className="font-medium text-gray-800">{monthLabel(rev.period)}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Award</p>
                    <p className="font-medium text-gray-800">{rev.awardType}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Requested Amount</p>
                    <p className="font-medium text-gray-800">
                      {rev.awardType === 'PAYOUT'
                        ? rupees(rev.requestedPaise)
                        : `${Number(rev.requestedPaise).toLocaleString('en-IN')} pts`}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500">Requested At</p>
                    <p className="font-medium text-gray-800">{new Date(rev.requestedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
                  </div>
                </div>

                {rev.requestRemarks && (
                  <p className="text-xs text-gray-700 break-words" data-testid={`request-remarks-${rev.id}`}>
                    <span className="text-gray-500">Requester&apos;s note:</span> {rev.requestRemarks}
                  </p>
                )}

                {rev.payoutEntries && rev.payoutEntries.length > 0 && (
                  <div className="text-xs" data-testid={`held-entries-${rev.id}`}>
                    <p className="text-gray-500">
                      Payout entries held for this request (kept out of bank files) · {rev.payoutEntries.length}{' '}
                      {rev.payoutEntries.length === 1 ? 'entry' : 'entries'}
                    </p>
                    <ul className="mt-1 space-y-0.5 max-h-40 overflow-auto pr-1">
                      {rev.payoutEntries.map((pe) => (
                        <li key={pe.payoutEntryId} className="text-gray-800">
                          <span className="font-medium">{rupees(pe.amountPaise)}</span>
                          {' — '}
                          <span className="text-gray-600">{ENTRY_STATUS_TEXT[pe.entryStatus] ?? pe.entryStatus}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {hasProcessingEntry(rev) && (
                  <p
                    role="note"
                    id={`processing-block-${rev.id}`}
                    data-testid={`processing-block-${rev.id}`}
                    className="flex items-start gap-1.5 text-xs text-amber-800"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden />
                    {PROCESSING_BLOCK_TEXT}
                  </p>
                )}

                {revAction?.id === rev.id ? (
                  <div className="bg-white rounded-xl p-3 space-y-3 border border-gray-200">
                    <p className="text-xs font-semibold text-gray-800 capitalize">{revAction.action} Reversal</p>
                    {revAction.action === 'approve' && rev.awardType === 'PAYOUT' && (
                      // Interim whole-entry rule: the request was matched to whole payout entries
                      // when it was raised, so a payout reversal is approved in full or rejected.
                      <p className="text-xs text-gray-600">
                        Payout reversals are approved for the full requested amount (
                        {rupees(rev.requestedPaise)}) — whole payout entries only.
                        Unpaid entries are cancelled; an already-paid entry becomes a receivable to recover off-platform.
                        To change the amount, reject this request and raise a new one.
                      </p>
                    )}
                    {revAction.action === 'approve' && rev.awardType !== 'PAYOUT' && (
                      <div className="space-y-1">
                        <label className="text-xs text-gray-600">
                          Approved Amount (pts, leave blank for full amount)
                        </label>
                        <input
                          type="number"
                          value={revAmount}
                          onChange={(e) => setRevAmount(e.target.value)}
                          placeholder={String(Number(rev.requestedPaise))}
                          max={Number(rev.requestedPaise)}
                          min={1}
                          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                        />
                      </div>
                    )}
                    <div className="space-y-1">
                      <label htmlFor={`rev-remarks-${rev.id}`} className="text-xs text-gray-600">Remarks (optional)</label>
                      <input
                        id={`rev-remarks-${rev.id}`}
                        type="text"
                        value={revRemarks}
                        onChange={(e) => setRevRemarks(e.target.value)}
                        maxLength={1000}
                        className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                      />
                    </div>
                    {revMsg && <p role="alert" className="text-xs text-red-600">{revMsg}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={handleReversalAction}
                        disabled={revLoading || (revAction.action === 'approve' && hasProcessingEntry(rev))}
                        aria-describedby={revAction.action === 'approve' && hasProcessingEntry(rev) ? `processing-block-${rev.id}` : undefined}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-50
                          ${revAction.action === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}
                      >
                        {revLoading ? 'Processing…' : revAction.action === 'approve' ? 'Confirm Approve' : 'Confirm Reject'}
                      </button>
                      <button
                        onClick={() => { setRevAction(null); setRevMsg(''); }}
                        className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setRevAction({ id: rev.id, action: 'approve' }); setRevAmount(''); setRevRemarks(''); setRevMsg(''); }}
                      disabled={hasProcessingEntry(rev)}
                      aria-describedby={hasProcessingEntry(rev) ? `processing-block-${rev.id}` : undefined}
                      title={hasProcessingEntry(rev) ? PROCESSING_BLOCK_TEXT : undefined}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ThumbsUp className="w-3.5 h-3.5" />
                      Approve
                    </button>
                    <button
                      onClick={() => { setRevAction({ id: rev.id, action: 'reject' }); setRevAmount(''); setRevRemarks(''); setRevMsg(''); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-100 text-red-700 text-xs font-medium rounded-lg hover:bg-red-200"
                    >
                      <ThumbsDown className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Pending reversals pagination */}
        {pendingPg && pendingPg.pages > 1 && (
          <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-gray-500 pt-1">
            <span>
              Page <strong className="text-gray-800">{pendingPg.page}</strong> of{' '}
              <strong className="text-gray-800">{pendingPg.pages}</strong> ·{' '}
              <strong className="text-gray-800">{pendingPg.total}</strong> total
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPendingPage((p) => Math.max(1, p - 1))}
                disabled={pendingPg.page <= 1}
                className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setPendingPage((p) => p + 1)}
                disabled={pendingPg.page >= pendingPg.pages}
                className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Section 4: Reversal Report — processed (supposed / reversed / pending) ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
          <RotateCcw className="w-4 h-4 text-gray-400" />
          Reversal Report
          {(processedPg?.total ?? processedReversals.length) > 0 && (
            <span className="ml-auto bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full font-medium">
              {processedPg?.total ?? processedReversals.length}
            </span>
          )}
        </h3>
        <p className="text-xs text-gray-400">
          Approved reversals. <strong>Pending</strong> = the portion that could not be reclaimed
          (the partner had already redeemed those points) — the client settles this off-platform;
          the platform takes no further action.
        </p>

        {processedReversals.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">No processed reversals.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 text-left border-b border-gray-200">
                  <th className="py-2 pr-3 font-medium">Outlet</th>
                  <th className="py-2 pr-3 font-medium">Field</th>
                  <th className="py-2 pr-3 font-medium">Period</th>
                  <th className="py-2 pr-3 font-medium text-right">Supposed</th>
                  <th className="py-2 pr-3 font-medium text-right">Reversed</th>
                  <th className="py-2 pr-3 font-medium text-right">Pending</th>
                  <th className="py-2 font-medium">Approved</th>
                </tr>
              </thead>
              <tbody>
                {processedReversals.map((rev) => {
                  const isPayout = rev.awardType === 'PAYOUT';
                  // approvedPaise = "supposed"; shortfallPaise = "pending"; reversed = supposed - pending.
                  // PAYOUT values are integer paise (÷100 for ₹); POINTS are whole points (as-is).
                  const supposed = Number(rev.approvedPaise ?? 0);
                  const pending  = Number(rev.shortfallPaise ?? 0);
                  const reversed = supposed - pending;
                  const fmt = (v: number) =>
                    isPayout ? rupees(v) : `${v.toLocaleString('en-IN')} pts`;
                  const entries = rev.payoutEntries ?? [];
                  const outcomeText = !isPayout && typeof rev.pointsOutcome?.summary === 'string' ? rev.pointsOutcome.summary : null;
                  const hasDetails = entries.length > 0 || !!rev.requestRemarks || !!rev.remarks || !!outcomeText;
                  return (
                    <Fragment key={rev.id}>
                    <tr className={hasDetails ? '' : 'border-b border-gray-100'}>
                      <td className="py-2 pr-3">
                        <span className="font-medium text-gray-800">{rev.outletName}</span>
                        <span className="block text-gray-400 font-mono">{rev.outletId}</span>
                      </td>
                      <td className="py-2 pr-3 text-gray-700">{rev.fieldName}</td>
                      <td className="py-2 pr-3 text-gray-700">{monthLabel(rev.period)}</td>
                      <td className="py-2 pr-3 text-right font-medium text-gray-800">{fmt(supposed)}</td>
                      <td className="py-2 pr-3 text-right font-medium text-emerald-700">{fmt(reversed)}</td>
                      <td className="py-2 pr-3 text-right font-medium">
                        {pending > 0 ? (
                          <span className="inline-block bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{fmt(pending)}</span>
                        ) : (
                          <span className="text-gray-400">{fmt(0)}</span>
                        )}
                      </td>
                      <td className="py-2 text-gray-500">
                        {rev.approvedAt ? new Date(rev.approvedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}
                      </td>
                    </tr>
                    {hasDetails && (
                      <tr className="border-b border-gray-100" data-testid={`processed-details-${rev.id}`}>
                        <td colSpan={7} className="pb-2 pr-3 text-gray-600 space-y-0.5">
                          {outcomeText && (
                            <p className="break-words" data-testid={`points-outcome-${rev.id}`}>
                              <span className="text-gray-400">Outcome:</span> {outcomeText}
                            </p>
                          )}
                          {rev.requestRemarks && (
                            <p className="break-words"><span className="text-gray-400">Requester&apos;s note:</span> {rev.requestRemarks}</p>
                          )}
                          {rev.remarks && (
                            <p className="break-words"><span className="text-gray-400">Decision note:</span> {rev.remarks}</p>
                          )}
                          {entries.length > 0 && (
                            <ul className="list-disc pl-4 space-y-0.5 max-h-40 overflow-auto">
                              {entries.map((pe) => (
                                <li key={pe.payoutEntryId}>{processedEntryText(pe)}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Processed reversals pagination */}
        {processedPg && processedPg.pages > 1 && (
          <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-gray-500 pt-1">
            <span>
              Page <strong className="text-gray-800">{processedPg.page}</strong> of{' '}
              <strong className="text-gray-800">{processedPg.pages}</strong> ·{' '}
              <strong className="text-gray-800">{processedPg.total}</strong> total
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setProcessedPage((p) => Math.max(1, p - 1))}
                disabled={processedPg.page <= 1}
                className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setProcessedPage((p) => p + 1)}
                disabled={processedPg.page >= processedPg.pages}
                className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
