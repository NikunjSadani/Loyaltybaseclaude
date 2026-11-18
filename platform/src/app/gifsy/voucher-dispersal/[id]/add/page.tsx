'use client';

/* ─── Voucher Dispersal — "Add more people" (/gifsy/voucher-dispersal/[id]/add) ────────────────────
   Owner-approved 2026-11-18 ("Add to the same campaign"). On a FINISHED campaign (Completed / Completed
   with errors, nothing in flight — the server's `addPeopleBlockedReason` says otherwise, word for word):
   upload another file → preview → "Buy & send" (confirm dialog → POST batches/:n/confirm with the preview
   id + the numbers shown) → the campaign page. Each upload is the next numbered batch; only the new
   batch's VALID rows are bought. A phone already sent (or failed) in an earlier batch is DUPLICATE with the
   batch named. The budget is checked against what is LEFT (spent + committed + this batch ≤ budget); over
   it → Buy is blocked with the reason and "Raise the budget" (Edit dialog → the preview is re-read).
   A batch waiting for confirmation is resumed here (GET batches/:n); Discard removes it (nothing bought).
   A network error / 5xx on confirm = outcome UNKNOWN → the campaign is re-read to find out.
──────────────────────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import {
  ROW_STATUS_TONE, batchConfirmBlock, batchLabel, checkUploadFile, confirmDialogTitle, confirmPayload, formatCount,
  formatRupees, isSetupCampaign, isUncertainFailure, plural, rowStatusText, vdApi,
  type RowStatus, type VdBatchPreview, type VdListItem,
} from '@/lib/voucher-dispersal';
import {
  ConfirmDialog, EditCampaignDialog, ErrorPanel, LoadingBlock, StatusChip, TemplateDownloadButton,
} from '@/components/voucher-dispersal/vd-ui';

const ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE_SIZE = 50;
type Notice = { text: string; tone: 'info' | 'warning' } | null;
/** After a confirm attempt with an unknown outcome: checking · uncertain (re-read failed). */
type ConfirmState = 'idle' | 'checking' | 'uncertain';

export default function AddPeoplePage() {
  const params = useParams();
  const router = useRouter();
  const id = String(Array.isArray(params.id) ? params.id[0] : params.id ?? '');
  const campaignHref = `/gifsy/voucher-dispersal/${encodeURIComponent(id)}`;

  const [item, setItem] = useState<VdListItem | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<VdBatchPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const inFlight = useRef(false);

  /** Load the campaign; if a batch is waiting for confirmation, load its preview (resume). */
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const r = await vdApi.getCampaign(id);
    if (!r.ok) { setLoadError(r.error); setLoading(false); return; }
    setItem(r.data);
    const pending = r.data.batches.find((b) => b.status === 'PREVIEWED' && (b.batchNumber ?? 0) >= 2);
    if (pending?.batchNumber) {
      const p = await vdApi.getBatch(id, pending.batchNumber);
      if (p.ok) { setPreview(p.data); setPreviewError(null); } else setPreviewError(p.error);
    } else {
      setPreview(null);
    }
    setLoading(false);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  /** Re-read the batch preview (after a budget edit the budget LEFT changes). */
  const reloadPreview = useCallback(async (n: number) => {
    const p = await vdApi.getBatch(id, n);
    if (p.ok) { setPreview(p.data); setPreviewError(null); } else setPreviewError(p.error);
    const c = await vdApi.getCampaign(id);
    if (c.ok) setItem(c.data);
  }, [id]);

  // ── upload ──
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const pickFile = (f: File | null) => {
    setUploadError(null);
    if (!f) return;
    const problem = checkUploadFile(f);
    if (problem) { setFile(null); setFileError(problem); return; }
    setFileError(null);
    setFile(f);
  };
  const onUpload = async () => {
    if (!file || inFlight.current) return;
    inFlight.current = true;
    setUploading(true);
    setUploadError(null);
    const r = await vdApi.uploadBatch(id, file);
    inFlight.current = false;
    setUploading(false);
    if (!r.ok) { setUploadError(r.error); return; }
    setPreview(r.data);
    setPreviewError(null);
    setShowUpload(false);
    setFilter('ALL');
    setPage(1);
    setConfirmError(null);
    setConfirmState('idle');
    setNotice(null);
  };

  // ── preview table ──
  const [filter, setFilter] = useState<'ALL' | RowStatus>('ALL');
  const [page, setPage] = useState(1);
  const filteredRows = useMemo(
    () => (preview ? (filter === 'ALL' ? preview.rows : preview.rows.filter((r) => r.status === filter)) : []),
    [preview, filter],
  );
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageRows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const statusCounts = useMemo(() => {
    const m = new Map<RowStatus, { n: number; label: string }>();
    for (const r of preview?.rows ?? []) {
      const cur = m.get(r.status);
      m.set(r.status, { n: (cur?.n ?? 0) + 1, label: r.status === 'UNKNOWN' ? 'Unknown status' : rowStatusText(r) });
    }
    return m;
  }, [preview]);

  // ── confirm / discard / edit ──
  const [dialog, setDialog] = useState<'buy' | 'discard' | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>('idle');
  const [editOpen, setEditOpen] = useState(false);
  const block = preview ? batchConfirmBlock(preview) : ({ blocked: true, reason: 'Upload a file first.' } as const);
  const outcomeUnknown = confirmState !== 'idle';

  /** After an unknown confirm outcome: is the batch confirmed now? */
  const recheck = useCallback(async (n: number) => {
    setConfirmState('checking');
    const r = await vdApi.getCampaign(id);
    if (!r.ok) { setConfirmState('uncertain'); return; }
    const b = r.data.batches.find((x) => x.batchNumber === n);
    if (b && b.status === 'CONFIRMED') { router.push(campaignHref); return; }
    setItem(r.data);
    setConfirmState('idle');
    setNotice({ tone: 'info', text: `Checked: ${batchLabel(n).toLowerCase()} is still not confirmed, so nothing in it was bought. You can try again.` });
  }, [id, router, campaignHref]);

  const onBuy = async () => {
    if (!preview || preview.batchNumber === null || block.blocked || outcomeUnknown || inFlight.current) return;
    const body = confirmPayload(preview);
    if (!body) return;
    inFlight.current = true;
    setBusy(true);
    setConfirmError(null);
    const r = await vdApi.confirmBatch(id, preview.batchNumber, body);
    inFlight.current = false;
    setBusy(false);
    if (r.ok) {
      setDialog(null);
      void vdApi.process(id); // start buying at once (single-flight); the campaign page shows progress
      router.push(campaignHref);
      return;
    }
    if (isUncertainFailure(r.status)) {
      setDialog(null);
      setNotice({ tone: 'warning', text: `We couldn't tell whether buying started (${r.error}). Checking the campaign — do not confirm again until this says so.` });
      await recheck(preview.batchNumber);
      return;
    }
    setConfirmError(r.error); // a definite refusal — word for word; the dialog stays open
  };

  const onDiscard = async () => {
    if (!preview || preview.batchNumber === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setConfirmError(null);
    const n = preview.batchNumber;
    const r = await vdApi.discardBatch(id, n);
    inFlight.current = false;
    setBusy(false);
    if (!r.ok && !isUncertainFailure(r.status)) { setConfirmError(r.error); return; }
    setDialog(null);
    if (r.ok) {
      setNotice({ tone: 'info', text: `${batchLabel(n)} discarded${r.data.discardedRows !== null ? `: ${plural(r.data.discardedRows, 'row')} removed` : ''}. Nothing was bought.` });
    } else {
      setNotice({ tone: 'warning', text: `We couldn't tell whether the discard worked (${r.error}). Reloading the campaign.` });
    }
    setPreview(null);
    setFile(null);
    await load();
  };

  // ── render ──
  if (loading && !item) return <LoadingBlock label="Loading campaign…" />;
  if (!item) return <ErrorPanel message={`Couldn't load this campaign: ${loadError ?? 'no reply from the server.'}`} onRetry={() => void load()} />;

  const c = item.campaign;
  const back = (
    <Link href={campaignHref} className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white">
      <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> Back to the campaign
    </Link>
  );
  const s = preview?.summary;
  const skipped = s ? (s.invalid ?? 0) + (s.duplicates ?? 0) : 0;
  const blockedReason = !preview ? (isSetupCampaign(c.status) ? 'Confirm the first file before adding more people (this campaign is still in setup).' : c.addPeopleBlockedReason) : null;
  const uploadVisible = !preview || showUpload;

  return (
    <div className="space-y-6" data-testid="vd-add">
      <div className="space-y-2">
        {back}
        <h1 className="text-xl font-bold text-white break-words">Add more people — {c.name || 'Untitled campaign'}</h1>
        <p className="text-xs text-white/60 break-words">
          Budget {formatRupees(c.budgetRupees)}. Vouchers already bought in this campaign stay as they are.{' '}
          <span data-testid="vd-add-nothing-spent">Nothing in this new file is bought until you confirm it.</span>
        </p>
      </div>

      {notice && (
        <div role="status" data-testid="vd-notice"
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${notice.tone === 'warning' ? 'border-amber-500/40 bg-amber-500/10 text-amber-100' : 'border-sky-500/30 bg-sky-500/10 text-sky-200'}`}>
          <p className="flex-1 min-w-0 break-words">{notice.text}</p>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message" className="shrink-0 opacity-70 hover:opacity-100">
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {blockedReason ? (
        <div role="alert" data-testid="vd-add-blocked" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 break-words">
          {blockedReason}
        </div>
      ) : (
        <>
          {previewError && <ErrorPanel message={`Couldn't load the waiting batch: ${previewError}`} onRetry={() => void load()} testId="vd-preview-error" />}

          {uploadVisible && (
            <section aria-labelledby="vd-add-upload-heading" className="space-y-4">
              <h2 id="vd-add-upload-heading" className="text-base font-semibold text-white">
                {preview ? `Replace ${batchLabel(preview.batchNumber).toLowerCase()} with another file` : 'Upload the new list'}
              </h2>
              <p className="text-xs text-white/60">
                Same template as the first file. A phone that already got a voucher (or has a failed purchase) in this campaign is marked Duplicate and is not bought again.
              </p>
              <TemplateDownloadButton />
              <div
                data-testid="vd-dropzone"
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (!uploading) pickFile(e.dataTransfer.files?.[0] ?? null); }}
                className="rounded-xl border-2 border-dashed border-white/15 bg-white/5 px-4 py-8 text-center focus-within:ring-2 focus-within:ring-sky-400"
              >
                <FileSpreadsheet className="w-8 h-8 mx-auto text-white/40" aria-hidden="true" />
                <p className="text-sm text-white/70 mt-2">Drag the filled-in template here, or</p>
                <label htmlFor="vd-add-file" className="mt-2 inline-block cursor-pointer rounded-lg border border-white/20 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/10">
                  Choose file
                </label>
                <input id="vd-add-file" type="file" accept={ACCEPT} className="sr-only" disabled={uploading}
                  onChange={(e) => { pickFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
                <p className="text-xs text-white/60 mt-2" aria-live="polite">{file ? `Selected: ${file.name}` : 'No file selected'}</p>
                {fileError && <p role="alert" data-testid="vd-file-error" className="text-xs text-red-300 mt-1">{fileError}</p>}
              </div>
              {uploadError && <ErrorPanel message={`Upload failed: ${uploadError}`} testId="vd-upload-error" />}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void onUpload()} disabled={!file || uploading} aria-busy={uploading} data-testid="vd-upload"
                  className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Upload className="w-4 h-4" aria-hidden="true" />}
                  {uploading ? 'Checking file…' : 'Upload and preview'}
                </button>
                {preview && (
                  <button type="button" onClick={() => setShowUpload(false)} disabled={uploading}
                    className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-60">
                    Back to the preview
                  </button>
                )}
              </div>
            </section>
          )}

          {preview && s && !showUpload && (
            <section aria-labelledby="vd-add-preview-heading" className="space-y-4">
              <h2 id="vd-add-preview-heading" className="text-base font-semibold text-white">Check {batchLabel(preview.batchNumber).toLowerCase()}, then buy</h2>
              <div data-testid="vd-summary" className={`rounded-xl border px-4 py-3 ${block.blocked ? 'border-red-500/40 bg-red-500/10' : 'border-white/10 bg-white/5'}`}>
                <p className="text-sm font-semibold text-white mb-2">{batchLabel(preview.batchNumber)} — waiting for confirmation</p>
                <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                  <div><dt className="text-[11px] uppercase text-white/50">Rows</dt><dd className="font-bold text-white">{formatCount(s.total)}</dd></div>
                  <div><dt className="text-[11px] uppercase text-white/50">Valid</dt><dd className="font-bold text-emerald-300" data-testid="vd-sum-valid">{formatCount(s.valid)}</dd></div>
                  <div><dt className="text-[11px] uppercase text-white/50">Invalid</dt><dd className={`font-bold ${(s.invalid ?? 0) > 0 ? 'text-red-300' : 'text-white'}`}>{formatCount(s.invalid)}</dd></div>
                  <div><dt className="text-[11px] uppercase text-white/50">Duplicates</dt><dd className={`font-bold ${(s.duplicates ?? 0) > 0 ? 'text-amber-300' : 'text-white'}`}>{formatCount(s.duplicates)}</dd></div>
                  <div><dt className="text-[11px] uppercase text-white/50">Warnings</dt><dd className={`font-bold ${(s.warningCount ?? 0) > 0 ? 'text-amber-300' : 'text-white'}`}>{formatCount(s.warningCount)}</dd></div>
                </dl>
                <p className="text-xs text-white/80 mt-2 break-words" data-testid="vd-sum-budget-left">
                  This batch {formatRupees(s.totalRupees)} · already spent or committed {formatRupees(preview.alreadyCommittedRupees)} · left {formatRupees(preview.remainingBudgetRupees)} of the {formatRupees(s.budgetRupees)} budget
                </p>
                {preview.crossBatchDuplicates !== null && preview.crossBatchDuplicates > 0 && (
                  <p className="text-xs text-amber-200 mt-2" data-testid="vd-sum-cross-batch">
                    {plural(preview.crossBatchDuplicates, 'row')} {preview.crossBatchDuplicates === 1 ? 'is a phone' : 'are phones'} that already got (or {preview.crossBatchDuplicates === 1 ? 'is' : 'are'} getting) a voucher in an earlier batch of this campaign — marked Duplicate, not bought again.
                  </p>
                )}
                {s.warningCount !== null && s.warningCount > 0 && (
                  <p className="text-xs text-amber-200 mt-2">
                    {plural(s.warningCount, 'valid row')} {s.warningCount === 1 ? 'is a phone that' : 'are phones that'} got a voucher in another campaign in the last 30 days — see the note on each row. This does not block buying.
                  </p>
                )}
                {s.skippedNote && <p className="text-xs text-white/70 mt-2">{s.skippedNote}.</p>}
                {s.hiddenNote && <p className="text-xs text-amber-200 mt-2">{s.hiddenNote}.</p>}
                {skipped > 0 && (
                  <p className="text-xs text-amber-200 mt-2">
                    {plural(s.invalid ?? 0, 'invalid row')} and {plural(s.duplicates ?? 0, 'duplicate row')} will NOT get a voucher. Each one is listed below with the reason.
                  </p>
                )}
                {block.blocked && (
                  <div className="mt-2 space-y-2">
                    <p role="alert" id="vd-block-reason" data-testid="vd-block-reason" className="text-sm font-semibold text-red-200">{block.reason}</p>
                    {s.overBudget && c.canEdit !== false && (
                      <button type="button" data-testid="vd-raise-budget" onClick={() => setEditOpen(true)}
                        className="rounded-lg border border-white/25 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/10">
                        Raise the budget
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label htmlFor="vd-add-filter" className="block text-xs font-semibold text-white/70 mb-1">Show rows</label>
                <select id="vd-add-filter" value={filter} onChange={(e) => { setFilter(e.target.value as 'ALL' | RowStatus); setPage(1); }}
                  className="rounded-lg border border-white/15 bg-gray-900 px-3 py-2 text-sm text-white">
                  <option value="ALL">All ({preview.rows.length})</option>
                  {[...statusCounts.entries()].map(([st, v]) => <option key={st} value={st}>{v.label} ({v.n})</option>)}
                </select>
              </div>

              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="min-w-full text-sm" data-testid="vd-preview-table">
                  <caption className="sr-only">Rows of the new file and their check result</caption>
                  <thead className="bg-white/5 text-left text-[11px] uppercase tracking-wide text-white/50">
                    <tr>
                      <th scope="col" className="px-3 py-2">Row</th>
                      <th scope="col" className="px-3 py-2">Phone</th>
                      <th scope="col" className="px-3 py-2">Name</th>
                      <th scope="col" className="px-3 py-2">Amount</th>
                      <th scope="col" className="px-3 py-2">Brand</th>
                      <th scope="col" className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {pageRows.length === 0 ? (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-white/50">No rows match this filter.</td></tr>
                    ) : pageRows.map((r, i) => (
                      <tr key={`${r.rowNumber ?? `i${i}`}-${r.phone}`} data-testid={`vd-prow-${r.rowNumber ?? `i${i}`}`}>
                        <td className="px-3 py-2 text-white/60">{formatCount(r.rowNumber)}</td>
                        <td className="px-3 py-2 font-mono text-white">{r.phone || '—'}</td>
                        <td className="px-3 py-2 text-white">{r.name || '—'}</td>
                        <td className="px-3 py-2 text-white">{formatRupees(r.amount)}</td>
                        <td className="px-3 py-2 text-white">{r.brand || '—'}</td>
                        <td className="px-3 py-2">
                          <StatusChip label={rowStatusText(r)} tone={ROW_STATUS_TONE[r.status]} />
                          {r.invalidReason && <p className="text-xs text-red-200 mt-1 break-words">{r.invalidReason}</p>}
                          {r.warning && <p className="text-xs text-amber-200 mt-1 break-words"><span className="font-semibold">Note:</span> {r.warning}</p>}
                          {!r.invalidReason && (r.status === 'INVALID' || r.status === 'DUPLICATE') && (
                            <p className="text-xs text-amber-200 mt-1">The server gave no reason.</p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pageCount > 1 && (
                <nav aria-label="Preview pages" className="flex items-center gap-3 text-xs text-white/70">
                  <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Previous</button>
                  <span>Page {page} of {pageCount}</span>
                  <button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Next</button>
                </nav>
              )}

              <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 space-y-3">
                {confirmState === 'checking' ? (
                  <p role="status" className="inline-flex items-center gap-2 text-xs text-amber-100"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Checking the campaign…</p>
                ) : confirmState === 'uncertain' ? (
                  <div role="alert" className="space-y-2 text-sm text-amber-100">
                    <p className="font-semibold">We couldn&apos;t tell whether buying started — check the campaign before trying again.</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => preview.batchNumber !== null && void recheck(preview.batchNumber)}
                        className="rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/10">Check again</button>
                      <Link href={campaignHref} className="rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10">Open the campaign</Link>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-white/80">
                    Buying spends money: one Hubble voucher per valid row of this batch, each sent on WhatsApp.
                    {skipped > 0 ? ` ${plural(skipped, 'invalid / duplicate row')} ${skipped === 1 ? 'is' : 'are'} skipped.` : ''}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => { setFile(null); setUploadError(null); setShowUpload(true); }} disabled={busy || outcomeUnknown}
                    className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-60">
                    Upload a different file
                  </button>
                  <button type="button" data-testid="vd-discard" onClick={() => { setConfirmError(null); setDialog('discard'); }} disabled={busy || outcomeUnknown}
                    className="rounded-lg border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-60">
                    Discard this batch
                  </button>
                  <button type="button" onClick={() => { setConfirmError(null); setDialog('buy'); }}
                    disabled={block.blocked || busy || outcomeUnknown}
                    aria-describedby={block.blocked ? 'vd-block-reason' : undefined}
                    data-testid="vd-buy-send"
                    className="rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                    Buy &amp; send vouchers
                  </button>
                </div>
              </div>

              <ConfirmDialog
                open={dialog === 'buy'}
                title={confirmDialogTitle(s)}
                description="Nothing can be undone once vouchers are bought."
                confirmLabel="Buy & send"
                busyLabel="Buying…"
                cancelLabel="Cancel"
                busy={busy}
                error={confirmError}
                onConfirm={() => void onBuy()}
                onClose={() => setDialog(null)}
              >
                <p>Only the {formatCount(s.valid)} valid rows of {batchLabel(preview.batchNumber).toLowerCase()} are bought. Earlier batches are not touched.</p>
              </ConfirmDialog>

              <ConfirmDialog
                open={dialog === 'discard'}
                title={`Discard ${batchLabel(preview.batchNumber).toLowerCase()}?`}
                description="Nothing in this batch has been bought. Its rows are removed; the batch stays listed as discarded."
                confirmLabel="Discard batch"
                busyLabel="Discarding…"
                busy={busy}
                error={confirmError}
                danger
                onConfirm={() => void onDiscard()}
                onClose={() => setDialog(null)}
              />

              {editOpen && (
                <EditCampaignDialog
                  open={editOpen}
                  campaign={{ id: c.id || id, name: c.name, budgetRupees: c.budgetRupees }}
                  floorRupees={item.summary.budgetFloorRupees}
                  onClose={() => setEditOpen(false)}
                  onSaved={(summary) => {
                    setEditOpen(false);
                    setNotice({ tone: 'info', text: `Campaign updated: ${summary}. The preview below is re-checked against the new budget.` });
                    if (preview.batchNumber !== null) void reloadPreview(preview.batchNumber);
                  }}
                  onUncertain={(error) => {
                    setEditOpen(false);
                    setNotice({ tone: 'warning', text: `We couldn't tell whether the budget was saved (${error}). Re-reading the campaign.` });
                    if (preview.batchNumber !== null) void reloadPreview(preview.batchNumber);
                  }}
                />
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
