'use client';

/**
 * useDownloadAction — one button state machine for every report download, so all of them
 * behave the same: idle → working → (downloaded → idle) | queued (with a Downloads link) | error.
 * Pair it with <DownloadActionStatus action={…} /> to show the queued / error message.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadOrQueue, type DownloadOrQueueOptions, type DownloadOutcome } from '@/lib/exports/download';

export type DownloadActionStatus = 'idle' | 'working' | 'queued' | 'error';

export interface DownloadAction {
  status: DownloadActionStatus;
  /** Queued: the "we're preparing your file" text. Error: the plain-English reason. */
  message: string | null;
  busy: boolean;
  /** Start a download from a URL, or run a function that already returns a DownloadOutcome. */
  run: (target: string | (() => Promise<DownloadOutcome>), opts?: DownloadOrQueueOptions) => Promise<DownloadOutcome | null>;
  reset: () => void;
}

export function useDownloadAction(): DownloadAction {
  const [status, setStatus] = useState<DownloadActionStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback<DownloadAction['run']>(async (target, opts) => {
    // A double-click must not start two downloads (or queue two heavy files).
    if (inFlight.current) return null;
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
    if (mounted.current) {
      if (outcome.kind === 'downloaded') { setStatus('idle'); setMessage(null); }
      else if (outcome.kind === 'queued') { setStatus('queued'); setMessage(outcome.message); }
      else { setStatus('error'); setMessage(outcome.message); }
    }
    return outcome;
  }, []);

  const reset = useCallback(() => { setStatus('idle'); setMessage(null); }, []);

  return { status, message, busy: status === 'working', run, reset };
}
