'use client';

/**
 * Shared signed-in media viewer — the body of the pages behind the Excel reports' "Open photo" / "Open file" links:
 *   - /visibility/photo?key=…  (Visibility report)            → app/visibility/photo/page.tsx
 *   - /schemes/photo?key=…     (Scheme enrollment export)     → app/schemes/photo/page.tsx
 *
 * A normal signed-in PAGE (never public): the edge proxy renews the session or sends the person to sign in with
 * `next` (return-to.ts brings every role back here). The bytes come from a role-gated, tenant-pinned media endpoint
 * (`mediaUrl(key)`); this page only maps its answer to plain words: 403 → "You don't have access", 404 → "not found",
 * 401 → "session ended" (Reload). An image the browser cannot render (e.g. HEIC) → "can't be displayed" + Download;
 * a PDF ALWAYS gets an "Open PDF" button (a blob: frame is blank on Android / iOS) and is embedded in a frame only on
 * a desktop-width screen — never a blank frame on a phone.
 */
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Download, ExternalLink, FileText, ImageOff, Loader2, Lock } from 'lucide-react';

/** Desktop width at which a PDF is also embedded in a frame (mobile browsers render a blob: PDF frame blank). */
export const PDF_EMBED_MIN_WIDTH = '(min-width: 1024px)';

export interface MediaViewerConfig {
  /** Page heading, e.g. "Visibility photo". */
  heading: string;
  /** "photo" or "file" — used in every message ("Photo not found", "this file"). */
  noun: 'photo' | 'file';
  /** Alt text of the <img>. */
  alt: string;
  /** Detail line under "You don't have access to this …". */
  noAccessDetail: string;
  /** Browser URL of the role-gated media stream for a stored object key. */
  mediaUrl: (key: string) => string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; fileName: string; isPdf: boolean; contentType: string }
  | { kind: 'error'; title: string; detail: string; icon: 'lock' | 'missing'; action?: 'reload' | 'retry' };

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A friendly download name from the object key's last segment (falls back to photo.<ext> / file.<ext>). */
export function mediaFileNameFor(key: string, contentType: string, noun: 'photo' | 'file' = 'photo'): string {
  const last = key.split('/').pop() ?? '';
  if (/^[\w.-]{1,120}$/.test(last) && last.includes('.')) return last;
  return `${noun}.${EXT[contentType.split(';')[0].trim()] ?? (noun === 'file' ? 'bin' : 'jpg')}`;
}

function errorFor(status: number, cfg: MediaViewerConfig): State {
  const n = cfg.noun;
  if (status === 403) {
    return { kind: 'error', icon: 'lock', title: `You don't have access to this ${n}`, detail: cfg.noAccessDetail };
  }
  if (status === 401) {
    return { kind: 'error', icon: 'lock', title: 'Your session has ended', detail: `Reload this page to sign in again, then the ${n} will open.`, action: 'reload' };
  }
  if (status === 400 || status === 404) {
    return { kind: 'error', icon: 'missing', title: `${cap(n)} not found`, detail: `This ${n} is no longer available, or the link is incomplete.` };
  }
  return { kind: 'error', icon: 'missing', title: `The ${n} could not be loaded`, detail: 'Please try again in a moment.', action: 'retry' };
}

/**
 * A fixed config, or one derived from the key and — once loaded — the response's content type (so the heading says
 * "file" for a PDF even when its key has no / a wrong extension; before loading, only the key is known).
 */
export type MediaViewerConfigInput = MediaViewerConfig | ((key: string, contentType: string | null) => MediaViewerConfig);

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}

function Viewer({ config }: { config: MediaViewerConfigInput }) {
  const params = useSearchParams();
  const key = (params.get('key') ?? '').trim();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [cantDisplay, setCantDisplay] = useState(false);
  const wide = useMediaQuery(PDF_EMBED_MIN_WIDTH);
  const cfgFor = (ct: string | null) => (typeof config === 'function' ? config(key, ct) : config);
  const cfg = cfgFor(state.kind === 'ready' ? state.contentType : null);
  const { mediaUrl, noun } = cfg;

  useEffect(() => {
    if (!key) {
      setState({ kind: 'error', icon: 'missing', title: `${cap(noun)} not found`, detail: `This link is incomplete — it does not say which ${noun} to open.` });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: 'loading' });
    setCantDisplay(false);
    (async () => {
      try {
        const res = await fetch(mediaUrl(key), { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) setState(errorFor(res.status, cfg));
          return;
        }
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({
          kind: 'ready',
          url: objectUrl,
          fileName: mediaFileNameFor(key, contentType, cfgFor(contentType).noun),
          isPdf: contentType.startsWith('application/pdf'),
          contentType,
        });
      } catch {
        if (!cancelled) setState(errorFor(0, cfg));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // cfg is derived from the module-level page config + key; key/attempt drive reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-base font-semibold text-gray-900 sm:text-lg">{cfg.heading}</h1>
          {state.kind === 'ready' && (
            <a
              href={state.url}
              download={state.fileName}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--brand-primary-dark)]"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download
            </a>
          )}
        </div>

        {state.kind === 'loading' && (
          <div className="flex items-center justify-center rounded-xl border border-gray-200 bg-white py-24" role="status">
            <Loader2 className="h-6 w-6 animate-spin text-gray-300" aria-hidden="true" />
            <span className="sr-only">Loading {noun}</span>
          </div>
        )}

        {state.kind === 'ready' && state.isPdf && (
          <div className="space-y-3">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-gray-200 bg-white px-6 py-8 text-center">
              <FileText className="h-8 w-8 text-gray-300" aria-hidden="true" />
              <p className="text-sm font-semibold text-gray-900">PDF document</p>
              <a
                href={state.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--brand-primary)] px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-gray-50"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                Open PDF
              </a>
              <p className="text-xs text-gray-500">If it does not open on your phone, use Download.</p>
            </div>
            {wide && (
              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                <iframe src={state.url} title={cfg.alt} className="block h-[80vh] w-full" />
              </div>
            )}
          </div>
        )}

        {state.kind === 'ready' && !state.isPdf && !cantDisplay && (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element -- a same-origin blob: URL of an auth-gated object */}
            <img src={state.url} alt={cfg.alt} className="block h-auto w-full" onError={() => setCantDisplay(true)} />
          </div>
        )}

        {state.kind === 'ready' && !state.isPdf && cantDisplay && (
          <div role="alert" className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center">
            <ImageOff className="mx-auto mb-3 h-8 w-8 text-gray-300" aria-hidden="true" />
            <p className="text-sm font-semibold text-gray-900">This {noun} can&apos;t be displayed in the browser</p>
            <p className="mt-1 text-sm text-gray-500">
              Use{' '}
              <a href={state.url} download={state.fileName} className="text-[var(--brand-primary)] hover:underline">
                Download
              </a>{' '}
              to open it on your device.
            </p>
          </div>
        )}

        {state.kind === 'error' && (
          <div role="alert" className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center">
            {state.icon === 'lock' ? (
              <Lock className="mx-auto mb-3 h-8 w-8 text-gray-300" aria-hidden="true" />
            ) : (
              <ImageOff className="mx-auto mb-3 h-8 w-8 text-gray-300" aria-hidden="true" />
            )}
            <p className="text-sm font-semibold text-gray-900">{state.title}</p>
            <p className="mt-1 text-sm text-gray-500">{state.detail}</p>
            {state.action === 'reload' ? (
              <button type="button" onClick={() => window.location.reload()} className="mt-4 text-sm text-[var(--brand-primary)] hover:underline">
                Reload
              </button>
            ) : state.action === 'retry' ? (
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mt-4 text-sm text-[var(--brand-primary)] hover:underline">
                Try again
              </button>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}

export default function SignedInMediaViewer({ cfg }: { cfg: MediaViewerConfigInput }) {
  return (
    <Suspense fallback={null}>
      <Viewer config={cfg} />
    </Suspense>
  );
}
