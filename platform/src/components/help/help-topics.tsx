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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronRight, ListOrdered, PlayCircle, RefreshCw, VideoOff } from 'lucide-react';
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

/**
 * Load `url`. `retry` reloads with a spinner; `refresh` re-reads SILENTLY (keeps the current data on screen) and
 * resolves true when fresh data arrived — used to get a new short-lived media token without blanking the page.
 */
function useHelpLoad<T>(url: string): [Load<T>, () => void, () => Promise<boolean>] {
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
  const refresh = useCallback(async (): Promise<boolean> => {
    const r = await api.get<T>(url);
    if (r.success) {
      setLoad({ state: 'ok', data: r.data });
      return true;
    }
    // The guide itself is gone (unpublished / feature turned off) → say so; a transient failure keeps the page.
    if (r.status === 404) setLoad({ state: 'error', message: r.error || 'Not found', notFound: true });
    return false;
  }, [url]);
  return [load, retry, refresh];
}

/** "5 steps" / "1 step"; video guides read "Video · 5 steps". */
export function guideMetaLabel(t: Pick<HelpTopicMember, 'videoUrl' | 'steps'>): string {
  const n = t.steps.length;
  const steps = `${n} step${n === 1 ? '' : 's'}`;
  return t.videoUrl ? `Video · ${steps}` : steps;
}

/**
 * Player box for a video of `ratio` = width / height. It always fills the width; its height follows the video's
 * shape but is capped at 75vh (a portrait recording on a phone would otherwise be taller than the screen), and
 * `object-fit: contain` letterboxes inside the box — never crops. Until the metadata arrives we assume PORTRAIT
 * (9:16): every Bajaj guide is a portrait phone recording, so the box rarely jumps.
 */
export const DEFAULT_VIDEO_RATIO = 9 / 16;
export function playerStyle(ratio: number): React.CSSProperties {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_VIDEO_RATIO;
  return { width: '100%', aspectRatio: String(r), maxHeight: '75vh', objectFit: 'contain' };
}

/** At most one SILENT token refresh per this window — a video that keeps failing then shows the error box. */
const AUTO_REFRESH_WINDOW_MS = 60_000;

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
                <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center shrink-0" aria-hidden="true">
                  {t.videoUrl ? (
                    <PlayCircle className="h-5 w-5 text-[var(--brand-primary)]" data-testid="help-list-icon-video" />
                  ) : (
                    <ListOrdered className="h-5 w-5 text-gray-400" data-testid="help-list-icon-steps" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{t.title}</p>
                  {t.description && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{t.description}</p>}
                  <p className="text-[11px] text-gray-400 mt-0.5" data-testid="help-list-meta">{guideMetaLabel(t)}</p>
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
  const [load, retry, refresh] = useHelpLoad<HelpTopicMember>(`${apiBase}/${encodeURIComponent(id)}`);
  const [videoFailed, setVideoFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastAutoRefresh = useRef(0);
  const resumeAt = useRef(0);
  // width / height of the video, from its metadata; portrait until known (see playerStyle).
  const [ratio, setRatio] = useState(DEFAULT_VIDEO_RATIO);

  // A <video> error gives no status code. The usual cause after a long pause is an EXPIRED media token (60 min),
  // so the first error re-reads the guide SILENTLY (fresh token) and resumes where it stopped; only a second
  // failure inside the window shows the error box. The steps stay on screen throughout.
  const onVideoError = () => {
    const now = Date.now();
    if (now - lastAutoRefresh.current > AUTO_REFRESH_WINDOW_MS) {
      lastAutoRefresh.current = now;
      resumeAt.current = videoRef.current?.currentTime ?? 0;
      void refresh().then((ok) => {
        if (!ok) setVideoFailed(true);
      });
      return;
    }
    setVideoFailed(true);
  };

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) setRatio(v.videoWidth / v.videoHeight);
    if (v && resumeAt.current > 0) {
      try {
        v.currentTime = resumeAt.current;
      } catch {
        /* seeking unsupported — start from the beginning */
      }
    }
    resumeAt.current = 0;
  };

  // "Retry" in the error box: fetch the guide again (fresh token) and show the player again.
  const retryVideo = async () => {
    setRetrying(true);
    lastAutoRefresh.current = Date.now(); // a failure right after a manual retry shows the box, no silent loop
    const ok = await refresh();
    setRetrying(false);
    if (ok) setVideoFailed(false);
  };

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
              key={load.data.videoUrl}
              ref={videoRef}
              data-testid="help-video"
              data-orientation={ratio < 1 ? 'portrait' : 'landscape'}
              className="block mx-auto rounded-2xl bg-black"
              style={playerStyle(ratio)}
              src={load.data.videoUrl}
              poster={load.data.posterUrl ?? undefined}
              controls
              playsInline
              preload="metadata"
              onError={onVideoError}
              onLoadedMetadata={onLoadedMetadata}
            />
          )}
          {load.data.videoUrl && videoFailed && (
            <div
              data-testid="help-video-error"
              role="status"
              className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              <VideoOff className="h-5 w-5 shrink-0" />
              <span className="flex-1">The video could not be loaded. Follow the steps below.</span>
              <button
                type="button"
                onClick={() => void retryVideo()}
                disabled={retrying}
                data-testid="help-video-retry"
                className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-amber-300 bg-white text-amber-900 disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" /> {retrying ? 'Retrying…' : 'Retry'}
              </button>
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
