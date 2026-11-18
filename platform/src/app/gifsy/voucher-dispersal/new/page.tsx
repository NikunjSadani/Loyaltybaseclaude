'use client';

/* ─── Voucher Dispersal — new campaign (/gifsy/voucher-dispersal/new[?campaign=<id>]) ─────
   One page, three steps: ① details → create  ② upload file  ③ preview + "Buy & send vouchers"
   (→ confirm dialog → POST confirm with the preview version + the numbers shown → campaign report).
   NOTHING is bought before the confirm succeeds, and the page says so — EXCEPT when a confirm
   attempt ended in a network error / 5xx: then the outcome is unknown, the "nothing bought" copy is
   withdrawn, Buy stays disabled, and the campaign is re-fetched to find out what actually happened.
   After create the URL becomes ?campaign=<id>, so refresh / back resumes the same draft.
   A successful confirm also fires ONE POST /process (single-flight, not awaited) so buying starts at
   once on Cloud Run; the campaign page keeps nudging while it is open.
──────────────────────────────────────────────────────────────────────────────────────── */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import {
  ROW_STATUS_TONE, billedToText, checkUploadFile, parseRupeeInput, rupeeEcho, confirmBlock, confirmDialogTitle, confirmPayload, defaultProgramLabel,
  fetchBillableClients, formatCount, formatRupees, isOverBudget, isSetupCampaign, isUncertainFailure, plural, rowStatusText,
  validateCreateForm, vdApi, VD_NAME_MAX, VD_NOTE_MAX, VD_PROGRAM_LABEL_MAX,
  type CreateForm, type RowStatus, type VdBrand, type VdCampaign, type VdClient, type VdPreview,
} from '@/lib/voucher-dispersal';
import { ConfirmDialog, ErrorPanel, LoadingBlock, StatusChip, TemplateDownloadButton } from '@/components/voucher-dispersal/vd-ui';

type Step = 'details' | 'upload' | 'preview';
const STEPS: { key: Step; label: string }[] = [
  { key: 'details', label: 'Details' },
  { key: 'upload', label: 'Upload file' },
  { key: 'preview', label: 'Check & buy' },
];

/** After a confirm attempt: idle · checking (re-fetching after an unknown outcome) · uncertain (re-fetch failed) · clear (re-fetch proved still in setup). */
type ConfirmState = 'idle' | 'checking' | 'uncertain' | 'clear';

const ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE_SIZE = 50;

const NOTHING_SPENT = 'Nothing has been bought or sent yet — vouchers are only bought after you confirm.';
const UNKNOWN_OUTCOME = "We couldn't tell whether this started — check the campaign before trying again.";

const inputCls =
  'w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] disabled:opacity-60';

function FieldError({ id, msg }: { id: string; msg?: string }) {
  if (!msg) return null;
  return <p id={id} className="text-xs text-red-300 mt-1">{msg}</p>;
}

function StepHeader({ step }: { step: Step }) {
  const idx = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="flex flex-wrap gap-2" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          aria-current={i === idx ? 'step' : undefined}
          className={`rounded-full px-3 py-1 text-xs font-semibold border ${
            i === idx ? 'bg-white text-gray-900 border-white' : i < idx ? 'border-emerald-500/40 text-emerald-300' : 'border-white/15 text-white/40'
          }`}
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}

function BrandsHelp({ brands, error, onRetry }: { brands: VdBrand[] | null; error: string | null; onRetry: () => void }) {
  if (error) return <ErrorPanel message={`Couldn't load the brand list: ${error}`} onRetry={onRetry} testId="vd-brands-error" />;
  if (!brands) return <p className="text-xs text-white/40">Loading brands…</p>;
  if (brands.length === 0) return <p className="text-xs text-amber-300">No voucher brands are configured on the server.</p>;
  return (
    <details className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
      <summary className="cursor-pointer font-semibold text-white/80">Brands you can use in the file ({brands.length})</summary>
      <ul className="mt-2 space-y-1">
        {brands.map((b) => (
          <li key={b.key} data-testid={`vd-brand-${b.key}`}>
            <span className="font-mono text-white">{b.key}</span> — {b.label}:{' '}
            {b.available === false
              ? <span className="text-amber-300">not available right now ({b.unavailableReason ?? 'Hubble did not return its limits'}) — rows for it will be invalid; upload again later.</span>
              : b.denominations && b.denominations.length > 0
                ? `only ${b.denominations.map((d) => formatRupees(d)).join(', ')}`
                : b.denominationType === 'FIXED'
                  ? <span className="text-amber-300">fixed amounts, but Hubble did not list them — rows for it will be invalid; try later.</span>
                  : `${formatRupees(b.minAmount)} to ${formatRupees(b.maxAmount)}`}
          </li>
        ))}
      </ul>
    </details>
  );
}

function NewCampaignFlow() {
  const router = useRouter();
  const search = useSearchParams();
  const resumeId = search.get('campaign');

  const [step, setStep] = useState<Step>('details');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    headingRef.current?.focus();
  }, [step]);

  // ── reference data ──
  const [brands, setBrands] = useState<VdBrand[] | null>(null);
  const [brandsError, setBrandsError] = useState<string | null>(null);
  const loadBrands = useCallback(async () => {
    setBrandsError(null);
    const r = await vdApi.brands();
    if (r.ok) setBrands(r.data); else setBrandsError(r.error);
  }, []);
  const [clients, setClients] = useState<VdClient[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const loadClients = useCallback(async () => {
    setClientsError(null);
    const r = await fetchBillableClients();
    if (r.ok) setClients(r.data); else setClientsError(r.error);
  }, []);
  useEffect(() => { void loadBrands(); void loadClients(); }, [loadBrands, loadClients]);

  // ── campaign (created or resumed) ──
  const [campaign, setCampaign] = useState<VdCampaign | null>(null);
  const campaignRef = useRef<VdCampaign | null>(null);
  campaignRef.current = campaign;
  const [resumeLoading, setResumeLoading] = useState(!!resumeId);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const loadResume = useCallback(async () => {
    if (!resumeId) return;
    // Just created here and the URL caught up (router.replace) — nothing to load.
    if (campaignRef.current?.id === resumeId) { setResumeLoading(false); return; }
    setResumeLoading(true);
    setResumeError(null);
    const r = await vdApi.getCampaign(resumeId);
    if (!r.ok) { setResumeError(r.error); setResumeLoading(false); return; }
    const c = r.data.campaign;
    if (!isSetupCampaign(c.status)) {
      router.replace(`/gifsy/voucher-dispersal/${encodeURIComponent(c.id || resumeId)}`);
      return;
    }
    setCampaign(c);
    setStep('upload');
    setResumeLoading(false);
  }, [resumeId, router]);
  useEffect(() => { void loadResume(); }, [loadResume]);

  // ── ① details ──
  const [form, setForm] = useState<CreateForm>({ name: '', programLabel: '', billedToClientId: '', note: '', budgetRupees: '' });
  const [labelTouched, setLabelTouched] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const errors = validateCreateForm(form);

  const onPickClient = (id: string) => {
    setForm((f) => {
      const c = clients?.find((x) => x.id === id);
      const programLabel = c && !labelTouched ? defaultProgramLabel(c.name) : f.programLabel;
      return { ...f, billedToClientId: id, programLabel };
    });
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    setCreateError(null);
    const r = await vdApi.createCampaign({
      name: form.name.trim(),
      programLabel: form.programLabel.trim(),
      ...(form.billedToClientId ? { billedToClientId: form.billedToClientId } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
      budgetRupees: Number(parseRupeeInput(form.budgetRupees).clean),
    });
    inFlight.current = false;
    setCreating(false);
    if (!r.ok) { setCreateError(r.error); return; }
    if (!r.data.id) { setCreateError('The server did not return the new campaign. Check the campaign list before creating it again.'); return; }
    campaignRef.current = r.data;
    setCampaign(r.data);
    setStep('upload');
    // Refresh / back now resumes this same draft instead of creating another one.
    router.replace(`/gifsy/voucher-dispersal/new?campaign=${encodeURIComponent(r.data.id)}`);
  };

  // ── ② upload ──
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const pickFile = (f: File | null) => {
    setUploadError(null);
    if (!f) return;
    const problem = checkUploadFile(f);
    if (problem) { setFile(null); setFileError(problem); return; }
    setFileError(null);
    setFile(f);
  };

  const [preview, setPreview] = useState<VdPreview | null>(null);
  const onUpload = async () => {
    if (!campaign || !file || inFlight.current) return;
    inFlight.current = true;
    setUploading(true);
    setUploadError(null);
    const r = await vdApi.upload(campaign.id, file);
    inFlight.current = false;
    setUploading(false);
    if (!r.ok) { setUploadError(r.error); return; }
    setPreview(r.data);
    if (r.data.campaign?.id) setCampaign(r.data.campaign);
    setFilter('ALL');
    setPage(1);
    setConfirmError(null);
    setConfirmState('idle');
    setStep('preview');
  };

  // ── ③ preview + buy ──
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

  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>('idle');
  const block = preview ? confirmBlock(preview) : ({ blocked: true, reason: 'Upload a file first.' } as const);
  const outcomeUnknown = confirmState === 'checking' || confirmState === 'uncertain';

  /** After an unknown confirm outcome: find out from the server whether the campaign started. */
  const recheck = useCallback(async () => {
    const c = campaignRef.current;
    if (!c) return;
    setConfirmState('checking');
    const r = await vdApi.getCampaign(c.id);
    if (!r.ok) { setConfirmState('uncertain'); return; }
    if (!isSetupCampaign(r.data.campaign.status)) {
      router.push(`/gifsy/voucher-dispersal/${encodeURIComponent(c.id)}`);
      return;
    }
    setConfirmState('clear');
  }, [router]);

  const onConfirm = async () => {
    if (!campaign || !preview || block.blocked || outcomeUnknown || inFlight.current) return;
    const body = confirmPayload(preview);
    if (!body) return;
    inFlight.current = true;
    setConfirming(true);
    setConfirmError(null);
    const r = await vdApi.confirm(campaign.id, body);
    inFlight.current = false;
    setConfirming(false);
    if (r.ok) {
      setDialogOpen(false);
      // Nudge processing right away (single-flight; the result is not awaited — the campaign page shows progress).
      void vdApi.process(campaign.id);
      router.push(`/gifsy/voucher-dispersal/${encodeURIComponent(campaign.id)}`);
      return;
    }
    if (isUncertainFailure(r.status)) {
      // The server may or may not have started buying — never claim "nothing bought" now.
      setDialogOpen(false);
      setConfirmError(r.error);
      await recheck();
      return;
    }
    // A definite refusal (4xx): shown word-for-word; the dialog stays open.
    setConfirmError(r.error);
    setConfirmState('idle');
  };

  // ── render ──
  if (resumeLoading) return <LoadingBlock label="Loading campaign…" />;
  if (resumeError) return <ErrorPanel message={`Couldn't load this campaign: ${resumeError}`} onRetry={() => void loadResume()} />;

  const s = preview?.summary;
  const over = s ? isOverBudget(s) : false;
  const skipped = s ? (s.invalid ?? 0) + (s.duplicates ?? 0) : 0;

  return (
    <div className="space-y-6" data-testid="vd-new">
      <div className="space-y-3">
        <Link href="/gifsy/voucher-dispersal" className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> All campaigns
        </Link>
        <h1 className="text-xl font-bold text-white">New voucher campaign</h1>
        <StepHeader step={step} />
        {!outcomeUnknown && <p className="text-xs text-white/60" data-testid="vd-nothing-spent">{NOTHING_SPENT}</p>}
      </div>

      {campaign && step !== 'details' && (
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-white/70 break-words">
          <span className="font-semibold text-white">{campaign.name}</span> · Programme: {campaign.programLabel || '—'} · Billed to:{' '}
          {billedToText(campaign, clients)} · Budget {formatRupees(campaign.budgetRupees)}
        </div>
      )}

      {/* ① Details */}
      {step === 'details' && (
        <section aria-labelledby="vd-step-heading" className="space-y-4">
          <h2 id="vd-step-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold text-white outline-none">1. Campaign details</h2>
          <form onSubmit={onCreate} noValidate className="grid gap-4 max-w-xl">
            <div>
              <label htmlFor="vd-name" className="block text-xs font-semibold text-white/70 mb-1">Campaign name</label>
              <input id="vd-name" className={inputCls} value={form.name} disabled={creating} maxLength={VD_NAME_MAX}
                aria-invalid={showErrors && !!errors.name} aria-describedby={showErrors && errors.name ? 'vd-name-err' : undefined}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <FieldError id="vd-name-err" msg={showErrors ? errors.name : undefined} />
            </div>
            <div>
              <label htmlFor="vd-client" className="block text-xs font-semibold text-white/70 mb-1">Bill to client (optional)</label>
              <select id="vd-client" className={inputCls} value={form.billedToClientId} disabled={creating || !clients}
                onChange={(e) => onPickClient(e.target.value)}>
                <option value="">— Not billed to a client —</option>
                {(clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {clientsError && (
                <p className="text-xs text-amber-300 mt-1" role="alert">
                  Couldn&apos;t load the client list ({clientsError}). You can still create the campaign without billing it to a client.{' '}
                  <button type="button" className="underline" onClick={() => void loadClients()}>Try again</button>
                </p>
              )}
            </div>
            <div>
              <label htmlFor="vd-program" className="block text-xs font-semibold text-white/70 mb-1">Programme name shown in the WhatsApp message</label>
              <input id="vd-program" className={inputCls} value={form.programLabel} disabled={creating} placeholder="e.g. Bajaj Loyalty" maxLength={VD_PROGRAM_LABEL_MAX}
                aria-invalid={showErrors && !!errors.programLabel}
                aria-describedby={`vd-program-help${showErrors && errors.programLabel ? ' vd-program-err' : ''}`}
                onChange={(e) => { setLabelTouched(true); setForm({ ...form, programLabel: e.target.value }); }} />
              <p id="vd-program-help" className="text-[11px] text-white/40 mt-1">People see this name in the voucher message.</p>
              <FieldError id="vd-program-err" msg={showErrors ? errors.programLabel : undefined} />
            </div>
            <div>
              <label htmlFor="vd-budget" className="block text-xs font-semibold text-white/70 mb-1">Budget (₹)</label>
              <input id="vd-budget" className={inputCls} inputMode="decimal" value={form.budgetRupees} disabled={creating}
                aria-invalid={showErrors && !!errors.budgetRupees}
                aria-describedby={`vd-budget-help${rupeeEcho(form.budgetRupees) ? ' vd-budget-echo' : ''}${showErrors && errors.budgetRupees ? ' vd-budget-err' : ''}`}
                onChange={(e) => setForm({ ...form, budgetRupees: e.target.value })} />
              {rupeeEcho(form.budgetRupees) && (
                <p id="vd-budget-echo" data-testid="vd-budget-echo" className="text-xs text-white/70 mt-1">{rupeeEcho(form.budgetRupees)}</p>
              )}
              <p id="vd-budget-help" className="text-[11px] text-white/40 mt-1">Whole rupees. The purchase is blocked if the valid rows add up to more than this.</p>
              <FieldError id="vd-budget-err" msg={showErrors ? errors.budgetRupees : undefined} />
            </div>
            <div>
              <label htmlFor="vd-note" className="block text-xs font-semibold text-white/70 mb-1">Note (optional, internal)</label>
              <textarea id="vd-note" rows={2} className={inputCls} value={form.note} disabled={creating} maxLength={VD_NOTE_MAX}
                aria-invalid={showErrors && !!errors.note} aria-describedby={showErrors && errors.note ? 'vd-note-err' : undefined}
                onChange={(e) => setForm({ ...form, note: e.target.value })} />
              <FieldError id="vd-note-err" msg={showErrors ? errors.note : undefined} />
            </div>
            {createError && <ErrorPanel message={createError} testId="vd-create-error" />}
            <div>
              <button type="submit" disabled={creating} aria-busy={creating} data-testid="vd-create"
                className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {creating && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                {creating ? 'Creating…' : 'Create campaign'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* ② Upload */}
      {step === 'upload' && campaign && (
        <section aria-labelledby="vd-step-heading" className="space-y-4">
          <h2 id="vd-step-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold text-white outline-none">2. Upload the list</h2>
          {campaign.status === 'PREVIEWED' && !preview && (
            <p className="text-xs text-sky-300">This campaign was previewed earlier but not confirmed. Upload the file again to see the preview and buy.</p>
          )}
          <div className="flex flex-wrap items-start gap-3">
            <TemplateDownloadButton />
            <div className="flex-1 min-w-[16rem]"><BrandsHelp brands={brands} error={brandsError} onRetry={() => void loadBrands()} /></div>
          </div>
          <div
            data-testid="vd-dropzone"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!uploading) pickFile(e.dataTransfer.files?.[0] ?? null); }}
            className={`rounded-xl border-2 border-dashed px-4 py-8 text-center focus-within:ring-2 focus-within:ring-sky-400 focus-within:ring-offset-2 focus-within:ring-offset-gray-950 ${dragOver ? 'border-sky-400 bg-sky-500/10' : 'border-white/15 bg-white/5'}`}
          >
            <FileSpreadsheet className="w-8 h-8 mx-auto text-white/40" aria-hidden="true" />
            <p className="text-sm text-white/70 mt-2">Drag the filled-in template here, or</p>
            <label htmlFor="vd-file" className="mt-2 inline-block cursor-pointer rounded-lg border border-white/20 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/10">
              Choose file
            </label>
            <input id="vd-file" type="file" accept={ACCEPT} className="sr-only" disabled={uploading}
              onChange={(e) => {
                pickFile(e.target.files?.[0] ?? null);
                e.target.value = ''; // so picking the same (fixed) file again still triggers a change
              }} />
            <p className="text-xs text-white/60 mt-2" aria-live="polite" data-testid="vd-file-name">
              {file ? `Selected: ${file.name}` : 'No file selected'}
            </p>
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
              <button type="button" onClick={() => setStep('preview')} disabled={uploading}
                className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-60">
                Back to the last preview
              </button>
            )}
          </div>
        </section>
      )}

      {/* ③ Preview + buy */}
      {step === 'preview' && preview && s && (
        <section aria-labelledby="vd-step-heading" className="space-y-4">
          <h2 id="vd-step-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold text-white outline-none">3. Check the preview, then buy</h2>
          <div data-testid="vd-summary" className={`rounded-xl border px-4 py-3 ${block.blocked ? 'border-red-500/40 bg-red-500/10' : 'border-white/10 bg-white/5'}`}>
            <dl className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-sm">
              <div><dt className="text-[11px] uppercase text-white/50">Rows</dt><dd className="font-bold text-white">{formatCount(s.total)}</dd></div>
              <div><dt className="text-[11px] uppercase text-white/50">Valid</dt><dd className="font-bold text-emerald-300" data-testid="vd-sum-valid">{formatCount(s.valid)}</dd></div>
              <div><dt className="text-[11px] uppercase text-white/50">Invalid</dt><dd className={`font-bold ${(s.invalid ?? 0) > 0 ? 'text-red-300' : 'text-white'}`} data-testid="vd-sum-invalid">{formatCount(s.invalid)}</dd></div>
              <div><dt className="text-[11px] uppercase text-white/50">Duplicates</dt><dd className={`font-bold ${(s.duplicates ?? 0) > 0 ? 'text-amber-300' : 'text-white'}`} data-testid="vd-sum-dupes">{formatCount(s.duplicates)}</dd></div>
              <div><dt className="text-[11px] uppercase text-white/50">Warnings</dt><dd className={`font-bold ${(s.warningCount ?? 0) > 0 ? 'text-amber-300' : 'text-white'}`} data-testid="vd-sum-warncount">{formatCount(s.warningCount)}</dd></div>
              <div className="col-span-2 sm:col-span-1">
                <dt className="text-[11px] uppercase text-white/50">Total vs budget</dt>
                <dd className={`font-bold break-words ${over ? 'text-red-300' : 'text-white'}`} data-testid="vd-sum-total">
                  {formatRupees(s.totalRupees)} / {formatRupees(s.budgetRupees)}
                </dd>
              </div>
            </dl>
            {s.perBrand.length > 0 && (
              <p className="text-xs text-white/60 mt-2 break-words">
                By brand: {s.perBrand.map((b) => `${b.brand} ${formatCount(b.count)}${b.rupees !== null ? ` (${formatRupees(b.rupees)})` : ''}`).join(' · ')}
              </p>
            )}
            {s.warningCount !== null && s.warningCount > 0 && (
              <p className="text-xs text-amber-200 mt-2" data-testid="vd-sum-warnings">
                {plural(s.warningCount, 'valid row')} {s.warningCount === 1 ? 'is a phone that' : 'are phones that'} already got a voucher in another campaign in the last 30 days — see the note on each row. This does not block buying.
              </p>
            )}
            {s.skippedNote && <p className="text-xs text-white/70 mt-2" data-testid="vd-sum-skipped">{s.skippedNote}.</p>}
            {s.hiddenNote && <p className="text-xs text-amber-200 mt-2" data-testid="vd-sum-hidden">{s.hiddenNote}.</p>}
            {skipped > 0 && (
              <p className="text-xs text-amber-200 mt-2">
                {plural(s.invalid ?? 0, 'invalid row')} and {plural(s.duplicates ?? 0, 'duplicate row')} will NOT get a voucher. Each one is listed below with the reason.
              </p>
            )}
            {block.blocked && <p role="alert" id="vd-block-reason" data-testid="vd-block-reason" className="text-sm font-semibold text-red-200 mt-2">{block.reason}</p>}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="vd-filter" className="block text-xs font-semibold text-white/70 mb-1">Show rows</label>
              <select id="vd-filter" className={inputCls} value={filter} onChange={(e) => { setFilter(e.target.value as 'ALL' | RowStatus); setPage(1); }}>
                <option value="ALL">All ({preview.rows.length})</option>
                {[...statusCounts.entries()].map(([st, v]) => <option key={st} value={st}>{v.label} ({v.n})</option>)}
              </select>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="min-w-full text-sm" data-testid="vd-preview-table">
              <caption className="sr-only">Uploaded rows and their check result</caption>
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
                      {r.warning && (
                        <p className="text-xs text-amber-200 mt-1 break-words" data-testid={`vd-prow-warning-${r.rowNumber ?? `i${i}`}`}>
                          <span className="font-semibold">Note:</span> {r.warning}
                        </p>
                      )}
                      {!r.invalidReason && (r.status === 'INVALID' || r.status === 'DUPLICATE') && (
                        <p className="text-xs text-amber-200 mt-1">
                          {r.status === 'DUPLICATE' ? 'Same phone appears earlier in the file.' : 'The server gave no reason.'}
                        </p>
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

          {/* Buy */}
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 space-y-3">
            {outcomeUnknown ? (
              <div role="alert" data-testid="vd-outcome-unknown" className="space-y-2 text-sm text-amber-100">
                <p className="font-semibold">{UNKNOWN_OUTCOME}</p>
                {confirmError && <p className="text-xs text-amber-200 break-words">Server reply: {confirmError}</p>}
                {confirmState === 'checking' ? (
                  <p className="inline-flex items-center gap-2 text-xs"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Checking the campaign…</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => void recheck()}
                      className="rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/10">
                      Check again
                    </button>
                    <Link href={`/gifsy/voucher-dispersal/${encodeURIComponent(campaign?.id ?? '')}`}
                      className="rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10">
                      Open the campaign report
                    </Link>
                  </div>
                )}
              </div>
            ) : confirmState === 'clear' ? (
              <p role="status" data-testid="vd-outcome-clear" className="text-sm text-sky-200 break-words">
                Checked: this campaign is still not confirmed, so nothing was bought. You can try again.
                {confirmError ? ` (Last error: ${confirmError})` : ''}
              </p>
            ) : (
              <p className="text-sm text-white/80">
                Buying spends money: one Hubble voucher per valid row, each sent on WhatsApp.
                {skipped > 0 ? ` ${plural(skipped, 'invalid / duplicate row')} ${skipped === 1 ? 'is' : 'are'} skipped.` : ''}
              </p>
            )}
            {confirmError && !dialogOpen && confirmState === 'idle' && (
              <ErrorPanel message={confirmError} testId="vd-confirm-error" />
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => { setFile(null); setConfirmError(null); setConfirmState('idle'); setStep('upload'); }}
                disabled={confirming || confirmState === 'checking'}
                className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-60">
                {confirmError && confirmState === 'idle' ? 'Upload the file again' : 'Upload a different file'}
              </button>
              <button type="button" onClick={() => { setConfirmError(null); setDialogOpen(true); }}
                disabled={block.blocked || confirming || outcomeUnknown}
                aria-describedby={block.blocked ? 'vd-block-reason' : undefined}
                data-testid="vd-buy-send"
                className="rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                Buy &amp; send vouchers
              </button>
            </div>
          </div>

          <ConfirmDialog
            open={dialogOpen}
            title={confirmDialogTitle(s)}
            description="Nothing can be undone once vouchers are bought."
            confirmLabel="Buy & send"
            busyLabel="Buying…"
            cancelLabel="Cancel"
            busy={confirming}
            error={confirmError}
            onConfirm={() => void onConfirm()}
            onClose={() => setDialogOpen(false)}
          />
        </section>
      )}
    </div>
  );
}

export default function NewVoucherCampaignPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading…" />}>
      <NewCampaignFlow />
    </Suspense>
  );
}
