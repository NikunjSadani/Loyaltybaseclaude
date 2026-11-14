'use client';

/**
 * The message directly BELOW a report download button: "we're preparing your file" (+ a Downloads link)
 * when the report was queued, or the plain-English reason when it failed. `tone="dark"` for the Gifsy
 * console's dark shell.
 *
 * Accessibility (L2): a screen-reader live region is ALWAYS mounted (visually hidden, so it takes no space
 * even inside flex rows) and its text changes when the request is queued — a live region that only appears
 * together with its message is often not announced. Errors use role="alert", which is announced on insertion.
 */
import Link from 'next/link';
import { AlertTriangle, Clock, X } from 'lucide-react';
import { DOWNLOADS_PAGE_HREF } from '@/lib/exports/download';
import type { DownloadAction } from '@/lib/exports/use-download-action';

export function DownloadActionStatus({
  action,
  tone = 'light',
  className = '',
  downloadsHref = DOWNLOADS_PAGE_HREF,
}: {
  action: Pick<DownloadAction, 'status' | 'message' | 'reset'>;
  tone?: 'light' | 'dark';
  className?: string;
  downloadsHref?: string;
}) {
  const announce = action.status === 'queued' && action.message ? `${action.message} Open Downloads to get it.` : '';
  const live = (
    <span className="sr-only" role="status" aria-live="polite" data-testid="download-live-region">
      {announce}
    </span>
  );

  let content: React.ReactNode = null;
  if (action.status === 'queued') {
    const box = tone === 'dark'
      ? 'bg-sky-500/10 border-sky-500/20 text-sky-200'
      : 'bg-sky-50 border-sky-200 text-sky-900';
    const link = tone === 'dark' ? 'text-sky-300' : 'text-sky-700';
    content = (
        <div data-testid="download-queued" className={`flex items-start gap-2 border rounded-lg px-3 py-2 text-xs ${box} ${className}`}>
          <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 break-words">
            {action.message}{' '}
            <Link href={downloadsHref} className={`font-semibold underline underline-offset-2 ${link}`}>
              Open Downloads
            </Link>
          </p>
          <button
            type="button"
            onClick={action.reset}
            aria-label="Dismiss message"
            className="ml-auto shrink-0 opacity-60 hover:opacity-100"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
    );
  } else if (action.status === 'error' && action.message) {
    const text = tone === 'dark' ? 'text-red-400' : 'text-red-600';
    content = (
        <p role="alert" data-testid="download-error" className={`flex items-start gap-1 text-xs ${text} ${className}`}>
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{action.message}</span>
          <button
            type="button"
            onClick={action.reset}
            aria-label="Dismiss message"
            className="ml-1 shrink-0 opacity-60 hover:opacity-100"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </p>
    );
  }
  // Same shape in every state so the live region stays mounted (never re-created with its message).
  return <>{live}{content}</>;
}
