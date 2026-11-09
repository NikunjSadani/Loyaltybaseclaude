'use client';

/**
 * /admin/sales-import — upload a DMS invoice-line file + list of imports (SALES-IMPORT-PIPELINE-PLAN §11 F-3).
 *
 * Upload = chunked (4 MiB parts, retried) via uploadInParts(); on success → the import's detail page, which polls
 * processing and shows the per-month preview. Leaving the page mid-upload asks first (beforeunload); a cancelled
 * or failed upload deletes its half-created import (best effort).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Copy, FileSpreadsheet, Info, RefreshCw, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { salesImportApi } from '@/lib/sales-import/api';
import { uploadInParts, validateSalesFile, UploadAbortedError } from '@/lib/sales-import/upload';
import {
  STATUS_CHIP, STATUS_LABEL, dateTimeLabel, formatBytes, formatCount,
} from '@/lib/sales-import/format';
import type { SalesImportSummary } from '@/lib/sales-import/types';

// ── Upload card ──────────────────────────────────────────────────────────────

function UploadCard() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false); // double-submit guard (state updates are async)
  const [fileName, setFileName] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const uploading = progress !== null;

  // Leaving mid-upload loses it → ask first.
  useEffect(() => {
    if (!uploading) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [uploading]);

  // Abort an in-flight upload if the component unmounts (in-app navigation).
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async (file: File) => {
    if (busyRef.current) return;
    const invalid = validateSalesFile(file);
    if (invalid) { setError(invalid); setFileName(file.name); return; }
    busyRef.current = true;
    setError(null);
    setFileName(file.name);
    setProgress(0);
    const ctl = new AbortController();
    abortRef.current = ctl;
    let createdId: string | null = null;
    try {
      const importId = await uploadInParts(file, {
        signal: ctl.signal,
        onCreated: (id) => { createdId = id; },
        onProgress: (p) => setProgress(p),
      });
      router.push(`/admin/sales-import/${importId}`);
    } catch (err) {
      // Best-effort clean-up of the half-uploaded import (never applied, so DELETE is allowed).
      if (createdId) void salesImportApi.remove(createdId);
      setError(err instanceof UploadAbortedError
        ? 'Upload cancelled.'
        : `${err instanceof Error ? err.message : 'Upload failed'}. Nothing was imported — try again.`);
      setProgress(null);
    } finally {
      busyRef.current = false;
      abortRef.current = null;
    }
  }, [router]);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) void start(f);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (uploading) return;
    const f = e.dataTransfer.files?.[0];
    if (f) void start(f);
  }

  const pct = progress === null ? 0 : Math.round(progress * 100);

  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-blue-50"><Upload className="w-4 h-4 text-blue-600" /></div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Upload a sales file</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            The distributor (DMS) invoice-line export, as .xlsx or .csv, up to 600 MB. Big files take a few minutes.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-xs text-blue-800">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          The file must have <strong>one row per invoice line</strong> under a single header row (outlet code, invoice
          date, amount and/or cases, product columns). Pivot or summary sheets (one column per month or brand), several
          sheets merged, or subtotal rows are <strong>not supported</strong> — keep using the manual achievement upload
          for those.
        </span>
      </div>

      <div
        role="button"
        tabIndex={uploading ? -1 : 0}
        aria-disabled={uploading}
        aria-label="Choose a sales file to upload"
        onClick={() => { if (!uploading) inputRef.current?.click(); }}
        onKeyDown={(e) => { if (!uploading && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        data-testid="sales-import-dropzone"
        className={`border-2 border-dashed rounded-xl px-8 py-8 text-center transition-colors ${
          uploading ? 'cursor-not-allowed opacity-70 border-gray-200'
            : dragOver ? 'cursor-pointer border-[var(--brand-primary)] bg-gray-50'
              : 'cursor-pointer border-gray-200 hover:border-[var(--brand-primary)]'
        }`}
      >
        <FileSpreadsheet className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        {fileName
          ? <p className="text-sm font-medium text-gray-700">{fileName}</p>
          : <p className="text-sm text-gray-500">Drop the file here or <span className="text-[var(--brand-primary)] font-medium underline">browse</span></p>}
        <p className="text-xs text-gray-400 mt-1">.xlsx or .csv · max 600 MB</p>
        <input ref={inputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={onPick} data-testid="sales-import-file-input" />
      </div>

      {uploading && (
        <div className="space-y-2" data-testid="sales-import-upload-progress">
          <div className="flex items-center justify-between text-xs text-gray-600">
            <span>Uploading… {pct}% — keep this tab open until the upload finishes.</span>
            <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
              <X className="w-3.5 h-3.5" /> Cancel
            </Button>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
            <div className="h-full bg-[var(--brand-primary)] transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600 flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </p>
      )}
    </section>
  );
}

// ── Imports list ─────────────────────────────────────────────────────────────

function ImportsList() {
  const [items, setItems] = useState<SalesImportSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    salesImportApi.list(null).then((r) => {
      if (cancelled) return;
      if (r.success) { setItems(r.data.items); setCursor(r.data.nextCursor); }
      else setError(r.error);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [attempt]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const r = await salesImportApi.list(cursor);
    if (r.success) { setItems((prev) => [...prev, ...r.data.items]); setCursor(r.data.nextCursor); }
    else setError(r.error);
    setLoadingMore(false);
  }

  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">Imports</h2>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((a) => a + 1)} aria-label="Refresh imports">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {loading ? (
        <p className="px-6 py-6 text-sm text-gray-400">Loading imports…</p>
      ) : error && items.length === 0 ? (
        <div role="alert" className="px-6 py-6 text-sm text-red-600 flex items-center gap-3">
          <span>Couldn&apos;t load imports: {error}</span>
          <Button size="sm" variant="outline" onClick={() => setAttempt((a) => a + 1)}>Retry</Button>
        </div>
      ) : items.length === 0 ? (
        <p className="px-6 py-6 text-sm text-gray-500">No files uploaded yet. Upload the first sales file above.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-2 font-medium">File</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium text-right">Size</th>
                <th className="px-4 py-2 font-medium text-right">Rows</th>
                <th className="px-4 py-2 font-medium">Uploaded by</th>
                <th className="px-4 py-2 font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link href={`/admin/sales-import/${it.id}`} className="font-medium text-[var(--brand-primary)] hover:underline break-all">
                      {it.originalFilename}
                    </Link>
                    {it.duplicateOfId && (
                      <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200" title="The same file was uploaded before">
                        <Copy className="w-3 h-3" /> Repeat file
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_CHIP[it.status]}`}>
                      {STATUS_LABEL[it.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right text-gray-600">{formatBytes(it.sizeBytes)}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{it.rowsRead ? formatCount(it.rowsRead) : '—'}</td>
                  <td className="px-4 py-2 text-gray-600">{it.uploadedBy}</td>
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{dateTimeLabel(it.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && <p role="alert" className="px-6 py-2 text-xs text-red-600">{error}</p>}
          {cursor && (
            <div className="px-6 py-3">
              <Button size="sm" variant="outline" onClick={loadMore} loading={loadingMore}>Load more</Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function SalesImportPage() {
  return (
    <div className="space-y-5 pb-10">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Sales Import</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Upload the distributor sales file, check the monthly preview, then apply the months you want. Set up the column
          mapping and KPIs once under <Link href="/admin/sales-import/settings" className="text-[var(--brand-primary)] underline">Settings</Link>.
        </p>
      </div>
      <UploadCard />
      <ImportsList />
    </div>
  );
}
