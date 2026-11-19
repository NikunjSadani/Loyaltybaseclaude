'use client';

/* ─── Help & videos — member screens (sales + partner) ───────────────────────
   One list + one detail view, shared by /sales/help and /partner/help. The API
   base decides the audience (/api/sales/help-topics → SALES guides,
   /api/partner/help-topics → PARTNER guides); the server filters by tenant,
   published state and the caller's role. Videos stream from a short-lived signed
   URL and NEVER autoplay; the numbered steps always render, video or not, so a
   failed video still leaves the user with the written instructions.
   See platform/docs/plans/HELP-VIDEOS.md.
─────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronRight, PlayCircle, RefreshCw, VideoOff } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Spinner } from '@/components/ui/spinner';

export interface HelpTopicMember {
  id: string;
  title: string;
  description: string | null;
  steps: string[];
  videoUrl: string | null;
  posterUrl: string | null;
}

type Load<T> = { state: 'loading' } | { state: 'error'; message: string; notFound: boolean } | { state: 'ok'; data: T };

function useHelpLoad<T>(url: string): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoad({ state: 'loading' });
    api.get<T>(url).then((r) => {
      if (cancelled) return;
      if (r.success) setLoad({ state: 'ok', data: r.data });
      else setLoad({ state: 'error', message: r.error || 'Something went wrong.', notFound: r.status === 404 });
    });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return [load, retry];
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-48 gap-3 text-center px-6" data-testid="help-error">
      <p className="text-sm text-gray-600">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
      >
        <RefreshCw className="h-4 w-4" /> Retry
      </button>
    </div>
  );
}

/** Help & videos list. `apiBase` = /api/sales/help-topics | /api/partner/help-topics. */
export function HelpTopicList({ apiBase, hrefBase, backHref }: { apiBase: string; hrefBase: string; backHref: string }) {
  const [load, retry] = useHelpLoad<{ topics: HelpTopicMember[] }>(apiBase);

  return (
    <div className="space-y-4 fade-in">
      <div className="flex items-center gap-2">
        <Link href={backHref} aria-label="Back" className="p-1.5 -ml-1.5 rounded-lg hover:bg-gray-100">
          <ArrowLeft className="h-5 w-5 text-gray-600" />
        </Link>
        <h1 className="text-xl font-bold text-gray-900">Help &amp; videos</h1>
      </div>

      {load.state === 'loading' && (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      )}

      {load.state === 'error' &&
        (load.notFound ? (
          <p className="text-sm text-gray-500 text-center py-10" data-testid="help-unavailable">
            Help &amp; videos is not available.
          </p>
        ) : (
          <ErrorState message="Could not load the guides. Please try again." onRetry={retry} />
        ))}

      {load.state === 'ok' && load.data.topics.length === 0 && (
        <div className="flex flex-col items-center justify-center py-14 text-center" data-testid="help-empty">
          <PlayCircle className="h-10 w-10 text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-700">No guides yet</p>
          <p className="text-xs text-gray-400 mt-1">Check back soon.</p>
        </div>
      )}

      {load.state === 'ok' && load.data.topics.length > 0 && (
        <ul className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50 overflow-hidden" data-testid="help-list">
          {load.data.topics.map((t) => (
            <li key={t.id}>
              <Link
                href={`${hrefBase}/${encodeURIComponent(t.id)}`}
                className="flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                data-testid="help-list-item"
              >
                <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                  {t.videoUrl ? <PlayCircle className="h-5 w-5 text-[var(--brand-primary)]" /> : <span className="text-xs font-semibold text-gray-400">{t.steps.length}</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{t.title}</p>
                  {t.description && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{t.description}</p>}
                </div>
                <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One guide: the video (if any) + the numbered steps. */
export function HelpTopicDetail({ apiBase, id, listHref }: { apiBase: string; id: string; listHref: string }) {
  const [load, retry] = useHelpLoad<HelpTopicMember>(`${apiBase}/${encodeURIComponent(id)}`);
  const [videoFailed, setVideoFailed] = useState(false);

  return (
    <div className="space-y-4 fade-in">
      <div className="flex items-center gap-2">
        <Link href={listHref} aria-label="Back to Help & videos" className="p-1.5 -ml-1.5 rounded-lg hover:bg-gray-100">
          <ArrowLeft className="h-5 w-5 text-gray-600" />
        </Link>
        <h1 className="text-lg font-bold text-gray-900 truncate">{load.state === 'ok' ? load.data.title : 'Help & videos'}</h1>
      </div>

      {load.state === 'loading' && (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      )}

      {load.state === 'error' &&
        (load.notFound ? (
          <p className="text-sm text-gray-500 text-center py-10" data-testid="help-not-found">
            This guide is not available.
          </p>
        ) : (
          <ErrorState message="Could not load this guide. Please try again." onRetry={retry} />
        ))}

      {load.state === 'ok' && (
        <>
          {load.data.description && <p className="text-sm text-gray-600">{load.data.description}</p>}

          {load.data.videoUrl && !videoFailed && (
            <video
              data-testid="help-video"
              className="w-full rounded-2xl bg-black aspect-video"
              src={load.data.videoUrl}
              poster={load.data.posterUrl ?? undefined}
              controls
              playsInline
              preload="metadata"
              onError={() => setVideoFailed(true)}
            />
          )}
          {load.data.videoUrl && videoFailed && (
            <div
              data-testid="help-video-error"
              role="status"
              className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              <VideoOff className="h-5 w-5 shrink-0" />
              <span>The video could not be loaded. Follow the steps below.</span>
            </div>
          )}

          <ol className="space-y-2" data-testid="help-steps">
            {load.data.steps.map((s, i) => (
              <li key={i} className="flex gap-3 bg-white rounded-xl border border-gray-100 px-4 py-3">
                <span className="w-6 h-6 rounded-full bg-[var(--brand-primary)] text-white text-xs font-bold flex items-center justify-center shrink-0">
                  {i + 1}
                </span>
                <span className="text-sm text-gray-800">{s}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
