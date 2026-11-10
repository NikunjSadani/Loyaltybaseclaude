/**
 * Sales Import — the in-tab upload manager (one upload at a time per browser tab).
 *
 * The upload lives at MODULE level, not inside the page component, so moving to another portal page does not kill
 * it: it keeps running while this tab stays open, and coming back to /admin/sales-import shows its progress (or its
 * failure / completion) again. Closing or reloading the tab does stop it — a `beforeunload` prompt is registered for
 * as long as an upload is running.
 *
 * Failure keeps the import (status UPLOADING) and the parts the server confirmed, so `resume()` re-sends only the
 * missing parts. An import is DELETED only on an explicit Cancel / Discard, and only after reading its status back:
 * an import whose /complete went through server-side (status no longer UPLOADING) is never deleted.
 */
import { salesImportApi } from './api';
import { sentence } from './format';
import {
  SalesImportHttpError, UploadAbortedError, continueUpload, readImportStatus, uploadInParts, type UploadSession,
} from './upload';

export type UploadPhase = 'idle' | 'uploading' | 'failed' | 'done';

export interface UploadState {
  phase: UploadPhase;
  fileName: string | null;
  /** 0..1 (confirmed parts / all parts). */
  progress: number;
  /** Failure / cancel message for the user. */
  error: string | null;
  /** The import created on the server (null until the create call succeeded). */
  importId: string | null;
  /** True when the import exists and the browser still holds the file, so the missing parts can be re-sent. */
  canResume: boolean;
}

const IDLE: UploadState = { phase: 'idle', fileName: null, progress: 0, error: null, importId: null, canResume: false };

let state: UploadState = IDLE;
let file: File | null = null;
let session: UploadSession | null = null;
let controller: AbortController | null = null;
let cancelRequested = false;
const listeners = new Set<() => void>();

function set(patch: Partial<UploadState>) {
  state = { ...state, ...patch };
  syncBeforeUnload();
  listeners.forEach((l) => l());
}

// ── Leaving the TAB kills the upload → ask first (in-app navigation does not; see the page's link guard). ───
const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
let unloadGuard = false;
function syncBeforeUnload() {
  if (typeof window === 'undefined') return;
  const want = state.phase === 'uploading';
  if (want && !unloadGuard) window.addEventListener('beforeunload', onBeforeUnload);
  if (!want && unloadGuard) window.removeEventListener('beforeunload', onBeforeUnload);
  unloadGuard = want;
}

export function subscribeUpload(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function getUploadState(): UploadState {
  return state;
}

function failureText(err: unknown): string {
  return sentence(err instanceof Error ? err.message : 'Upload failed');
}

/** Deletes the half-uploaded import — but only when the server confirms it is still UPLOADING. */
async function deleteIfStillUploading(importId: string): Promise<'deleted' | 'kept' | 'unknown'> {
  const status = await readImportStatus(importId);
  if (status === null) return 'unknown';
  if (status !== 'UPLOADING') return 'kept';
  const r = await salesImportApi.remove(importId);
  return r.success ? 'deleted' : 'unknown';
}

async function run(work: (signal: AbortSignal) => Promise<string>) {
  const ctl = new AbortController();
  controller = ctl;
  cancelRequested = false;
  try {
    const importId = await work(ctl.signal);
    file = null;
    session = null;
    set({ phase: 'done', progress: 1, importId, error: null, canResume: false });
  } catch (err) {
    const id = session?.importId ?? state.importId;
    if (cancelRequested || err instanceof UploadAbortedError) {
      const outcome = id ? await deleteIfStillUploading(id) : 'deleted';
      file = null;
      session = null;
      if (outcome === 'kept' && id) {
        // The upload had already completed server-side — nothing was cancelled.
        set({ phase: 'done', progress: 1, importId: id, error: null, canResume: false });
        return;
      }
      set({
        ...IDLE,
        error: outcome === 'unknown'
          ? 'Upload cancelled. The unfinished import could not be removed — delete it from the list below.'
          : 'Upload cancelled. Nothing was imported.',
      });
      return;
    }
    if (!id || !session) {
      // The server never created the import — nothing to resume or clean up.
      file = null;
      set({ ...IDLE, fileName: state.fileName, phase: 'failed', error: `${failureText(err)}. Nothing was imported — try again.` });
      return;
    }
    const refused = err instanceof SalesImportHttpError && err.status !== undefined && err.status >= 400 && err.status < 500
      && err.status !== 408 && err.status !== 429;
    set({
      phase: 'failed',
      importId: id,
      canResume: true,
      error: refused
        ? `${failureText(err)}. The parts already sent are kept — you can try Resume upload, or discard this upload.`
        : `${failureText(err)}. The parts already sent are kept — press Resume upload to send the rest.`,
    });
  } finally {
    if (controller === ctl) controller = null;
  }
}

/** Starts uploading `f`. Ignored while another upload in this tab is running. */
export function startUpload(f: File): void {
  if (state.phase === 'uploading') return;
  file = f;
  session = null;
  set({ ...IDLE, phase: 'uploading', fileName: f.name });
  void run((signal) => uploadInParts(f, {
    signal,
    onCreated: (importId, s) => { session = s; set({ importId }); },
    onProgress: (p) => set({ progress: p }),
  }));
}

/** Re-sends only the parts the server has not confirmed, then completes the import. */
export function resumeUpload(): void {
  if (state.phase !== 'failed' || !file || !session) return;
  const f = file;
  const s = session;
  set({ phase: 'uploading', error: null, canResume: false });
  void run(async (signal) => {
    const status = await readImportStatus(s.importId);
    if (status && status !== 'UPLOADING') {
      if (status === 'CANCELLED') throw new SalesImportHttpError('This import was cancelled on the server', 409);
      return s.importId; // already completed server-side
    }
    return continueUpload(f, s, { signal, onProgress: (p) => set({ progress: p }) });
  });
}

/** Stops the running upload; the half-uploaded import is then removed (if it is still UPLOADING). */
export function cancelUpload(): void {
  if (state.phase !== 'uploading') return;
  cancelRequested = true;
  controller?.abort();
}

/** Gives up on a failed upload: removes its import (only if still UPLOADING) and resets. */
export async function discardUpload(): Promise<void> {
  if (state.phase !== 'failed') return;
  const id = state.importId;
  const outcome = id ? await deleteIfStillUploading(id) : 'deleted';
  file = null;
  session = null;
  if (outcome === 'kept' && id) {
    set({ phase: 'done', progress: 1, importId: id, error: null, canResume: false });
    return;
  }
  set({
    ...IDLE,
    error: outcome === 'unknown' ? 'The unfinished import could not be removed — delete it from the list below.' : null,
  });
}

/** Clears a finished / failed-to-create state (e.g. after opening the finished import). */
export function resetUpload(): void {
  if (state.phase === 'uploading') return;
  file = null;
  session = null;
  set(IDLE);
}

/** Test-only. */
export function __resetUploadStoreForTests(): void {
  controller?.abort();
  controller = null;
  file = null;
  session = null;
  cancelRequested = false;
  state = IDLE;
  syncBeforeUnload();
  listeners.clear();
}
