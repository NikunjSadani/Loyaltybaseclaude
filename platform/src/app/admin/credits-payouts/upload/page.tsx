'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  Download,
  Upload,
  CheckCircle,
  XCircle,
  AlertTriangle,
  FileSpreadsheet,
  ChevronRight,
  RotateCcw,
  Coins,
  ExternalLink,
} from 'lucide-react';
import Link from 'next/link';
import { useAdminSession } from '@/lib/admin-session';
import { generateCreditTemplate } from '@/lib/credits-payouts-template';
import { parseCreditUpload }      from '@/lib/credits-payouts-parser';
import { getGifsySettings }       from '@/lib/gifsy-settings';
import { jsonToSheetSafe }        from '@/lib/xlsx-safe';
import { downloadBlob }           from '@/lib/download';
import { DeductionsPanel }        from './_components/deductions-panel';
import {
  ACK_ORDER,
  BeforeYouConfirm,
  NotReadyPanel,
  UploadPreviewStatus,
  notReadyOutlets,
  presentCategories,
  previewRequestBody,
  type AckCategory,
  type UploadPreviewData,
  type UploadPreviewState,
} from './_components/before-you-confirm';
import type { CreditField, CreditParseResult } from '@/types';
import type { TemplateOutlet } from '@/lib/credits-payouts-template';

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

function downloadBuffer(buf: ArrayBuffer, fileName: string) {
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  downloadBlob(blob, fileName);
}

function isUploadWindowOpen(cutoffDay: number): boolean {
  return new Date().getDate() <= cutoffDay;
}

/**
 * Rows to POST when saving a batch: ONLY the OK rows, unchanged.
 *
 * The parser emits one row per outlet × field, so a mostly-blank file is mostly SKIP rows
 * (amount 0, plus a long skipReason). Every server-side reader of CreditBatch.rows acts only on
 * `status === 'OK'` rows (create-time caps/whole-unit checks, confirm, reversals, wallet pairing,
 * the Status page), and SKIP rows carry amount 0 so they never match a credit either. ERROR rows
 * can't be present (canProceed requires no errors). Sending the SKIP rows only bloated the body —
 * 6,517 outlets × 7 fields with 2 values was ~12.7 MB and got truncated by the frontend proxy.
 * The points-engine direct-credit path already stores OK rows only, so this is not a new shape.
 * OK rows are sent whole (every field is read: narration → wallet description, outletName/
 * fieldName → Status page + reversals, originalAmount → audit), so each stored row is identical.
 */
function rowsToSave(rows: CreditParseResult['rows']): CreditParseResult['rows'] {
  return rows.filter((r) => r.status === 'OK');
}

const PAYOUT_STATUS_HREF = '/admin/credits-payouts/status';

// ─── User-facing messages for the save → confirm requests ────────────────────
// Every message must be TRUE whatever actually happened server-side. Once a batch is saved
// this preview never saves another one (see `pendingBatch`), so none of these invite a re-upload.

/** Save rejected with 413 — the body was too large for the server/proxy. */
const SAVE_TOO_LARGE_MSG =
  'The upload was too large for the server — nothing was credited. Split the file into smaller uploads and try again.';

/**
 * Save failed for any other reason (5xx, non-JSON reply, network drop). A gateway timeout can
 * arrive after the API created the (unconfirmed) batch, so we don't claim "nothing was saved" —
 * only that nothing was credited, which is always true (crediting happens at confirm).
 */
function saveFailedMsg(serverError?: string): string {
  return `Couldn't save the batch${serverError ? ` (${serverError})` : ''} — nothing was credited. ` +
    'If an unconfirmed batch from this attempt appears in Payout Status, ignore it and upload again.';
}

/** Batch saved, but the confirm outcome is unknown (5xx / non-JSON / network drop). */
function confirmUnknownMsg(batchCode: string, serverError?: string): string {
  return `Batch ${batchCode} was saved but we couldn't confirm whether it was credited` +
    `${serverError ? ` (${serverError})` : ''}. Check Payout Status: if it shows Confirmed, you're done; ` +
    'if it shows Pending Approval, use Retry confirm below. Do not upload this file again.';
}

/** Batch saved, confirm REJECTED with a readable reason (e.g. upload window closed) — nothing credited. */
function confirmRejectedMsg(batchCode: string, serverError: string): string {
  return `Batch ${batchCode} was saved but not confirmed: ${serverError.trim().replace(/\.+$/, '')}. ` +
    "Nothing has been credited yet. Once that's resolved, use Retry confirm below (or check Payout Status). " +
    'Do not upload this file again.';
}

/** Confirm says the batch is already CONFIRMED — e.g. an earlier attempt went through. */
function alreadyConfirmedMsg(batchCode: string): string {
  return `Batch ${batchCode} is already confirmed — its credits were applied when it was first confirmed. ` +
    'See Payout Status for what was credited. Do not upload this file again.';
}

interface ApiEnvelope {
  success?: boolean;
  data?: Record<string, unknown> & { id?: string; batchCode?: string };
  error?: string;
}

/**
 * Read a reply's `{ success, data | error }` envelope without ever throwing. `body` is null when
 * the reply isn't a JSON object (e.g. a proxy's plain-text "Internal Server Error"), so callers
 * show a readable message instead of a raw SyntaxError.
 */
async function readReply(res: Response): Promise<{ status: number; body: ApiEnvelope | null }> {
  try {
    const body = (await res.json()) as unknown;
    return { status: res.status, body: body && typeof body === 'object' ? (body as ApiEnvelope) : null };
  } catch {
    return { status: res.status, body: null };
  }
}

/** A string `error` from an envelope, if the server sent one. */
function serverErrorOf(body: ApiEnvelope | null): string | undefined {
  return typeof body?.error === 'string' && body.error.trim() ? body.error : undefined;
}

/** A batch that was saved by this preview (whether or not its confirm has gone through). */
interface PendingBatch {
  id:               string;
  batchCode:        string;
  totalOutlets:     number;
  totalPoints:      number;
  totalPayoutPaise: number;
}

type Step = 'template' | 'upload' | 'preview' | 'done';

interface SkippedRow {
  outletId:  string;
  fieldName: string;
  /** Negative for a skipped deduction row. */
  points:    number;
  reason:    string;
  /** 'DEDUCTION' for a deduction row that was NOT deducted (absent for credits). */
  kind?:     'DEDUCTION';
}

const isDeductionSkip = (s: SkippedRow) => s.kind === 'DEDUCTION';

interface SavedBatch {
  id:               string;
  batchCode:        string;
  totalOutlets:     number;
  totalPoints:      number;
  /** totalPayoutPaise from the API — integer paise. */
  totalPayoutPaise: number;
  // ── confirm-time actuals (what the server actually did) ──
  /** Number of POINTS rows actually credited. */
  pointsCreditedRows:  number;
  /** Sum of points actually credited (may be < uploaded total if rows were skipped). */
  pointsCreditedTotal: number;
  payoutEntriesCreated: number;
  /** Deduction rows actually deducted (0 when the batch has none / the setting is OFF). */
  pointsDeductedRows:  number;
  /** Sum (positive magnitude) of the points actually deducted. */
  pointsDeductedTotal: number;
  /** Deduction rows in the file that the server did NOT apply at all (switch off) — 0 normally. */
  deductionsIgnored:   number;
  /** Rows the server could NOT credit, with a reason. */
  skipped: SkippedRow[];
  /** The "Before you confirm" boxes ticked for this confirm (their checkbox text), shown on the done screen. */
  acceptedLabels: string[];
}

/** Human-readable explanation for a server-side skip reason. */
function skipReasonLabel(reason: string): string {
  switch (reason) {
    case 'OUTLET_NOT_FOUND':
      return 'Outlet ID not found in this tenant';
    case 'OUTLET_NOT_LINKED_TO_PARTNER':
      return 'Outlet is not linked to a partner account (onboard/KYC the outlet first)';
    default:
      return reason;
  }
}

/** "3 rows NOT credited" — unchanged unless some skipped rows are deductions. */
function skippedHeader(skipped: SkippedRow[]): string {
  const d = skipped.filter(isDeductionSkip).length;
  const c = skipped.length - d;
  const rows = (n: number) => `${n} row${n !== 1 ? 's' : ''}`;
  if (d === 0) return `${rows(c)} NOT credited`;
  if (c === 0) return `${rows(d)} NOT deducted`;
  return `${rows(c)} NOT credited · ${rows(d)} NOT deducted`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CreditsPayoutsUploadPage() {
  const session  = useAdminSession();
  const settings = getGifsySettings();
  const cp       = settings.creditsPayouts ?? {
    monthCutoffDay:  28,
    safetyCapPoints: 50000,
    safetyCapInr:    100000,
    fourEyesEnabled: false,
    notifyEmails:    [],
  };

  const uploadWindowOpen = isUploadWindowOpen(cp.monthCutoffDay);
  // Per-tenant (Gifsy-set) switch: negative POINTS deduct from the wallet. Strict `=== true`.
  const negativeDeductions = settings.creditUploadNegativeDeductions === true;

  const [step,        setStep]        = useState<Step>('template');
  const [period]                      = useState(getPreviousMonth());
  const [fields,      setFields]      = useState<CreditField[]>([]);
  const [outlets,     setOutlets]     = useState<TemplateOutlet[]>([]);
  const [fileName,    setFileName]    = useState('');
  const [dragging,    setDragging]    = useState(false);
  const [parsing,     setParsing]     = useState(false);
  const [parseResult, setParseResult] = useState<CreditParseResult | null>(null);
  const [confirming,  setConfirming]  = useState(false);
  const [saved,       setSaved]       = useState(false);
  const [savedBatch,  setSavedBatch]  = useState<SavedBatch | null>(null);
  const [confirmError, setConfirmError] = useState('');
  /** The batch this preview already SAVED — from then on only its confirm may be retried. */
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);
  /** Confirm reported the pending batch as already CONFIRMED — nothing left to retry. */
  const [alreadyConfirmed, setAlreadyConfirmed] = useState(false);
  /**
   * Server check of every OK POINTS row's outlet (found / linked / wallet balance / readiness / prior deductions),
   * every tenant. null = the file has no OK POINTS rows (nothing to check).
   */
  const [preview, setPreview] = useState<UploadPreviewState | null>(null);
  /** Bumped by "Check again" to re-run the preview for the same parse. */
  const [previewRun, setPreviewRun] = useState(0);
  /** Ignore a stale preview reply after a newer file / re-check replaced it. */
  const previewSeqRef = useRef(0);
  /** "Before you confirm" boxes ticked (reset whenever the parse or the preview answer changes). */
  const [acked, setAcked] = useState<Set<AckCategory>>(() => new Set());
  const hasDeductions = (parseResult?.summary.deducted ?? 0) > 0;
  const previewData: UploadPreviewData | null = preview?.status === 'ok' ? preview.data : null;
  const categories = useMemo(
    () => (parseResult && !parseResult.headerError ? presentCategories(parseResult, previewData) : []),
    [parseResult, previewData],
  );
  const notReady = useMemo(
    () => (parseResult && previewData ? notReadyOutlets(parseResult.rows, previewData) : []),
    [parseResult, previewData],
  );
  const unticked = categories.filter((c) => !acked.has(c.category));
  // HARD blocks (no tick overrides them) first, then the unticked boxes. null = Confirm may run.
  const confirmBlockReason: string | null =
    preview?.status === 'loading'
      ? 'Checking wallet balances… Confirm switches on when the check is done.'
      : preview?.status === 'error'
        ? "Couldn't check wallet balances — use Check again. Confirm stays off until the check succeeds."
        : hasDeductions && previewData && !previewData.deductionsEnabled
          ? 'Deductions are switched off for this client — remove the negative rows or ask Gifsy.'
          : notReady.length > 0
            ? `${notReady.length} outlet wallet${notReady.length !== 1 ? 's are' : ' is'} not prepared for deductions, so the server would refuse the whole batch (nothing credited or deducted). Ask Gifsy to prepare ${notReady.length !== 1 ? 'these wallets' : 'this wallet'}, or remove those rows and re-upload.`
            : unticked.length > 0
              ? `Tick ${unticked.length === 1 ? 'the box' : `all ${unticked.length} boxes`} under "Before you confirm" to continue.`
              : null;
  /** A hard block (not just unticked boxes) — shown in red. */
  const isHardBlock = !!confirmBlockReason && !confirmBlockReason.startsWith('Tick ');

  const fileInputRef    = useRef<HTMLInputElement>(null);
  const confirmErrorRef = useRef<HTMLDivElement>(null);
  /** Synchronous re-entry guard (a double-click lands before `confirming` re-renders the button). */
  const inFlightRef     = useRef(false);

  /** Forget any saved batch — ONLY when a fresh file replaces this preview. */
  function clearPendingBatch() {
    setPendingBatch(null);
    setAlreadyConfirmed(false);
    setConfirmError('');
  }

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/credits/fields?active=true').then((r) => r.json()),
      fetch('/api/admin/credits/eligible-outlets').then((r) => r.json()),
    ]).then(([fieldsRes, outletsRes]) => {
      if (fieldsRes.success)  setFields(fieldsRes.data);
      if (outletsRes.success) setOutlets(outletsRes.data);
    }).catch(() => {});
  }, []);

  // Server check of the file's points rows — every tenant, whenever the parse has OK POINTS rows (a PAYOUT-only file
  // needs none). Re-run by "Check again" (previewRun). Any failure is a visible hard block, never silent.
  useEffect(() => {
    const seq = ++previewSeqRef.current;
    const req = parseResult && !parseResult.headerError ? previewRequestBody(parseResult.rows, period) : null;
    if (!req) {
      setPreview(null);
      return;
    }
    setPreview({ status: 'loading' });
    (async () => {
      let next: UploadPreviewState;
      try {
        const res = await fetch('/api/admin/credits/upload-preview', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(req),
        });
        const { status, body } = await readReply(res);
        const d = body?.data as Partial<UploadPreviewData> | undefined;
        if (res.ok && body?.success && d && Array.isArray(d.outlets)) {
          next = {
            status: 'ok',
            data: {
              deductionsEnabled: d.deductionsEnabled === true,
              outlets:           d.outlets,
              priorDeductions:   Array.isArray(d.priorDeductions) ? d.priorDeductions : [],
            },
          };
        } else {
          next = { status: 'error', message: `${(serverErrorOf(body) ?? `the server answered HTTP ${status}`).replace(/\.+$/, '')}.` };
        }
      } catch {
        next = { status: 'error', message: 'the server could not be reached.' };
      }
      if (seq === previewSeqRef.current) setPreview(next);
    })();
  }, [parseResult, period, previewRun]);

  // New file / Upload Again / a fresh preview answer → every box must be ticked again.
  useEffect(() => {
    setAcked(new Set());
  }, [parseResult, preview]);

  function toggleAck(c: AckCategory) {
    setAcked((cur) => {
      const next = new Set(cur);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  }

  // ─── Step 1: Download template ──────────────────────────────────────────────

  function handleDownloadTemplate() {
    const buf = generateCreditTemplate(fields, period, outlets);
    downloadBuffer(buf, `credits-payouts-${period}-template.xlsx`);
  }

  // ─── Step 2: Upload file ────────────────────────────────────────────────────

  async function processFile(file: File) {
    setFileName(file.name);
    setParsing(true);
    setParseResult(null);
    clearPendingBatch();

    const buf    = await file.arrayBuffer();
    const result = parseCreditUpload(buf, {
      fields,
      outlets,
      month:           period,
      safetyCapPoints: cp.safetyCapPoints,
      safetyCapInr:    cp.safetyCapInr,
      negativeDeductions,
    });

    setParseResult(result);
    setParsing(false);
    setStep('preview');
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [fields, period, outlets, cp, negativeDeductions]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Step 3: Confirm ────────────────────────────────────────────────────────
  //
  // DOUBLE-CREDIT GUARD: once this preview has SAVED a batch (`pendingBatch`), it never saves
  // another. Every post-save failure offers "Retry confirm" for the SAME batch id instead —
  // confirm is idempotent server-side (guarded PENDING_CONFIRM → CONFIRMED claim), and an
  // "already CONFIRMED" reply is reported as such. Only a fresh upload (Upload Again / a new
  // file) clears it.

  async function handleConfirm() {
    if (!parseResult?.canProceed || inFlightRef.current) return;
    // Hard blocks + unticked "Before you confirm" boxes (the button is disabled too; this guards keyboard / races).
    if (!pendingBatch && confirmBlockReason) return;
    inFlightRef.current = true;
    setConfirming(true);
    setConfirmError('');

    try {
      const batch = pendingBatch ?? (await saveBatch(parseResult));
      if (batch) await confirmSavedBatch(batch);
    } finally {
      inFlightRef.current = false;
      setConfirming(false);
    }
  }

  /** POST the batch. Returns it when saved (and records it as pending), or null after showing why not. */
  async function saveBatch(pr: CreditParseResult): Promise<PendingBatch | null> {
    // Only the OK rows (see rowsToSave); totals unchanged from the parse.
    const okRows = rowsToSave(pr.rows);
    const uniqueOutlets = new Set(okRows.map((r) => r.outletId));

    let reply: Awaited<ReturnType<typeof readReply>>;
    try {
      const saveRes = await fetch('/api/admin/credits/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period,
          totalOutlets:    uniqueOutlets.size,
          totalPoints:     pr.summary.totalPoints,
          // totalPayoutPaise: already in paise from the parser
          totalPayoutPaise: pr.summary.totalPayoutPaise,
          rows:             okRows,
        }),
      });
      reply = await readReply(saveRes);
    } catch {
      // Network drop / aborted request — never surface a raw TypeError.
      showConfirmError(saveFailedMsg());
      return null;
    }

    const { status, body } = reply;
    if (status === 413) {
      showConfirmError(SAVE_TOO_LARGE_MSG);
      return null;
    }
    if (status >= 500 || !body) {
      showConfirmError(saveFailedMsg(status >= 500 ? serverErrorOf(body) : undefined));
      return null;
    }
    if (!body.success || !body.data?.id) {
      // A readable rejection (validation, safety cap, upload window) — the batch was NOT created.
      showConfirmError(serverErrorOf(body) ?? 'Failed to save batch');
      return null;
    }

    const d = body.data;
    const batch: PendingBatch = {
      id:               String(d.id),
      batchCode:        String(d.batchCode ?? d.id),
      totalOutlets:     Number(d.totalOutlets),
      totalPoints:      Number(d.totalPoints),
      // BigInt is serialised to number via toJSON patch in api/src/main.ts
      totalPayoutPaise: Number(d.totalPayoutPaise),
    };
    setPendingBatch(batch);
    return batch;
  }

  /** POST /confirm for an already-saved batch (first attempt or a retry). Never saves a batch. */
  async function confirmSavedBatch(batch: PendingBatch) {
    // Only the ticked categories that are present; the server refuses a confirm missing one it finds.
    const acknowledged = ACK_ORDER.filter((c) => acked.has(c) && categories.some((x) => x.category === c));
    const acceptedLabels = categories.filter((c) => acknowledged.includes(c.category)).map((c) => c.label);
    let reply: Awaited<ReturnType<typeof readReply>>;
    try {
      // Confirm (creates payout entries + notifies Gifsy)
      const confirmRes = await fetch(`/api/admin/credits/batches/${batch.id}/confirm`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ acknowledged, skippedRows: parseResult?.summary.skipped ?? 0 }),
      });
      reply = await readReply(confirmRes);
    } catch {
      showConfirmError(confirmUnknownMsg(batch.batchCode));
      return;
    }

    const { status, body } = reply;
    if (status >= 500 || !body) {
      showConfirmError(confirmUnknownMsg(batch.batchCode, status >= 500 ? serverErrorOf(body) : undefined));
      return;
    }
    if (!body.success) {
      const err = serverErrorOf(body) ?? 'Failed to confirm batch';
      // confirmBatch: `Batch is already ${batch.status}` for any non-PENDING_CONFIRM batch.
      const already = /^Batch is already (\w+)/.exec(err)?.[1];
      if (already === 'CONFIRMED') {
        setAlreadyConfirmed(true);
        showConfirmError(alreadyConfirmedMsg(batch.batchCode));
      } else if (already) {
        // Some other terminal state — we can't say what was credited; point to Payout Status.
        showConfirmError(confirmUnknownMsg(batch.batchCode, err));
      } else {
        showConfirmError(confirmRejectedMsg(batch.batchCode, err));
      }
      return;
    }

    // The confirm response is the source of truth for what was ACTUALLY credited.
    // (Previously this was ignored, so silently-skipped points showed as "success".)
    const cd = body.data ?? {};
    setSavedBatch({
      ...batch,
      pointsCreditedRows:   Number(cd.pointsCredited ?? 0),
      pointsCreditedTotal:  Number(cd.pointsCreditedTotal ?? 0),
      payoutEntriesCreated: Number(cd.payoutEntriesCreated ?? 0),
      // Present only when the batch had deduction rows (absent → 0, a credit-only reply is unchanged).
      pointsDeductedRows:   Number(cd.pointsDeducted ?? 0),
      // The file had deduction rows but the server applied none of them (no `pointsDeducted` in the reply — the
      // program's switch was turned off meanwhile). Said loudly on the done screen, never silently.
      deductionsIgnored:    (parseResult?.summary.deducted ?? 0) > 0 && cd.pointsDeducted === undefined
        ? (parseResult?.summary.deducted ?? 0) : 0,
      pointsDeductedTotal:  Math.abs(Number(cd.pointsDeductedTotal ?? 0)),
      skipped:             Array.isArray(cd.skipped) ? (cd.skipped as SkippedRow[]) : [],
      acceptedLabels,
    });
    setSaved(true);
    setStep('done');
  }

  /** Show an error/notice next to the Confirm button and bring it into view. */
  function showConfirmError(message: string) {
    setConfirmError(message);
    // After render: the alert sits beside the buttons, but a long preview can push it off-screen.
    requestAnimationFrame(() => confirmErrorRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
  }

  // ─── Download report ─────────────────────────────────────────────────────────

  function handleDownloadReport() {
    if (!parseResult) return;
    import('xlsx').then((XLSX) => {
      // "Typed Amount" appears only when something was rounded (whole-number uploads keep
      // the exact previous report layout).
      const anyRounded = parseResult.rows.some((r) => r.originalAmount !== undefined);
      // "Type" appears only when the parse has deductions (OFF / credit-only report unchanged).
      const withType = (parseResult.summary.deducted ?? 0) > 0;
      const rowType = (r: CreditParseResult['rows'][number]) =>
        r.awardType === 'POINTS' && (r.amount < 0 || (r.originalAmount ?? 0) < 0) ? 'Deduction' : 'Credit';
      const rows = parseResult.rows.map((r) => ({
        'Outlet ID':   r.outletId,
        'Outlet Name': r.outletName,
        'Field':       r.fieldName,
        ...(anyRounded ? { 'Typed Amount': r.originalAmount ?? '' } : {}),
        'Amount':      r.amount || '',
        'Award Type':  r.awardType,
        ...(withType ? { 'Type': rowType(r) } : {}),
        'Status':      r.status,
        'Narration':   r.narration,
        'Errors':      r.errors.length > 0 ? r.errors.join('; ') : (r.skipReason ?? ''),
      }));
      const ws = jsonToSheetSafe(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Upload Report');

      // The server-check findings ("Before you confirm" lists beyond the first 20, and unprepared wallets) — skipped
      // and rounded rows are already in the main sheet. Absent when there is nothing to report.
      const checkRows = [
        ...categories
          .filter((c) => c.category !== 'SKIPPED' && c.category !== 'ROUNDED')
          .flatMap((c) => c.items.map((it) => ({ 'Check': c.title, 'Row': it.text, 'Detail': it.detail ?? '' }))),
        ...notReady.map((o) => ({
          'Check':  'Wallet not prepared for deductions — confirm refused',
          'Row':    o.outletCode,
          'Detail': o.reason ?? '',
        })),
      ];
      if (checkRows.length > 0) {
        XLSX.utils.book_append_sheet(wb, jsonToSheetSafe(checkRows), 'Before you confirm');
      }

      // After a confirm, append the server-side skipped rows (what was NOT credited
      // and why) so the report actually explains the skips — not just the client parse.
      if (savedBatch && savedBatch.skipped.length > 0) {
        const anyDeductionSkip = savedBatch.skipped.some(isDeductionSkip);
        const skippedRows = savedBatch.skipped.map((s) => ({
          'Outlet ID': s.outletId,
          'Field':     s.fieldName,
          ...(anyDeductionSkip ? { 'Type': isDeductionSkip(s) ? 'Deduction (NOT deducted)' : 'Credit (NOT credited)' } : {}),
          'Points':    s.points,
          'Reason':    skipReasonLabel(s.reason),
        }));
        const sws = jsonToSheetSafe(skippedRows);
        XLSX.utils.book_append_sheet(wb, sws, anyDeductionSkip ? 'Skipped (Not Applied)' : 'Skipped (Not Credited)');
      }

      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
      downloadBuffer(buf, `credits-payouts-${period}-report.xlsx`);
    });
  }

  function handleReset() {
    setStep('template');
    setFileName('');
    setParseResult(null);
    setSaved(false);
    setSavedBatch(null);
    clearPendingBatch();
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  const stepLabel = (s: Step, n: number, title: string) => (
    <div className={`flex items-center gap-2 ${step === s ? 'text-[var(--brand-primary)]' : step > s || saved ? 'text-emerald-600' : 'text-gray-400'}`}>
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2
        ${step === s ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                    : 'border-current bg-transparent'}`}>
        {n}
      </div>
      <span className="text-sm font-medium hidden sm:block">{title}</span>
      {n < 3 && <ChevronRight className="w-3.5 h-3.5 text-gray-300 hidden sm:block" />}
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Coins className="w-5 h-5 text-[var(--brand-primary)]" />
        <div>
          <h2 className="text-lg font-bold text-gray-900">Upload Credits & Payouts</h2>
          <p className="text-xs text-gray-500">Period: <strong>{monthLabel(period)}</strong></p>
        </div>
      </div>

      {!uploadWindowOpen && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800">Upload window closed</p>
            <p className="text-xs text-amber-700 mt-0.5">
              The cutoff for <strong>{monthLabel(period)}</strong> was day&nbsp;
              <strong>{cp.monthCutoffDay}</strong> of this month.
            </p>
          </div>
        </div>
      )}

      {/* Stepper */}
      <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 px-5 py-3">
        {stepLabel('template', 1, 'Download Template')}
        {stepLabel('upload',   2, 'Upload File')}
        {stepLabel('preview',  3, 'Preview & Confirm')}
      </div>

      {/* Step 1: Download template */}
      {(step === 'template' || step === 'upload') && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Step 1 — Download Template</h3>
          <p className="text-xs text-gray-500">
            Template includes {fields.length} active field{fields.length !== 1 ? 's' : ''} for {monthLabel(period)}.
            Outlets: {outlets.length} eligible.
          </p>
          {fields.length === 0 ? (
            <div className="bg-amber-50 rounded-lg p-4 text-xs text-amber-700">
              No active fields configured. Ask your Gifsy admin to set up fields first.
            </div>
          ) : (
            <button
              onClick={handleDownloadTemplate}
              disabled={!uploadWindowOpen}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              Download Template ({fields.filter((f) => f.isActive).length} fields)
            </button>
          )}
          {step === 'template' && fields.length > 0 && (
            <button
              onClick={() => setStep('upload')}
              className="text-xs text-[var(--brand-primary)] hover:underline"
            >
              Skip — I already have a filled template →
            </button>
          )}
        </div>
      )}

      {/* Step 2: Upload */}
      {(step === 'upload' || step === 'template') && fields.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Step 2 — Upload Filled Template</h3>
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer
              ${dragging ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5' : 'border-gray-300 hover:border-gray-400'}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <FileSpreadsheet className="w-8 h-8 text-gray-400 mx-auto mb-3" />
            <p className="text-sm text-gray-600 font-medium">
              {fileName ? fileName : 'Drop your filled template here or click to browse'}
            </p>
            <p className="text-xs text-gray-400 mt-1">.xlsx files only</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
          {parsing && (
            <p className="text-xs text-gray-500 text-center animate-pulse">Parsing file…</p>
          )}
        </div>
      )}

      {/* Step 3: Preview & Confirm */}
      {step === 'preview' && parseResult && (
        <div className="space-y-4">
          {parseResult.headerError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-800">File format error</p>
                <p className="text-xs text-red-700 mt-1">{parseResult.headerError}</p>
              </div>
            </div>
          )}

          {/* Summary cards */}
          {/* Without deductions the four cards are exactly as before ("Total Pts"). */}
          <div className={`grid grid-cols-2 ${hasDeductions ? 'sm:grid-cols-5' : 'sm:grid-cols-4'} gap-3`}>
            {[
              { label: 'OK Rows',   value: parseResult.summary.ok,      color: 'text-emerald-600',
                sub: hasDeductions
                  ? `${parseResult.summary.ok - parseResult.summary.deducted} to credit or pay · ${parseResult.summary.deducted} to deduct`
                  : undefined },
              { label: 'Skipped',   value: parseResult.summary.skipped,  color: 'text-gray-500' },
              { label: 'Errors',    value: parseResult.summary.errors,   color: 'text-red-600' },
              // Same unit ("pts") on both totals when there are deductions; "Total Pts" exactly as before otherwise.
              { label: hasDeductions ? 'Total credited' : 'Total Pts',
                value: hasDeductions
                  ? `${parseResult.summary.totalPoints.toLocaleString('en-IN')} pts`
                  : parseResult.summary.totalPoints.toLocaleString('en-IN'),
                color: 'text-blue-600' },
              ...(hasDeductions
                ? [{ label: 'Total deducted', value: `${parseResult.summary.totalDeductedPoints.toLocaleString('en-IN')} pts`, color: 'text-orange-600' }]
                : []),
            ].map((c: { label: string; value: string | number; color: string; sub?: string }) => (
              <div key={c.label} className="bg-white rounded-xl border border-gray-200 p-3 text-center min-w-0">
                {/* 5 cards at 640px: smaller value text that wraps instead of overflowing. */}
                <p className={`${hasDeductions ? 'text-lg sm:text-base md:text-xl break-words' : 'text-xl'} font-bold ${c.color}`}>{c.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{c.label}</p>
                {c.sub && <p className="text-[11px] text-gray-600 mt-0.5 break-words" data-testid="credits-ok-split">{c.sub}</p>}
              </div>
            ))}
          </div>

          {parseResult.summary.totalPayoutPaise > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              <p className="text-sm text-emerald-800">
                {/* totalPayoutPaise is integer paise; divide by 100 for human display */}
                Total Payout: <strong>₹{(parseResult.summary.totalPayoutPaise / 100).toLocaleString('en-IN')}</strong>
              </p>
            </div>
          )}

          <DeductionsPanel rows={parseResult.rows} />

          <UploadPreviewStatus state={preview} onRetry={() => setPreviewRun((n) => n + 1)} />

          {hasDeductions && previewData && !previewData.deductionsEnabled && (
            <div role="alert" className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-start gap-2" data-testid="credits-deductions-off">
              <XCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-xs text-red-800">
                Deductions are switched off for this client — remove the negative rows or ask Gifsy. Nothing in this file
                can be confirmed while it has negative points.
              </p>
            </div>
          )}

          <NotReadyPanel outlets={notReady} />

          {parseResult.hasErrors && (
            <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
              <div className="px-4 py-3 bg-red-50 border-b border-red-100">
                <p className="text-xs font-semibold text-red-800 flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {parseResult.summary.errors} error{parseResult.summary.errors !== 1 ? 's' : ''} — fix and re-upload
                </p>
              </div>
              <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
                {parseResult.rows
                  .filter((r) => r.status === 'ERROR')
                  .slice(0, 10)
                  .map((r, i) => (
                    <div key={i} className="px-4 py-2.5">
                      <p className="text-xs font-medium text-gray-800">
                        Row {r.rowNum} · {r.outletId} · {r.fieldName}
                      </p>
                      {r.errors.map((e, j) => (
                        <p key={j} className="text-xs text-red-600 mt-0.5">• {e}</p>
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Skipped / rounded / not applied / below zero / repeat — each listed with a required tick. */}
          <BeforeYouConfirm
            categories={categories}
            acked={acked}
            onToggle={toggleAck}
            disabled={saved || preview?.status === 'loading'}
          />

          {/* Next to the buttons (and scrolled into view) so a failed click is never invisible. */}
          {confirmError && (
            <div
              ref={confirmErrorRef}
              role="alert"
              className={`rounded-xl p-4 flex items-start gap-3 border ${
                alreadyConfirmed ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}
            >
              <AlertTriangle className={`w-5 h-5 flex-shrink-0 mt-0.5 ${alreadyConfirmed ? 'text-amber-500' : 'text-red-500'}`} />
              <p className={`text-sm ${alreadyConfirmed ? 'text-amber-800' : 'text-red-700'}`}>{confirmError}</p>
            </div>
          )}

          {parseResult.canProceed && !saved && !pendingBatch && confirmBlockReason && (
            <p
              id="confirm-block-reason"
              className={`text-xs ${isHardBlock ? 'text-red-700' : 'text-amber-800'}`}
              data-testid="credits-confirm-blocked"
            >
              Confirm is disabled: {confirmBlockReason}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            {parseResult.canProceed && !saved && !pendingBatch && (
              <button
                onClick={handleConfirm}
                aria-describedby={confirmBlockReason ? 'confirm-block-reason' : undefined}
                disabled={!uploadWindowOpen || confirming || !!confirmBlockReason}
                className="flex items-center gap-2 px-4 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <CheckCircle className="w-4 h-4" />
                {confirming ? 'Saving…' : 'Confirm & Credit'}
              </button>
            )}
            {/* A batch is already saved: only its confirm may be retried — never a second batch. */}
            {pendingBatch && !saved && !alreadyConfirmed && (
              <button
                onClick={handleConfirm}
                disabled={confirming}
                className="flex items-center gap-2 px-4 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RotateCcw className="w-4 h-4" />
                {confirming ? 'Confirming…' : `Retry confirm for ${pendingBatch.batchCode}`}
              </button>
            )}
            {pendingBatch && !saved && (
              <Link
                href={PAYOUT_STATUS_HREF}
                className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
              >
                <ExternalLink className="w-4 h-4" />
                Open Payout Status
              </Link>
            )}
            <button
              onClick={handleDownloadReport}
              className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <Download className="w-4 h-4" />
              Download Report
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <RotateCcw className="w-4 h-4" />
              Upload Again
            </button>
          </div>
        </div>
      )}

      {/* Done */}
      {step === 'done' && savedBatch && (
        <div className="bg-white rounded-xl border border-emerald-200 p-6 text-center space-y-3">
          {savedBatch.skipped.length > 0
            ? <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto" />
            : <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto" />}
          <div>
            <p className="font-semibold text-gray-900">
              {savedBatch.skipped.length > 0
                ? 'Credits confirmed — some rows were skipped'
                : 'Credits confirmed successfully'}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Batch: <code className="font-mono bg-gray-100 px-1 rounded">{savedBatch.batchCode}</code>
            </p>
            {/* Show what was ACTUALLY credited (from the confirm response), not just the uploaded totals. */}
            <p className="text-xs text-gray-500">
              {savedBatch.pointsCreditedRows > 0
                ? `${savedBatch.pointsCreditedRows} outlet${savedBatch.pointsCreditedRows !== 1 ? 's' : ''} credited · ${savedBatch.pointsCreditedTotal.toLocaleString('en-IN')} pts`
                : 'No points credited'}
              {savedBatch.payoutEntriesCreated > 0 && ` · ${savedBatch.payoutEntriesCreated} payout entr${savedBatch.payoutEntriesCreated !== 1 ? 'ies' : 'y'}`}
              {savedBatch.totalPayoutPaise > 0 && ` · ₹${(savedBatch.totalPayoutPaise / 100).toLocaleString('en-IN')} payout`}
              {savedBatch.pointsDeductedRows > 0 &&
                ` · ${savedBatch.pointsDeductedRows} deduction${savedBatch.pointsDeductedRows !== 1 ? 's' : ''} · ${savedBatch.pointsDeductedTotal.toLocaleString('en-IN')} pts deducted`}
            </p>
          </div>

          {savedBatch.acceptedLabels.length > 0 && (
            <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-left" data-testid="credits-accepted">
              <p className="text-xs font-semibold text-gray-800">You accepted:</p>
              <ul className="list-disc pl-4 mt-1 space-y-0.5">
                {savedBatch.acceptedLabels.map((l) => (
                  <li key={l} className="text-xs text-gray-700">{l.replace(/^I understand /, '')}</li>
                ))}
              </ul>
            </div>
          )}

          {savedBatch.deductionsIgnored > 0 && (
            <div role="alert" data-testid="credits-deductions-ignored" className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-left">
              <p className="text-xs font-semibold text-red-800">
                {savedBatch.deductionsIgnored} deduction row{savedBatch.deductionsIgnored !== 1 ? 's were' : ' was'} NOT deducted
              </p>
              <p className="text-xs text-red-700 mt-0.5">
                Negative points are not turned on for this program on the server, so the negative values in this file were
                ignored — only the credits were applied. Ask Gifsy before deducting these points another way.
              </p>
            </div>
          )}

          {savedBatch.skipped.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl text-left overflow-hidden">
              <div className="px-4 py-2.5 border-b border-amber-100">
                <p className="text-xs font-semibold text-amber-800 flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {skippedHeader(savedBatch.skipped)}
                </p>
              </div>
              <div className="divide-y divide-amber-100 max-h-52 overflow-y-auto">
                {savedBatch.skipped.slice(0, 12).map((s, i) => (
                  <div key={i} className="px-4 py-2">
                    <p className="text-xs font-medium text-gray-800">
                      {isDeductionSkip(s)
                        ? `${s.outletId} · ${s.fieldName} · −${Math.abs(s.points).toLocaleString('en-IN')} pts · NOT deducted`
                        : `${s.outletId} · ${s.fieldName} · ${s.points.toLocaleString('en-IN')} pts`}
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">{skipReasonLabel(s.reason)}</p>
                  </div>
                ))}
                {savedBatch.skipped.length > 12 && (
                  <p className="px-4 py-2 text-xs text-amber-700">
                    …and {savedBatch.skipped.length - 12} more — see the downloaded report.
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="flex gap-3 justify-center pt-2">
            <button
              onClick={handleDownloadReport}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <Download className="w-4 h-4" />
              Download Report
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <Upload className="w-4 h-4" />
              New Upload
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
