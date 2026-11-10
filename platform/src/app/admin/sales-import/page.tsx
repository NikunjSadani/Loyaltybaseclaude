'use client';

/**
 * /admin/sales-import — upload a DMS invoice-line file + list of imports (SALES-IMPORT-PIPELINE-PLAN §11 F-3).
 *
 * Upload = chunked (4 MiB parts, retried) via the tab-level upload store (lib/sales-import/upload-store.ts): it
 * keeps running while the user moves to other portal pages (links ask first) and stops only when the tab closes
 * (beforeunload asks first). A failed upload keeps its import + confirmed parts and offers "Resume upload"; only an
 * explicit Cancel / Discard deletes the half-created import, and only after confirming it is still UPLOADING.
 * On success → the import's detail page, which polls processing and shows the per-month preview.
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Copy, FileSpreadsheet, Info, RefreshCw, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { salesImportApi } from '@/lib/sales-import/api';
import { validateSalesFile } from '@/lib/sales-import/upload';
import {
  cancelUpload, discardUpload, getUploadState, resetUpload, resumeUpload, startUpload, subscribeUpload,
} from '@/lib/sales-import/upload-store';
import { usePermissions } from '@/lib/use-permissions';
import {
  STATUS_CHIP, STATUS_LABEL, dateTimeLabel, formatBytes, formatCount,
} from '@/lib/sales-import/format';
import type { SalesImportSummary } from '@/lib/sales-import/types';

// ── Upload card ──────────────────────────────────────────────────────────────

const LEAVE_MID_UPLOAD =
  'A file is still uploading. It keeps uploading in the background while this browser tab stays open, and you can ' +
  'come back to Sales Import to see it. Closing or reloading the tab stops it.\n\nLeave this page?';

/**
 * While an upload runs, in-app link clicks ask first. Capture phase on `document` runs before React / Next's Link
 * handler, so a "Stay" stops the navigation entirely. (Tab close / reload is covered by the store's beforeunload.)
 */
function useConfirmLeaveWhile(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!window.confirm(LEAVE_MID_UPLOAD)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [active]);
}

function UploadCard({ canUpload }: { canUpload: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const up = useSyncExternalStore(subscribeUpload, getUploadState, getUploadState);
  const [localError, setLocalError] = useState<{ fileName: string; text: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Navigate to the import only when it finished while this page was open; a finish that happened while the user
  // was elsewhere shows a banner instead of yanking them away on return.
  const sawUploadingRef = useRef(false);

  const uploading = up.phase === 'uploading';
  useConfirmLeaveWhile(uploading);

  useEffect(() => {
    if (up.phase === 'uploading') sawUploadingRef.current = true;
    if (up.phase === 'done' && up.importId && sawUploadingRef.current) {
      const id = up.importId;
      sawUploadingRef.current = false;
      resetUpload();
      router.push(`/admin/sales-import/${id}`);
    }
  }, [up.phase, up.importId, router]);

  const start = useCallback((file: File) => {
    // Double-submit guard; a failed upload must be resumed or discarded before a new file is picked.
    const phase = getUploadState().phase;
    if (phase === 'uploading' || phase === 'failed') return;
    const invalid = validateSalesFile(file);
    if (invalid) { setLocalError({ fileName: file.name, text: invalid }); return; }
    setLocalError(null);
    startUpload(file);
  }, []);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) start(f);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (pickDisabled) return;
    const f = e.dataTransfer.files?.[0];
    if (f) start(f);
  }

  const pct = Math.round(up.progress * 100);
  const failed = up.phase === 'failed';
  const fileName = localError?.fileName ?? up.fileName;
  const pickDisabled = uploading || failed || !canUpload;

  if (!canUpload) {
    return (
      <section className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-5" data-testid="sales-import-upload-denied">
        <p className="text-sm text-gray-600">You can view sales imports, but you don&apos;t have permission to upload sales files.</p>
      </section>
    );
  }

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

      {up.phase === 'done' && up.importId && (
        <div role="status" className="flex flex-wrap items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-800" data-testid="sales-import-upload-finished">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{up.fileName ?? 'The file'} finished uploading.</span>
          <Link href={`/admin/sales-import/${up.importId}`} onClick={() => resetUpload()} className="underline font-medium">Open the import</Link>
          <Button size="sm" variant="ghost" onClick={() => resetUpload()} aria-label="Dismiss"><X className="w-3.5 h-3.5" /></Button>
        </div>
      )}

      <div
        role="button"
        tabIndex={pickDisabled ? -1 : 0}
        aria-disabled={pickDisabled}
        aria-label="Choose a sales file to upload"
        onClick={() => { if (!pickDisabled) inputRef.current?.click(); }}
        onKeyDown={(e) => { if (!pickDisabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); if (!pickDisabled) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        data-testid="sales-import-dropzone"
        className={`border-2 border-dashed rounded-xl px-8 py-8 text-center transition-colors ${
          pickDisabled ? 'cursor-not-allowed opacity-70 border-gray-200'
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
          <div className="flex items-center justify-between gap-3 text-xs text-gray-600">
            <span>
              Uploading… {pct}%. Keep this browser tab open until it finishes — you can use other portal pages in the
              meantime, but closing or reloading the tab stops the upload.
            </span>
            <Button size="sm" variant="ghost" onClick={() => cancelUpload()} loading={up.busy}>
              <X className="w-3.5 h-3.5" /> Cancel
            </Button>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
            <div className="h-full bg-[var(--brand-primary)] transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {(localError || up.error) && (
        <div role="alert" className="text-sm text-red-600 space-y-1">
          {localError && <p className="flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> {localError.text}</p>}
          {up.error && <p className="flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> {up.error}</p>}
        </div>
      )}

      {failed && (
        <div className="space-y-2" data-testid="sales-import-upload-failed-actions">
          <div className="flex flex-wrap gap-2">
            {up.canResume && (
              <Button size="sm" variant="primary" onClick={() => resumeUpload()} disabled={up.busy}>
                <RefreshCw className="w-3.5 h-3.5" /> Resume upload ({pct}% sent)
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => { void discardUpload(); }} loading={up.busy}>
              {up.canResume ? 'Discard this upload' : 'Dismiss'}
            </Button>
          </div>
          {up.canResume && (
            <p className="text-xs text-gray-500">Resume or discard this upload before choosing another file.</p>
          )}
        </div>
      )}
    </section>
  );
}

// ── Imports list ─────────────────────────────────────────────────────────────

function ImportsList({ refreshKey }: { refreshKey: string }) {
  const [items, setItems] = useState<SalesImportSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const loadedOnceRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // A re-list triggered by an upload state change refreshes silently (no "Loading…" flash over the table).
    if (!loadedOnceRef.current) setLoading(true);
    setError(null);
    salesImportApi.list(null).then((r) => {
      if (cancelled) return;
      if (r.success) { setItems(r.data.items); setCursor(r.data.nextCursor); loadedOnceRef.current = true; }
      else setError(r.error);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [attempt, refreshKey]);

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
  const { ready, has } = usePermissions();
  // Re-list when an upload starts, finishes, fails or is cancelled (so a removed import disappears).
  const up = useSyncExternalStore(subscribeUpload, getUploadState, getUploadState);
  return (
    <div className="space-y-5 pb-10">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Sales Import</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Upload the distributor sales file, check the monthly preview, then apply the months you want. Set up the column
          mapping and KPIs once under <Link href="/admin/sales-import/settings" className="text-[var(--brand-primary)] underline">Settings</Link>.
        </p>
      </div>
      {ready && <UploadCard canUpload={has('targets:upload')} />}
      <ImportsList refreshKey={`${up.phase}:${up.importId ?? ''}`} />
    </div>
  );
}
