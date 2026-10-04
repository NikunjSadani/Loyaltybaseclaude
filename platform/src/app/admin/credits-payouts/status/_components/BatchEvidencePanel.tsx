'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Paperclip, UploadCloud, Trash2, FileText, X, Loader2 } from 'lucide-react';

/**
 * B1 — audit-evidence panel for a credit/payout batch.
 *
 * Bulk-upload the client's offline visibility-audit photos/PDFs against the BATCH (no per-file
 * tagging). Images show as thumbnails (click → lightbox); PDFs open in a new tab. Delete is
 * available only while the batch is PENDING_CONFIRM — once confirmed (invoices generated) the
 * evidence is add-only, preserving the audit trail.
 *
 * Mirrors the page's own conventions: plain fetch() to the /api proxy, light cards, brand accent.
 */

interface Attachment {
  id: string;
  batchId: string;
  outletCode: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedById: string;
  createdAt: string;
}

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PER_BATCH = 100;
const CHUNK = 5; // files per request — keeps each upload bounded

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function BatchEvidencePanel({
  batchId,
  canDelete,
}: {
  batchId: string;
  /** Delete allowed only while the batch is PENDING_CONFIRM (add-only after confirm). */
  canDelete: boolean;
}) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/credits/batches/${batchId}/attachments`);
      const json = await res.json().catch(() => null);
      if (res.ok && json?.data) {
        setItems(json.data.attachments ?? []);
        setLoadError(false);
      } else {
        // A real failure (403/500/proxy) must NOT masquerade as an empty batch.
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    }
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Close the lightbox on Escape (a11y).
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  async function handleFiles(fileList: FileList | null) {
    setError(null);
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);

    // Client-side pre-checks (the server re-validates by magic bytes + size regardless).
    for (const f of files) {
      if (!ALLOWED.has(f.type)) {
        setError(`"${f.name}" is not a JPG, PNG, WEBP, or PDF.`);
        return;
      }
      if (f.size > MAX_BYTES) {
        setError(`"${f.name}" exceeds 10 MB.`);
        return;
      }
    }
    const current = items?.length ?? 0;
    if (current + files.length > MAX_PER_BATCH) {
      setError(`This batch can hold at most ${MAX_PER_BATCH} files (it has ${current}).`);
      return;
    }

    setUploading(true);
    let uploaded = 0;
    try {
      // Upload in chunks so no single request carries too much.
      for (let i = 0; i < files.length; i += CHUNK) {
        const slice = files.slice(i, i + CHUNK);
        const fd = new FormData();
        slice.forEach((f) => fd.append('files', f));
        const res = await fetch(`/api/admin/credits/batches/${batchId}/attachments`, {
          method: 'POST',
          body: fd,
        });
        if (!res.ok) {
          const json = await res.json().catch(() => null);
          const reason = json?.error || json?.message || `request failed (${res.status})`;
          // Report how many landed before the failure so the operator doesn't blindly re-upload
          // (which would create duplicates of the files that already succeeded).
          throw new Error(
            uploaded > 0
              ? `${uploaded} of ${files.length} file(s) uploaded, then ${reason}. The rest were not uploaded — re-select only the remaining files.`
              : `Upload failed: ${reason}`,
          );
        }
        uploaded += slice.length;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
      await load();
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleDelete(att: Attachment) {
    if (!window.confirm(`Remove "${att.fileName}" from this batch?`)) return;
    setDeletingId(att.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/credits/batches/${batchId}/attachments/${att.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error || json?.message || `Delete failed (${res.status}).`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setDeletingId(null);
    }
  }

  const mediaUrl = (id: string) => `/api/admin/credits/attachments/${id}/media`;

  return (
    <div className="px-5 py-4 border-t border-gray-100 bg-white">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h4 className="flex items-center gap-2 text-xs font-semibold text-gray-700">
          <Paperclip className="w-3.5 h-3.5" />
          Audit evidence
          {items && items.length > 0 && (
            <span className="text-gray-400 font-normal">({items.length})</span>
          )}
        </h4>
        <label
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors
            ${uploading ? 'bg-gray-100 text-gray-400 cursor-wait' : 'bg-[var(--brand-primary)] text-white hover:opacity-90'}`}
        >
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
          {uploading ? 'Uploading…' : 'Upload files'}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            disabled={uploading}
            onChange={(e) => handleFiles(e.target.files)}
            className="hidden"
          />
        </label>
      </div>

      <p className="text-[11px] text-gray-400 mb-3">
        JPG, PNG, WEBP or PDF · up to 10&nbsp;MB each · the client&apos;s offline visibility-audit proof for this payout.
      </p>

      {error && (
        <div className="mb-3 rounded-lg bg-red-50 text-red-700 text-xs px-3 py-2">{error}</div>
      )}

      {loadError ? (
        <div className="text-xs text-red-600 flex items-center gap-2">
          <span>Couldn&apos;t load evidence.</span>
          <button type="button" onClick={() => void load()} className="underline hover:no-underline font-medium">
            Retry
          </button>
        </div>
      ) : items === null ? (
        <p className="text-xs text-gray-400 animate-pulse">Loading evidence…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-gray-400">No audit evidence uploaded yet.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {items.map((att) => {
            const isImage = att.contentType.startsWith('image/');
            return (
              <div key={att.id} className="group relative border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
                {isImage ? (
                  <button
                    type="button"
                    onClick={() => setLightbox(att)}
                    className="block w-full aspect-square bg-gray-100"
                    title={att.fileName}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={mediaUrl(att.id)}
                      alt={att.fileName}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </button>
                ) : (
                  <a
                    href={mediaUrl(att.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex flex-col items-center justify-center w-full aspect-square bg-gray-100 text-gray-500 hover:text-gray-700"
                    title={att.fileName}
                  >
                    <FileText className="w-8 h-8" />
                    <span className="mt-1 text-[10px] font-medium">PDF</span>
                  </a>
                )}

                <div className="px-2 py-1.5">
                  <p className="text-[10px] text-gray-600 truncate" title={att.fileName}>{att.fileName}</p>
                  <p className="text-[10px] text-gray-400">{fmtSize(att.sizeBytes)}</p>
                </div>

                {canDelete && (
                  <button
                    type="button"
                    onClick={() => handleDelete(att)}
                    disabled={deletingId === att.id}
                    className="absolute top-1 right-1 p-1 rounded-md bg-white/90 text-gray-400 hover:text-red-600 shadow-sm opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-100"
                    title="Remove"
                    aria-label={`Remove ${att.fileName}`}
                  >
                    {deletingId === att.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!canDelete && items && items.length > 0 && (
        <p className="mt-2 text-[11px] text-gray-400">
          This batch is confirmed — evidence can be added but not removed (audit trail locked).
        </p>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Preview: ${lightbox.fileName}`}
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 text-white/80 hover:text-white"
            onClick={() => setLightbox(null)}
            aria-label="Close"
          >
            <X className="w-6 h-6" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mediaUrl(lightbox.id)}
            alt={lightbox.fileName}
            className="max-w-full max-h-[85vh] rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
