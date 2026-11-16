'use client';

/* ─── Voucher Dispersal — new campaign (/gifsy/voucher-dispersal/new[?campaign=<id>]) ─────
   One page, four steps: ① details → create  ② upload file  ③ preview  ④ "Buy & send vouchers" → confirm dialog
   (sends the previewed valid count + ₹ total; the server refuses verbatim if its preview differs).
   NOTHING is bought before ④ succeeds — the copy says so at every step. A DRAFT / PREVIEWED
   campaign can be resumed with ?campaign=<id> (the preview is re-run by uploading the file again).
──────────────────────────────────────────────────────────────────────────────────────── */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import {
  ROW_STATUS_LABEL, ROW_STATUS_TONE, confirmBlock, confirmDialogTitle, confirmPayload, defaultProgramLabel,
  fetchBillableClients, formatRupees, isSetupCampaign, validateCreateForm, vdApi,
  type CreateForm, type RowStatus, type VdBrand, type VdCampaign, type VdClient, type VdPreview,
} from '@/lib/voucher-dispersal';
import { ConfirmDialog, ErrorPanel, LoadingBlock, StatusChip, TemplateDownloadButton } from '@/components/voucher-dispersal/vd-ui';

type Step = 'details' | 'upload' | 'preview' | 'confirm';
const STEPS: { key: Step; label: string }[] = [
  { key: 'details', label: 'Details' },
  { key: 'upload', label: 'Upload file' },
  { key: 'preview', label: 'Preview' },
  { key: 'confirm', label: 'Confirm' },
];

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.xlsx,.xls,.csv';
const PAGE_SIZE = 50;

const NOTHING_SPENT = 'Nothing has been bought or sent yet — vouchers are only bought after you confirm.';

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
          <li key={b.key}>
            <span className="font-mono text-white">{b.key}</span> — {b.label}:{' '}
            {b.denominations && b.denominations.length > 0
              ? `only ${b.denominations.map((d) => formatRupees(d)).join(', ')}`
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
  const [resumeLoading, setResumeLoading] = useState(!!resumeId);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const loadResume = useCallback(async () => {
    if (!resumeId) return;
    setResumeLoading(true);
    setResumeError(null);
    const r = await vdApi.getCampaign(resumeId);
    if (!r.ok) { setResumeError(r.error); setResumeLoading(false); return; }
    const c = r.data.campaign;
    if (!isSetupCampaign(c.status)) {
      router.replace(`/gifsy/voucher-dispersal/${encodeURIComponent(c.id)}`);
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
      budgetRupees: Number(form.budgetRupees),
    });
    inFlight.current = false;
    setCreating(false);
    if (!r.ok) { setCreateError(r.error); return; }
    setCampaign(r.data);
    setStep('upload');
  };

  // ── ② upload ──
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pickFile = (f: File | null) => {
    setUploadError(null);
    if (!f) { setFile(null); setFileError(null); return; }
    if (!/\.(xlsx|xls|csv)$/i.test(f.name)) { setFile(null); setFileError('Choose an Excel (.xlsx / .xls) or .csv file.'); return; }
    if (f.size > MAX_FILE_BYTES) { setFile(null); setFileError('That file is over 10 MB. Split the list into smaller files.'); return; }
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
    if (r.data.campaign.id) setCampaign(r.data.campaign);
    setFilter('ALL');
    setPage(1);
    setConfirmError(null);
    setStep('preview');
  };

  // ── ③ preview ──
  const [filter, setFilter] = useState<'ALL' | RowStatus>('ALL');
  const [page, setPage] = useState(1);
  const filteredRows = useMemo(
    () => (preview ? (filter === 'ALL' ? preview.rows : preview.rows.filter((r) => r.status === filter)) : []),
    [preview, filter],
  );
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageRows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const statusCounts = useMemo(() => {
    const m = new Map<RowStatus, number>();
    for (const r of preview?.rows ?? []) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return m;
  }, [preview]);

  // ── ④ confirm ──
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const block = preview ? confirmBlock(preview.summary) : ({ blocked: true, reason: 'Upload a file first.' } as const);

  const onConfirm = async () => {
    if (!campaign || !preview || block.blocked || inFlight.current) return;
    inFlight.current = true;
    setConfirming(true);
    setConfirmError(null);
    // Send the exact numbers shown on the preview — the server refuses if its own preview differs.
    const r = await vdApi.confirm(campaign.id, confirmPayload(preview.summary));
    inFlight.current = false;
    setConfirming(false);
    if (!r.ok) { setConfirmError(r.error); return; }
    setDialogOpen(false);
    router.push(`/gifsy/voucher-dispersal/${encodeURIComponent(campaign.id)}`);
  };

  // ── render ──
  if (resumeLoading) return <LoadingBlock label="Loading campaign…" />;
  if (resumeError) return <ErrorPanel message={`Couldn't load this campaign: ${resumeError}`} onRetry={() => void loadResume()} />;

  const s = preview?.summary;

  return (
    <div className="space-y-6" data-testid="vd-new">
      <div className="space-y-3">
        <Link href="/gifsy/voucher-dispersal" className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> All campaigns
        </Link>
        <h1 className="text-xl font-bold text-white">New voucher campaign</h1>
        <StepHeader step={step} />
        <p className="text-xs text-white/60" data-testid="vd-nothing-spent">{NOTHING_SPENT}</p>
      </div>

      {campaign && step !== 'details' && (
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-white/70 break-words">
          <span className="font-semibold text-white">{campaign.name}</span> · Programme: {campaign.programLabel || '—'} · Billed to:{' '}
          {campaign.billedToClientName ?? (campaign.billedToClientId ? clients?.find((c) => c.id === campaign.billedToClientId)?.name ?? campaign.billedToClientId : '—')}
          {' '}· Budget {formatRupees(campaign.budgetRupees)}
        </div>
      )}

      {/* ① Details */}
      {step === 'details' && (
        <section aria-labelledby="vd-step-heading" className="space-y-4">
          <h2 id="vd-step-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold text-white outline-none">1. Campaign details</h2>
          <form onSubmit={onCreate} noValidate className="grid gap-4 max-w-xl">
            <div>
              <label htmlFor="vd-name" className="block text-xs font-semibold text-white/70 mb-1">Campaign name</label>
              <input id="vd-name" className={inputCls} value={form.name} disabled={creating}
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
              <input id="vd-program" className={inputCls} value={form.programLabel} disabled={creating} placeholder="e.g. Bajaj Loyalty"
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
                aria-describedby={`vd-budget-help${showErrors && errors.budgetRupees ? ' vd-budget-err' : ''}`}
                onChange={(e) => setForm({ ...form, budgetRupees: e.target.value.replace(/[^\d.]/g, '') })} />
              <p id="vd-budget-help" className="text-[11px] text-white/40 mt-1">The upload is blocked if the valid rows add up to more than this.</p>
              <FieldError id="vd-budget-err" msg={showErrors ? errors.budgetRupees : undefined} />
            </div>
            <div>
              <label htmlFor="vd-note" className="block text-xs font-semibold text-white/70 mb-1">Note (optional, internal)</label>
              <textarea id="vd-note" rows={2} className={inputCls} value={form.note} disabled={creating}
                onChange={(e) => setForm({ ...form, note: e.target.value })} />
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
            <p className="text-xs text-sky-300">This campaign was previewed earlier but not confirmed. Upload the file again to see the preview and confirm.</p>
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
            className={`rounded-xl border-2 border-dashed px-4 py-8 text-center ${dragOver ? 'border-sky-400 bg-sky-500/10' : 'border-white/15 bg-white/5'}`}
          >
            <FileSpreadsheet className="w-8 h-8 mx-auto text-white/40" aria-hidden="true" />
            <p className="text-sm text-white/70 mt-2">Drag the filled-in template here, or</p>
            <label htmlFor="vd-file" className="mt-2 inline-block cursor-pointer rounded-lg border border-white/20 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/10">
              Choose file
            </label>
            <input id="vd-file" ref={fileInputRef} type="file" accept={ACCEPT} className="sr-only" disabled={uploading}
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-white/60 mt-2" aria-live="polite" data-testid="vd-file-name">
              {file ? `Selected: ${file.name}` : 'No file selected'}
            </p>
            {fileError && <p role="alert" className="text-xs text-red-300 mt-1">{fileError}</p>}
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

      {/* ③ Preview */}
      {step === 'preview' && preview && s && (
        <section aria-labelledby="vd-step-heading" className="space-y-4">
          <h2 id="vd-step-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold text-white outline-none">3. Check the preview</h2>
          <div data-testid="vd-summary" className={`rounded-xl border px-4 py-3 ${block.blocked ? 'border-red-500/40 bg-red-500/10' : 'border-white/10 bg-white/5'}`}>
            <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
              <div><dt className="text-[11px] uppercase text-white/50">Rows</dt><dd className="font-bold text-white">{s.total}</dd></div>
              <div><dt className="text-[11px] uppercase text-white/50">Valid</dt><dd className="font-bold text-emerald-300" data-testid="vd-sum-valid">{s.valid}</dd></div>
              <div><dt className="text-[11px] uppercase text-white/50">Invalid</dt><dd className={`font-bold ${s.invalid > 0 ? 'text-red-300' : 'text-white'}`} data-testid="vd-sum-invalid">{s.invalid}</dd></div>
              <div><dt className="text-[11px] uppercase text-white/50">Duplicates</dt><dd className={`font-bold ${s.duplicates > 0 ? 'text-amber-300' : 'text-white'}`} data-testid="vd-sum-dupes">{s.duplicates}</dd></div>
              <div>
                <dt className="text-[11px] uppercase text-white/50">Total vs budget</dt>
                <dd className={`font-bold ${s.overBudget ? 'text-red-300' : 'text-white'}`} data-testid="vd-sum-total">
                  {formatRupees(s.totalRupees)} / {formatRupees(s.budgetRupees)}
                </dd>
              </div>
            </dl>
            {s.perBrand.length > 0 && (
              <p className="text-xs text-white/60 mt-2 break-words">
                By brand: {s.perBrand.map((b) => `${b.brand} ${b.count}${b.rupees !== null ? ` (${formatRupees(b.rupees)})` : ''}`).join(' · ')}
              </p>
            )}
            {(s.invalid > 0 || s.duplicates > 0) && (
              <p className="text-xs text-amber-200 mt-2">
                {s.invalid} invalid and {s.duplicates} duplicate rows will NOT get a voucher. Each one is listed below with the reason.
              </p>
            )}
            {block.blocked && <p role="alert" data-testid="vd-block-reason" className="text-sm font-semibold text-red-200 mt-2">{block.reason}</p>}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="vd-filter" className="block text-xs font-semibold text-white/70 mb-1">Show rows</label>
              <select id="vd-filter" className={inputCls} value={filter} onChange={(e) => { setFilter(e.target.value as 'ALL' | RowStatus); setPage(1); }}>
                <option value="ALL">All ({preview.rows.length})</option>
                {[...statusCounts.entries()].map(([st, n]) => <option key={st} value={st}>{ROW_STATUS_LABEL[st]} ({n})</option>)}
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
                ) : pageRows.map((r) => (
                  <tr key={`${r.rowNumber}-${r.phone}`} data-testid={`vd-prow-${r.rowNumber}`}>
                    <td className="px-3 py-2 text-white/60">{r.rowNumber}</td>
                    <td className="px-3 py-2 font-mono text-white">{r.phone || '—'}</td>
                    <td className="px-3 py-2 text-white">{r.name || '—'}</td>
                    <td className="px-3 py-2 text-white">{formatRupees(r.amount)}</td>
                    <td className="px-3 py-2 text-white">{r.brand || '—'}</td>
                    <td className="px-3 py-2">
                      <StatusChip label={ROW_STATUS_LABEL[r.status]} tone={ROW_STATUS_TONE[r.status]} />
                      {r.invalidReason && <p className="text-xs text-red-200 mt-1 break-words">{r.invalidReason}</p>}
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

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { setFile(null); setStep('upload'); }}
              className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 hover:bg-white/10">
              Upload a different file
            </button>
            <button type="button" onClick={() => setStep('confirm')} disabled={block.blocked} data-testid="vd-to-confirm"
              aria-describedby={block.blocked ? 'vd-block-reason' : undefined}
              className="rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Continue to confirm
            </button>
          </div>
        </section>
      )}

      {/* ④ Confirm */}
      {step === 'confirm' && preview && s && (
        <section aria-labelledby="vd-step-heading" className="space-y-4 max-w-xl">
          <h2 id="vd-step-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold text-white outline-none">4. Buy and send</h2>
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 space-y-1">
            <p>This buys <strong>{s.valid}</strong> Hubble vouchers worth <strong>{formatRupees(s.totalRupees)}</strong> and sends each one on WhatsApp. Bought vouchers cannot be taken back.</p>
            {(s.invalid > 0 || s.duplicates > 0) && <p>{s.invalid + s.duplicates} invalid / duplicate rows are skipped.</p>}
            <p>{NOTHING_SPENT}</p>
          </div>
          {block.blocked && <p role="alert" className="text-sm font-semibold text-red-200">{block.reason}</p>}
          {confirmError && !dialogOpen && (
            <div className="space-y-2">
              <ErrorPanel message={confirmError} testId="vd-confirm-error" />
              <button type="button" onClick={() => { setFile(null); setConfirmError(null); setStep('upload'); }}
                className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 hover:bg-white/10">
                Upload the file again
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setStep('preview')} disabled={confirming}
              className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-60">
              Back to preview
            </button>
            <button type="button" onClick={() => { setConfirmError(null); setDialogOpen(true); }} disabled={block.blocked || confirming}
              data-testid="vd-buy-send"
              className="rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Buy &amp; send vouchers
            </button>
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
