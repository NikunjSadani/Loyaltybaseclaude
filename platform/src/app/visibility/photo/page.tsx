'use client';

/**
 * Visibility photo viewer — the target of the Visibility Excel report's "Open photo" links
 * (`https://<tenant host>/visibility/photo?key=<object key>`).
 *
 * A signed-in page that renders for ANY signed-in role (see lib/visibility-photo-link.ts): a signed-out click is sent
 * to sign-in with `next` and lands back here; a role / tenant without access reads "You don't have access". The image is
 * read from the role-gated `/api/visibility/captures/media?key=` (the backend pins every non-Gifsy caller to its own
 * tenant), shown full-width, with a Download link and a plain error for "no access" / "not found".
 */
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Download, ImageOff, Loader2, Lock } from 'lucide-react';
import { visibilityPhotoMediaUrl } from '@/lib/visibility-photo-link';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; fileName: string }
  | { kind: 'error'; title: string; detail: string; icon: 'lock' | 'missing' };

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' };

/** A friendly download name from the object key's last segment (falls back to photo.<ext>). */
function fileNameFor(key: string, contentType: string): string {
  const last = key.split('/').pop() ?? '';
  if (/^[\w.-]{1,120}$/.test(last) && last.includes('.')) return last;
  return `photo.${EXT[contentType.split(';')[0].trim()] ?? 'jpg'}`;
}

function errorFor(status: number): State {
  if (status === 403) {
    return { kind: 'error', icon: 'lock', title: "You don't have access to this photo", detail: 'Sign in with an account of this programme that can view visibility photos.' };
  }
  if (status === 401) {
    return { kind: 'error', icon: 'lock', title: 'Your session has ended', detail: 'Reload this page to sign in again, then the photo will open.' };
  }
  if (status === 400 || status === 404) {
    return { kind: 'error', icon: 'missing', title: 'Photo not found', detail: 'This photo is no longer available, or the link is incomplete.' };
  }
  return { kind: 'error', icon: 'missing', title: 'The photo could not be loaded', detail: 'Please try again in a moment.' };
}

function PhotoViewer() {
  const params = useSearchParams();
  const key = (params.get('key') ?? '').trim();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [cantDisplay, setCantDisplay] = useState(false);

  useEffect(() => {
    if (!key) {
      setState({ kind: 'error', icon: 'missing', title: 'Photo not found', detail: 'This link is incomplete — it does not say which photo to open.' });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: 'loading' });
    setCantDisplay(false);
    (async () => {
      try {
        const res = await fetch(visibilityPhotoMediaUrl(key), { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) setState(errorFor(res.status));
          return;
        }
        const contentType = res.headers.get('content-type') ?? '';
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ kind: 'ready', url: objectUrl, fileName: fileNameFor(key, contentType) });
      } catch {
        if (!cancelled) setState(errorFor(0));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, attempt]);

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-base font-semibold text-gray-900 sm:text-lg">Visibility photo</h1>
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
            <span className="sr-only">Loading photo</span>
          </div>
        )}

        {state.kind === 'ready' && !cantDisplay && (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element -- a same-origin blob: URL of an auth-gated object */}
            <img src={state.url} alt="Visibility photo" className="block h-auto w-full" onError={() => setCantDisplay(true)} />
          </div>
        )}

        {state.kind === 'ready' && cantDisplay && (
          <div role="alert" className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center">
            <ImageOff className="mx-auto mb-3 h-8 w-8 text-gray-300" aria-hidden="true" />
            <p className="text-sm font-semibold text-gray-900">This photo can&apos;t be displayed in the browser</p>
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
            {state.title === 'Your session has ended' ? (
              <button type="button" onClick={() => window.location.reload()} className="mt-4 text-sm text-[var(--brand-primary)] hover:underline">
                Reload
              </button>
            ) : state.title === 'The photo could not be loaded' ? (
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

export default function VisibilityPhotoPage() {
  return (
    <Suspense fallback={null}>
      <PhotoViewer />
    </Suspense>
  );
}
