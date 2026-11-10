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
 * an import whose /complete went through (QUEUED / PROCESSING / NEEDS_MAPPING / READY / FAILED) is never deleted;
 * a CANCELLED or deleted (404) import is "gone" — the state resets with an honest message, no endless Resume.
 *
 * Session safety: the user + assumed brand are recorded at start; if they change mid-upload every further request
 * is refused (the upload stops, nothing is deleted with the wrong session). Logout / brand switching first run the
 * session-change guard registered here: it asks, then cancels + discards the unfinished upload with the CURRENT
 * session before the switch.
 */
import { getAssumedBrand, getStoredUser } from '@/lib/auth-client';
import { registerSessionChangeGuard, type SessionChangeKind, type SessionChangeOptions } from '@/lib/session-change-guards';
import { salesImportApi } from './api';
import { sentence } from './format';
import {
  SalesImportHttpError, UploadAbortedError, UploadGoneError, UploadStoppedError, classifyUploadStatus, continueUpload,
  readImportStatus, uploadInParts, type UploadSession,
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
  /** A Discard / Cancel clean-up is in flight (Resume / Discard are disabled meanwhile). */
  busy: boolean;
}

const IDLE: UploadState = { phase: 'idle', fileName: null, progress: 0, error: null, importId: null, canResume: false, busy: false };

export const GONE_MESSAGE = 'This upload was cancelled or deleted — upload the file again.';
const LEFTOVER_MESSAGE =
  'The unfinished import could not be removed. Open it from the list below (status "Uploading / incomplete") and ' +
  'delete it there — unfinished uploads are also removed automatically after a day.';

let state: UploadState = IDLE;
let file: File | null = null;
let session: UploadSession | null = null;
let controller: AbortController | null = null;
let cancelRequested = false;
let running: Promise<void> | null = null;
/** "<userId>|<assumed brand>" when the upload started — requests stop if it changes. */
let sessionKey: string | null = null;
const listeners = new Set<() => void>();

function currentSessionKey(): string {
  return `${getStoredUser()?.id ?? ''}|${getAssumedBrand() ?? ''}`;
}

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

/** Throws once the signed-in user / assumed brand differs from the one the upload started under. */
function guard() {
  if (sessionKey !== null && currentSessionKey() !== sessionKey) {
    throw new UploadStoppedError('You signed out or switched brand during the upload, so it was stopped');
  }
}

function forget() {
  file = null;
  session = null;
  sessionKey = null;
}

/**
 * Deletes the half-uploaded import — but only when the server confirms it is still UPLOADING (and only with the
 * session it was created under).
 */
async function deleteIfStillUploading(importId: string): Promise<'deleted' | 'completed' | 'gone' | 'unknown'> {
  if (sessionKey !== null && currentSessionKey() !== sessionKey) return 'unknown';
  try {
    const kind = classifyUploadStatus(await readImportStatus(importId));
    if (kind === 'completed') return 'completed';
    if (kind === 'gone') return 'gone';
    if (kind === 'unknown') return 'unknown';
    const r = await salesImportApi.remove(importId);
    if (r.success) return 'deleted';
    return r.status === 404 ? 'gone' : 'unknown';
  } catch {
    return 'unknown'; // never leave the card stuck "busy"
  }
}

async function run(work: (signal: AbortSignal) => Promise<string>) {
  const ctl = new AbortController();
  controller = ctl;
  cancelRequested = false;
  try {
    const importId = await work(ctl.signal);
    forget();
    set({ ...IDLE, fileName: state.fileName, phase: 'done', progress: 1, importId });
  } catch (err) {
    const id = session?.importId ?? state.importId;
    if (err instanceof UploadStoppedError) {
      // Session changed: never touch the server with the new session; the import ages out (or is deleted by hand).
      forget();
      set({ ...IDLE, error: `${failureText(err)}. Upload the file again.` });
      return;
    }
    if (err instanceof UploadGoneError) {
      forget();
      set({ ...IDLE, error: GONE_MESSAGE });
      return;
    }
    if (cancelRequested || err instanceof UploadAbortedError) {
      const outcome = id ? await deleteIfStillUploading(id) : 'deleted';
      const fileName = state.fileName;
      forget();
      if (outcome === 'completed' && id) {
        // The upload had already completed server-side — nothing was cancelled.
        set({ ...IDLE, fileName, phase: 'done', progress: 1, importId: id });
        return;
      }
      set({
        ...IDLE,
        error: outcome === 'unknown' ? `Upload cancelled. ${LEFTOVER_MESSAGE}` : 'Upload cancelled. Nothing was imported.',
      });
      return;
    }
    if (!id || !session) {
      // The server never created the import — nothing to resume or clean up.
      forget();
      set({ ...IDLE, fileName: state.fileName, phase: 'failed', error: `${failureText(err)}. Nothing was imported — try again.` });
      return;
    }
    // A refused part (404 / 409) may mean the import was cancelled or deleted meanwhile → check before offering Resume.
    const kind = classifyUploadStatus(await readImportStatus(id));
    if (kind === 'gone') {
      forget();
      set({ ...IDLE, error: GONE_MESSAGE });
      return;
    }
    if (kind === 'completed') {
      const fileName = state.fileName;
      forget();
      set({ ...IDLE, fileName, phase: 'done', progress: 1, importId: id });
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

function launch(work: (signal: AbortSignal) => Promise<string>) {
  const p = run(work).finally(() => { if (running === p) running = null; });
  running = p;
}

/** Starts uploading `f`. Ignored while an upload in this tab is running, or a failed one awaits Resume / Discard. */
export function startUpload(f: File): void {
  if (state.phase === 'uploading' || state.phase === 'failed') return;
  file = f;
  session = null;
  sessionKey = currentSessionKey();
  set({ ...IDLE, phase: 'uploading', fileName: f.name });
  launch((signal) => uploadInParts(f, {
    signal,
    guard,
    onCreated: (importId, s) => { session = s; set({ importId }); },
    onProgress: (p) => set({ progress: p }),
  }));
}

/** Re-sends only the parts the server has not confirmed, then completes the import. */
export function resumeUpload(): void {
  if (state.phase !== 'failed' || state.busy || !file || !session) return;
  const f = file;
  const s = session;
  set({ phase: 'uploading', error: null, canResume: false });
  launch(async (signal) => {
    guard();
    const kind = classifyUploadStatus(await readImportStatus(s.importId));
    if (kind === 'gone') throw new UploadGoneError();
    if (kind === 'completed') return s.importId; // already completed server-side
    return continueUpload(f, s, { signal, guard, onProgress: (p) => set({ progress: p }) });
  });
}

/** Stops the running upload; the half-uploaded import is then removed (if it is still UPLOADING). */
export function cancelUpload(): void {
  if (state.phase !== 'uploading') return;
  cancelRequested = true;
  set({ busy: true });
  controller?.abort();
}

/** Gives up on a failed upload: removes its import (only if still UPLOADING) and resets. */
export async function discardUpload(): Promise<void> {
  if (state.phase !== 'failed' || state.busy) return;
  const id = state.importId;
  const fileName = state.fileName;
  set({ busy: true });
  const outcome = id ? await deleteIfStillUploading(id) : 'deleted';
  forget();
  if (outcome === 'completed' && id) {
    set({ ...IDLE, fileName, phase: 'done', progress: 1, importId: id });
    return;
  }
  set({ ...IDLE, error: outcome === 'unknown' ? LEFTOVER_MESSAGE : null });
}

/** Clears a finished / failed-to-create state (e.g. after opening the finished import). */
export function resetUpload(): void {
  if (state.phase === 'uploading') return;
  forget();
  set(IDLE);
}

/**
 * Before logout / a brand switch: if an upload is running or unfinished, ask; on "yes" cancel + discard it with
 * the CURRENT session (awaited — the registry time-boxes it) and allow the change; on "no" veto it. With `force`
 * (session already revoked) there is no prompt: the clean-up is attempted and the change always proceeds.
 */
export async function releaseUploadForSessionChange(kind: SessionChangeKind, opts: SessionChangeOptions = {}): Promise<boolean> {
  if (state.phase !== 'uploading' && state.phase !== 'failed') return true;
  const what = kind === 'logout' ? 'Signing out' : 'Switching brand';
  const ok = opts.force || (typeof window !== 'undefined' && window.confirm(
    `A sales file ${state.phase === 'uploading' ? 'is still uploading' : 'upload is unfinished'}` +
    `${state.fileName ? ` (${state.fileName})` : ''}. ${what} cancels it and removes the unfinished import.\n\nContinue?`,
  ));
  if (!ok) return false;
  try {
    if (state.phase === 'uploading') {
      cancelUpload();
      await running;
    } else {
      await discardUpload();
    }
  } catch {
    /* best-effort: never block the session change */
  }
  return true;
}

registerSessionChangeGuard(releaseUploadForSessionChange);

/** Test-only. */
export function __resetUploadStoreForTests(): void {
  controller?.abort();
  controller = null;
  running = null;
  forget();
  cancelRequested = false;
  state = IDLE;
  syncBeforeUnload();
  listeners.clear();
  registerSessionChangeGuard(releaseUploadForSessionChange); // Set → idempotent
}
