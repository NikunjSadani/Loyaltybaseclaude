/**
 * Sales Import — chunked browser upload (plan §11 F-1, D-2 A).
 *
 * The DMS file (up to SALES_IMPORT_MAX_FILE_BYTES) is sliced into SALES_IMPORT_PART_SIZE parts and each part is
 * POSTed as multipart to `/api/admin/sales-import/:id/parts/:n`. A part upload is idempotent on the server (the
 * same `n` overwrites), so a transient failure is retried with exponential backoff (0.5 s … 30 s, ~61 s in total),
 * and after giving up the caller can RESUME: continueUpload() re-sends only the parts not yet confirmed. A 4xx
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

/** Extra attempts per part / per call before giving up. With backoffMs this waits ~61.5 s in total. */
export const UPLOAD_RETRIES = 7;
/** Wait before retry `attempt` (0-based): 0.5 s, 1, 2, 4, 8, 16, then capped at 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 30_000);
}

/** Runs `fn`; on a retryable failure waits backoffMs(i) and tries again, up to `retries` extra attempts. */
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
      await sleep(backoffMs(attempt), opts.signal);
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

/** What a resumable upload needs to carry on: the server's import + plan and the parts it has confirmed. */
export interface UploadSession {
  importId: string;
  partSize: number;
  partCount: number;
  /** Part numbers the server confirmed (2xx). Parts are idempotent, so re-sending one is harmless. */
  confirmed: Set<number>;
}

export interface UploadInPartsOptions {
  /** 0..1 after each confirmed part. */
  onProgress(p: number): void;
  /** Called once the server has created the import — keep the session to resume after a failure. */
  onCreated?(importId: string, session: UploadSession): void;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const importPath = (importId: string) => `/api/admin/sales-import/${encodeURIComponent(importId)}`;

/**
 * Has the server already moved the import past UPLOADING (i.e. a /complete we could not see the answer to did
 * succeed)? Returns the status, or null when it could not be read.
 */
export async function readImportStatus(importId: string): Promise<SalesImportSummary['status'] | null> {
  const r = await api.get<SalesImportSummary>(importPath(importId));
  return r.success ? r.data.status : null;
}

/**
 * Sends every part not yet confirmed in `session`, then completes the import. Resolves with the import id (status
 * QUEUED). On failure the session keeps the confirmed parts, so calling this again re-sends only the missing ones.
 * If /complete fails, the import status is read back first: a /complete that actually succeeded (response lost) is
 * treated as success, never as a failure.
 */
export async function continueUpload(
  file: File,
  session: UploadSession,
  opts: Omit<UploadInPartsOptions, 'onCreated'>,
): Promise<string> {
  const { importId, partSize, partCount } = session;
  const parts = planParts(file.size, partSize);
  if (parts.length !== partCount) {
    throw new Error(`Upload plan mismatch: server expects ${partCount} parts, browser computed ${parts.length}.`);
  }
  opts.onProgress(session.confirmed.size / partCount);
  for (const p of parts) {
    if (session.confirmed.has(p.n)) continue;
    const blob = file.slice(p.start, p.end);
    await withRetry(() => postPart(importId, p.n, blob, opts.signal), UPLOAD_RETRIES, { signal: opts.signal, sleep: opts.sleep });
    session.confirmed.add(p.n);
    opts.onProgress(session.confirmed.size / partCount);
  }
  if (opts.signal?.aborted) throw new UploadAbortedError();
  const done = await api.post<SalesImportSummary>(`${importPath(importId)}/complete`, {});
  if (!done.success) {
    const status = await readImportStatus(importId);
    if (status && status !== 'UPLOADING') return importId; // /complete went through; only its answer was lost
    throw new SalesImportHttpError(done.error, done.status);
  }
  return importId;
}

/** Creates the import, uploads `file` in parts and completes it. Resolves with the import id (status QUEUED). */
export async function uploadInParts(file: File, opts: UploadInPartsOptions): Promise<string> {
  const init = await api.post<CreateSalesImportUploadResult>('/api/admin/sales-import/uploads', {
    filename: file.name,
    sizeBytes: file.size,
  });
  if (!init.success) throw new SalesImportHttpError(init.error, init.status);
  const { importId, partSize, partCount } = init.data;
  const session: UploadSession = { importId, partSize, partCount, confirmed: new Set() };
  opts.onCreated?.(importId, session);
  return continueUpload(file, session, opts);
}
