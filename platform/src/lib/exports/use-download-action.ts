'use client';

/**
 * useDownloadAction — one button state machine for every report download, so all of them
 * behave the same: idle → working → (downloaded → idle) | queued (with a Downloads link) | error.
 * Pair it with <DownloadActionStatus action={…} /> (placed directly BELOW the button) to show the
 * queued / error message, and label the button with `downloadButtonLabel(action, 'Download …')`.
 *
 * While a request is queued the button stays disabled (`blocked`) and reads
 * "Being prepared — see Downloads" until the person dismisses the message — clicking again would
 * only ask for the same file twice (the server also de-duplicates an identical request).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadOrQueue, type DownloadOrQueueOptions, type DownloadOutcome } from '@/lib/exports/download';
import { notifyDownloadsChanged } from '@/lib/exports/seen';

export type DownloadActionStatus = 'idle' | 'working' | 'queued' | 'error';

/** The one busy label every report button shows while the request is in flight. */
export const DOWNLOAD_BUSY_LABEL = 'Preparing…';
/** What a report button reads after its file was queued for the Downloads page. */
export const DOWNLOAD_QUEUED_LABEL = 'Being prepared — see Downloads';

export interface DownloadAction {
  status: DownloadActionStatus;
  /** Queued: the "we're preparing your file" text. Error: the plain-English reason. */
  message: string | null;
  busy: boolean;
  /** busy OR queued-and-not-dismissed → the button must be disabled. */
  blocked: boolean;
  /** Start a download from a URL, or run a function that already returns a DownloadOutcome. */
  run: (target: string | (() => Promise<DownloadOutcome>), opts?: DownloadOrQueueOptions) => Promise<DownloadOutcome | null>;
  reset: () => void;
}

/** The button text for a report download in its current state (one wording everywhere). */
export function downloadButtonLabel(action: Pick<DownloadAction, 'status'>, idleLabel: string): string {
  if (action.status === 'working') return DOWNLOAD_BUSY_LABEL;
  if (action.status === 'queued') return DOWNLOAD_QUEUED_LABEL;
  return idleLabel;
}

export function useDownloadAction(): DownloadAction {
  const [status, setStatus] = useState<DownloadActionStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const queuedRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback<DownloadAction['run']>(async (target, opts) => {
    // A double-click must not start two downloads (or queue two heavy files), and a queued file
    // must be acknowledged (message dismissed) before the same button can ask again.
    if (inFlight.current || queuedRef.current) return null;
    inFlight.current = true;
    setStatus('working');
    setMessage(null);
    let outcome: DownloadOutcome;
    try {
      outcome = typeof target === 'string' ? await downloadOrQueue(target, opts) : await target();
    } catch (err) {
      outcome = { kind: 'error', message: err instanceof Error && err.message ? err.message : 'Download failed. Please try again.' };
    } finally {
      inFlight.current = false;
    }
    // A newly queued file → the Downloads nav badge starts watching for it.
    if (outcome.kind === 'queued') notifyDownloadsChanged();
    if (mounted.current) {
      if (outcome.kind === 'downloaded') { setStatus('idle'); setMessage(null); }
      else if (outcome.kind === 'queued') { queuedRef.current = true; setStatus('queued'); setMessage(outcome.message); }
      else { setStatus('error'); setMessage(outcome.message); }
    }
    return outcome;
  }, []);

  const reset = useCallback(() => { queuedRef.current = false; setStatus('idle'); setMessage(null); }, []);

  return { status, message, busy: status === 'working', blocked: status === 'working' || status === 'queued', run, reset };
}
