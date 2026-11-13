/**
 * Report downloads that may be prepared in the background (Downloads page).
 * Design: platform/docs/plans/DOWNLOADS-PAGE.md (owner-approved 2026-11-13, ⚠️ platform-wide).
 *
 * A report endpoint answers EITHER
 *   - 200 with the file (small request) → we save it straight away, or
 *   - 202 with ExportQueuedResponse (big request) → the file is built in the back room and
 *     appears on the Downloads page a few minutes later. We return `queued` so the screen can
 *     say so and link to the Downloads page.
 *
 * Every report download button goes through `downloadOrQueue` (or `useDownloadAction`, which
 * wraps it with button state) so they all behave the same. Never call `res.blob()` on a report
 * endpoint directly: a 202 is `ok`, and its JSON body would be saved as a broken .xlsx.
 */
import { downloadBlob } from '@/lib/download';
import type { ExportList, ExportQueuedResponse } from '@/lib/exports/types';
import { EXPORT_MAX_ACTIVE_PER_USER } from '@/lib/exports/types';

/** Where the Downloads page lives in the admin portal (every report button links here). */
export const DOWNLOADS_PAGE_HREF = '/admin/downloads';

/** Shown when a report is being prepared in the background. */
export const QUEUED_MESSAGE_DEFAULT =
  "We're preparing your file — it will appear under Downloads (usually 1–5 minutes).";

export type DownloadOutcome =
  | { kind: 'downloaded'; fileName: string }
  | { kind: 'queued'; message: string; exportRequestId: string }
  | { kind: 'error'; message: string; status?: number };

export interface DownloadOrQueueOptions {
  /** File name used when the response carries no Content-Disposition file name. */
  fallbackFileName?: string;
  /** Extra fetch options (method, headers, body…). Same-origin cookies are sent by default. */
  init?: RequestInit;
}

/** Read the file name from a Content-Disposition header (RFC 5987 `filename*` first). */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain filename */
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/.exec(header);
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim();
  return name || null;
}

/** Pull the server's error text out of a JSON error body (`{ success:false, error }` or Nest's `{ message }`). */
async function serverErrorText(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown } | null;
    const raw = body?.error ?? body?.message;
    if (Array.isArray(raw)) return raw.join(', ');
    return typeof raw === 'string' && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/** Plain-English message for a failed download. The server's own text wins for 4xx (it is written for people). */
export function downloadErrorMessage(status: number, serverText: string | null): string {
  if (status === 409) {
    return serverText
      ?? `You already have ${EXPORT_MAX_ACTIVE_PER_USER} downloads being prepared. Wait for one to finish (see Downloads), then try again.`;
  }
  if (status === 503) return serverText ?? "Downloads aren't set up on this server yet. Please contact Gifsy support.";
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return serverText ?? "You don't have permission to download this report.";
  if (status === 404) return serverText ?? 'This file is no longer available.';
  if (status === 410) return serverText ?? 'This file has expired. Please request it again.';
  if (status >= 400 && status < 500) return serverText ?? `The download could not be started (error ${status}).`;
  // Unknown status (no number) with a readable server reason → show it; 5xx stays generic.
  if (status < 400 && serverText) return serverText;
  return 'Something went wrong while preparing the file. Please try again in a moment.';
}

/** Unwrap a 202 body — the API wraps JSON in `{ success, data }`; tolerate a bare body too. */
function readQueued(body: unknown): ExportQueuedResponse | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { data?: unknown; exportRequestId?: unknown; message?: unknown };
  const inner = (b.data && typeof b.data === 'object' ? b.data : b) as { exportRequestId?: unknown; message?: unknown };
  if (typeof inner.exportRequestId !== 'string') return null;
  return {
    exportRequestId: inner.exportRequestId,
    message: typeof inner.message === 'string' && inner.message.trim() ? inner.message : QUEUED_MESSAGE_DEFAULT,
  };
}

/**
 * Fetch a report URL: 200 → save the file; 202 → tell the caller it was queued; anything else → a
 * plain-English error. Never throws.
 */
export async function downloadOrQueue(url: string, opts: DownloadOrQueueOptions = {}): Promise<DownloadOutcome> {
  let res: Response;
  try {
    // Same-origin fetch sends the auth cookie by default (the proxy injects the Bearer).
    res = await (opts.init ? fetch(url, opts.init) : fetch(url));
  } catch {
    return { kind: 'error', message: "Couldn't reach the server. Check your connection and try again." };
  }

  if (res.status === 202) {
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    const queued = readQueued(body);
    if (!queued) {
      return { kind: 'error', status: 202, message: 'The download was accepted but the server reply was unexpected. Check the Downloads page.' };
    }
    return { kind: 'queued', message: queued.message, exportRequestId: queued.exportRequestId };
  }

  if (!res.ok) {
    const status = typeof res.status === 'number' ? res.status : 0;
    return { kind: 'error', status: status || undefined, message: downloadErrorMessage(status, await serverErrorText(res)) };
  }

  try {
    const blob = await res.blob();
    const fileName = fileNameFromDisposition(res.headers?.get?.('Content-Disposition'))
      ?? opts.fallbackFileName
      ?? 'download.xlsx';
    downloadBlob(blob, fileName);
    return { kind: 'downloaded', fileName };
  } catch {
    return { kind: 'error', message: 'The file could not be saved. Please try again.' };
  }
}

// ── Downloads page API (GET admin/exports, GET admin/exports/:id/download) ─────────────

export const EXPORTS_BASE = '/api/admin/exports';

export type ExportListResult =
  | { ok: true; data: ExportList }
  | { ok: false; message: string; status?: number };

/** GET /api/admin/exports?cursor= — the caller's own requests, newest first. */
export async function fetchExportList(cursor?: string | null): Promise<ExportListResult> {
  const url = cursor ? `${EXPORTS_BASE}?cursor=${encodeURIComponent(cursor)}` : EXPORTS_BASE;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, message: downloadErrorMessage(res.status, await serverErrorText(res)) };
  }
  try {
    const body = (await res.json()) as { data?: ExportList } & Partial<ExportList>;
    const data = (body?.data ?? body) as Partial<ExportList>;
    return {
      ok: true,
      data: {
        items: Array.isArray(data.items) ? data.items : [],
        nextCursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null,
      },
    };
  } catch {
    return { ok: false, message: 'The list of downloads could not be read. Please refresh the page.' };
  }
}

/** URL of one prepared file (streamed by the API). */
export function exportFileUrl(id: string): string {
  return `${EXPORTS_BASE}/${encodeURIComponent(id)}/download`;
}

/** Save one READY file from the Downloads page. */
export function downloadPreparedFile(id: string, fileName?: string | null): Promise<DownloadOutcome> {
  return downloadOrQueue(exportFileUrl(id), { fallbackFileName: fileName ?? 'download.xlsx' });
}
