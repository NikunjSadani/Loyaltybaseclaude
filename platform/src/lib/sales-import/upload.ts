/**
 * Sales Import — chunked browser upload (plan §11 F-1, D-2 A).
 *
 * The DMS file (up to SALES_IMPORT_MAX_FILE_BYTES) is sliced into SALES_IMPORT_PART_SIZE parts and each part is
 * POSTed as multipart to `/api/admin/sales-import/:id/parts/:n`. A part upload is idempotent on the server (the
 * same `n` overwrites), so a transient failure is retried with exponential backoff (0.5 s, 1 s, 2 s, 4 s). A 4xx
 * other than 408/429 is NOT retried — it is a real refusal (wrong state, too large, not your import).
 *
 * D-2 B (direct-to-GCS resumable upload) can later replace the transport behind the same `uploadInParts()`.
 */
import { api, authHeader } from '@/lib/api-client';
import {
  SALES_IMPORT_ALLOWED_EXTENSIONS,
  SALES_IMPORT_MAX_FILE_BYTES,
  type CreateSalesImportUploadResult,
  type SalesImportPartResult,
  type SalesImportSummary,
} from './types';

/** An HTTP failure with the status kept, so callers can decide on retry / special-casing (e.g. 409). */
export class SalesImportHttpError extends Error {
  constructor(message: string, readonly status: number | undefined) {
    super(message);
    this.name = 'SalesImportHttpError';
  }
}

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadAbortedError';
  }
}

/** Byte ranges of each part: [start, end) — the last part is the remainder (never empty for size > 0). */
export function planParts(sizeBytes: number, partSize: number): Array<{ n: number; start: number; end: number }> {
  if (!(partSize > 0)) throw new Error('partSize must be > 0');
  const parts: Array<{ n: number; start: number; end: number }> = [];
  for (let n = 0, start = 0; start < sizeBytes; n++, start += partSize) {
    parts.push({ n, start, end: Math.min(sizeBytes, start + partSize) });
  }
  return parts;
}

/** Client-side pre-check before asking the server for an upload slot. Returns an error message or null. */
export function validateSalesFile(file: { name: string; size: number }): string | null {
  const lower = file.name.toLowerCase();
  if (!SALES_IMPORT_ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return 'Only .xlsx or .csv files are supported.';
  }
  if (file.size <= 0) return 'The file is empty.';
  if (file.size > SALES_IMPORT_MAX_FILE_BYTES) {
    return `The file is larger than ${Math.round(SALES_IMPORT_MAX_FILE_BYTES / (1024 * 1024))} MB.`;
  }
  return null;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof UploadAbortedError) return false;
  if (err instanceof SalesImportHttpError) {
    const s = err.status;
    return s === undefined || s === 408 || s === 429 || s >= 500;
  }
  return true; // network / unknown → retry
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadAbortedError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new UploadAbortedError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Runs `fn`; on a retryable failure waits 500·2^i ms and tries again, up to `retries` extra attempts. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  opts: { signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new UploadAbortedError();
    try {
      return await fn();
    } catch (err) {
      if (opts.signal?.aborted) throw new UploadAbortedError();
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(500 * 2 ** attempt, opts.signal);
    }
  }
}

/** POST one part as multipart `file`. Throws SalesImportHttpError on a non-2xx / unsuccessful envelope. */
export async function postPart(importId: string, n: number, blob: Blob, signal?: AbortSignal): Promise<SalesImportPartResult> {
  const form = new FormData();
  form.append('file', blob, `part-${n}`);
  let res: Response;
  try {
    res = await fetch(`/api/admin/sales-import/${encodeURIComponent(importId)}/parts/${n}`, {
      method: 'POST',
      headers: authHeader(), // no Content-Type — the browser sets the multipart boundary
      body: form,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new UploadAbortedError();
    throw err instanceof Error ? err : new Error('Network error');
  }
  let body: { success?: boolean; data?: SalesImportPartResult; error?: string } | null = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body || body.success === false) {
    throw new SalesImportHttpError(body?.error ?? `Part ${n + 1} failed (HTTP ${res.status})`, res.status);
  }
  return body.data as SalesImportPartResult;
}

export interface UploadInPartsOptions {
  /** 0..1 after each confirmed part. */
  onProgress(p: number): void;
  /** Called once the server has created the import (so the caller can clean up on failure). */
  onCreated?(importId: string): void;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Uploads `file` in parts and completes the import. Resolves with the import id (status QUEUED). */
export async function uploadInParts(file: File, opts: UploadInPartsOptions): Promise<string> {
  const init = await api.post<CreateSalesImportUploadResult>('/api/admin/sales-import/uploads', {
    filename: file.name,
    sizeBytes: file.size,
  });
  if (!init.success) throw new SalesImportHttpError(init.error, init.status);
  const { importId, partSize, partCount } = init.data;
  opts.onCreated?.(importId);

  const parts = planParts(file.size, partSize);
  if (parts.length !== partCount) {
    throw new Error(`Upload plan mismatch: server expects ${partCount} parts, browser computed ${parts.length}.`);
  }
  opts.onProgress(0);
  for (const p of parts) {
    const blob = file.slice(p.start, p.end);
    await withRetry(() => postPart(importId, p.n, blob, opts.signal), 4, { signal: opts.signal, sleep: opts.sleep });
    opts.onProgress((p.n + 1) / partCount);
  }
  if (opts.signal?.aborted) throw new UploadAbortedError();
  const done = await api.post<SalesImportSummary>(`/api/admin/sales-import/${encodeURIComponent(importId)}/complete`, {});
  if (!done.success) throw new SalesImportHttpError(done.error, done.status);
  return importId;
}
