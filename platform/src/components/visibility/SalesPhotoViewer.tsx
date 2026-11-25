'use client';

/**
 * Sales photo view (owner 2026-11-24) — the shared pieces the sales app uses to show THIS month's visibility capture
 * photos of an outlet in the manager's team. TENANT-SCOPED: the backend only sends photo data when the tenant lists the
 * caller's level in `visibilityConfig.salesPhotoViewLevels`; callers render these only when that data is present.
 *
 *   - PhotoStatusBadge          Approved ✓ / Needs re-take / Waiting (Not reviewed once the window has closed).
 *   - SalesPhotoThumbStrip      lazy-loaded thumbnails with a badge each, re-take reasons, "Submitted by X · time".
 *   - SalesPhotoLightbox        full-screen viewer: swipe (one finger) / arrow keys between photos, Esc + close button,
 *                               focus trap, body scroll lock, live photo counter, alt text = the photo label.
 *   - SalesCapturePhotosSheet   bottom sheet that loads one capture's photos on demand (loading skeleton, error +
 *                               Retry, "No photos in this capture") — the Visibility screen's "Photos".
 *
 * Never a broken image: a photo that fails to load shows a placeholder + "Photo couldn't load · Tap to retry".
 * Images are read through the auth-gated media stream (same as the admin review queue), never a public URL; the
 * stream lets the phone keep a short private copy, so the full view re-uses the thumbnail's download.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, Loader2, RefreshCw, X, AlertTriangle } from 'lucide-react';
import { visibilityApi, rewriteMediaViewPath } from '@/lib/visibility';
import { formatISTDateTime } from '@/lib/ist-date';
import type { SalesCapturePhoto, SalesCapturePhotos, SalesPhotoStatus } from '@/lib/visibility-types';

/* ─── Badge ──────────────────────────────────────────────────────────────────── */

type BadgeKey = SalesPhotoStatus | 'not_reviewed';

const BADGE: Record<BadgeKey, { label: string; cls: string }> = {
  approved: { label: 'Approved ✓', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  needs_retake: { label: 'Needs re-take', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  pending: { label: 'Waiting', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  not_reviewed: { label: 'Not reviewed', cls: 'bg-gray-50 text-gray-600 border-gray-200' },
};

/** A pending photo in a closed window was never reviewed — it is not "waiting" any more. */
function badgeKey(status: SalesPhotoStatus, windowClosed?: boolean): BadgeKey {
  return status === 'pending' && windowClosed ? 'not_reviewed' : status;
}

/** Plain badge words for a photo's review state. */
export function photoStatusLabel(s: SalesPhotoStatus, windowClosed?: boolean): string {
  return (BADGE[badgeKey(s, windowClosed)] ?? BADGE.pending).label;
}

export function PhotoStatusBadge({
  status, windowClosed, className = '',
}: { status: SalesPhotoStatus; windowClosed?: boolean; className?: string }) {
  const k = badgeKey(status, windowClosed);
  const b = BADGE[k] ?? BADGE.pending;
  return (
    <span
      data-testid={`photo-badge-${k}`}
      className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full border whitespace-nowrap ${b.cls} ${className}`}
    >
      {b.label}
    </span>
  );
}

function whoWhen(prefix: string, who: string | null | undefined, at: string | null | undefined): string {
  const when = formatISTDateTime(at);
  const name = who?.trim();
  if (name && when) return `${prefix} by ${name} · ${when}`;
  if (name) return `${prefix} by ${name}`;
  return when ? `${prefix} ${when}` : '';
}

/** "Submitted by Ravi · 3 Nov 2026, 10:31 am" (IST) — the CURRENT version; either half dropped when unknown. */
export function submittedByLine(data: Pick<SalesCapturePhotos, 'submittedBy' | 'submittedAt'>): string {
  return whoWhen('Submitted', data.submittedBy, data.submittedAt);
}

/** "Taken by Asha · 2 Nov 2026, 9:30 am" (IST) — THIS photo (a carried-forward photo keeps its own). */
export function takenByLine(p: Pick<SalesCapturePhoto, 'takenBy' | 'capturedAt'>): string {
  return whoWhen('Taken', p.takenBy, p.capturedAt);
}

/** Lock page scrolling while an overlay is open (restores the previous value on close). */
function useBodyScrollLock() {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
}

/* ─── Image with a never-broken fallback + tap to retry ──────────────────────── */

/**
 * A photo that never shows a broken image. Uncontrolled by default (its own "Tap to retry" button); a parent that
 * already wraps it in a button (the thumbnail strip) passes `failed` / `attempt` / `onFail` and handles the retry tap
 * itself, so no button is nested in a button.
 */
function SafeImage({
  photo, className, imgClassName, lazy, testId, showSpinner, failed: failedProp, attempt: attemptProp, onFail,
}: {
  photo: SalesCapturePhoto;
  className?: string;
  imgClassName?: string;
  lazy?: boolean;
  testId?: string;
  showSpinner?: boolean;
  failed?: boolean;
  attempt?: number;
  onFail?: () => void;
}) {
  const controlled = failedProp !== undefined;
  const [failedState, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attemptState, setAttempt] = useState(0);
  const failed = controlled ? failedProp : failedState;
  const attempt = controlled ? attemptProp ?? 0 : attemptState;
  const base = rewriteMediaViewPath(photo.viewPath);
  // A retry adds a cache-buster so the browser does not reuse the failed response.
  const src = attempt > 0 ? `${base}${base.includes('?') ? '&' : '?'}r=${attempt}` : base;

  if (failed) {
    const body = (
      <>
        <ImageOff className="h-5 w-5" aria-hidden="true" />
        <span className="text-[10px] font-medium leading-tight px-1">Photo couldn&apos;t load</span>
        <span className="text-[10px] font-semibold leading-tight px-1 text-[var(--brand-primary)]">Tap to retry</span>
      </>
    );
    const cls = `flex flex-col items-center justify-center gap-1 bg-gray-100 text-gray-500 text-center ${className ?? ''}`;
    if (controlled) {
      return <span data-testid={testId ? `${testId}-error` : undefined} className={cls}>{body}</span>;
    }
    return (
      <button
        type="button"
        data-testid={testId ? `${testId}-error` : undefined}
        aria-label={`${photo.label} — photo couldn't load. Tap to retry`}
        onClick={(e) => { e.stopPropagation(); setFailed(false); setLoaded(false); setAttempt((n) => n + 1); }}
        className={cls}
      >
        {body}
      </button>
    );
  }
  return (
    <span className="relative inline-flex items-center justify-center max-h-full max-w-full">
      {showSpinner && !loaded && (
        <Loader2
          data-testid={testId ? `${testId}-loading` : undefined}
          className="absolute h-7 w-7 animate-spin text-white/80"
          aria-hidden="true"
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={attempt}
        data-testid={testId}
        src={src}
        alt={photo.label}
        loading={lazy ? 'lazy' : undefined}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => { if (controlled) onFail?.(); else setFailed(true); }}
        className={`${className ?? ''} ${imgClassName ?? ''}`}
      />
    </span>
  );
}

/* ─── Thumbnail strip ────────────────────────────────────────────────────────── */

/**
 * One capture's thumbnails (horizontal strip, lazy-loaded), each with its badge; the re-take reason(s) under the strip
 * (a whole-capture reason once); who submitted the current version and when. Tapping a thumbnail calls `onOpen(index)`.
 */
export function SalesPhotoThumbStrip({
  data, onOpen, testId = 'photo-strip',
}: { data: SalesCapturePhotos; onOpen: (index: number) => void; testId?: string }) {
  // Per-thumbnail load failure + retry count (the thumbnail button retries a failed photo instead of opening it).
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  if (data.photos.length === 0) {
    return <p className="text-[11px] text-gray-500" data-testid={`${testId}-empty`}>No photos in this capture</p>;
  }
  const line = submittedByLine(data);
  const reasons = data.photos.filter((p) => p.status === 'needs_retake' && p.reason);
  return (
    <div data-testid={testId} className="space-y-1.5">
      <ul className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" aria-label="Visibility photos">
        {data.photos.map((p, i) => (
          <li key={p.fieldId} className="shrink-0 w-20">
            <button
              type="button"
              onClick={() => {
                if (failed[p.fieldId]) {
                  setFailed((f) => ({ ...f, [p.fieldId]: false }));
                  setAttempts((a) => ({ ...a, [p.fieldId]: (a[p.fieldId] ?? 0) + 1 }));
                } else onOpen(i);
              }}
              aria-label={
                failed[p.fieldId]
                  ? `${p.label} — photo couldn't load. Tap to retry`
                  : `Open photo: ${p.label} (${photoStatusLabel(p.status, data.windowClosed)})`
              }
              className="block w-20 rounded-lg overflow-hidden border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
            >
              <SafeImage
                photo={p}
                lazy
                className="w-20 h-20"
                imgClassName="object-cover"
                testId={`thumb-${p.fieldId}`}
                failed={!!failed[p.fieldId]}
                attempt={attempts[p.fieldId] ?? 0}
                onFail={() => setFailed((f) => ({ ...f, [p.fieldId]: true }))}
              />
            </button>
            <PhotoStatusBadge status={p.status} windowClosed={data.windowClosed} className="mt-1" />
            <p className="text-[10px] text-gray-500 truncate mt-0.5" title={p.label}>{p.label}</p>
          </li>
        ))}
      </ul>
      {data.captureReason && (
        <p className="text-[11px] text-orange-700" data-testid={`${testId}-capture-reason`}>
          Re-take needed: {data.captureReason}
        </p>
      )}
      {reasons.map((p) => (
        <p key={p.fieldId} className="text-[11px] text-orange-700" data-testid={`photo-reason-${p.fieldId}`}>
          {p.label}: {p.reason}
        </p>
      ))}
      {line && <p className="text-[11px] text-gray-500" data-testid={`${testId}-by`}>{line}</p>}
    </div>
  );
}

/* ─── Full-screen viewer ─────────────────────────────────────────────────────── */

const FENCE_WORDS: Record<string, string> = {
  inside: 'At the outlet',
  outside: 'Away from the outlet',
  unverifiable: "Location couldn't be verified",
};

/** Tab-cycles focus inside `root` (a minimal focus trap). */
function trapTab(e: React.KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== 'Tab' || !root) return;
  const els = Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
  );
  if (els.length === 0) return;
  const first = els[0];
  const last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * Full-screen photo viewer. One-finger swipe left / right (or ← / →, or the arrow buttons) between photos — a
 * two-finger pinch never moves to another photo; Esc or the close button closes. Focus is moved into the dialog on
 * open, kept inside it, and handed back to the opener on close; the page behind does not scroll.
 */
export function SalesPhotoLightbox({
  photos, index, onIndexChange, onClose, windowClosed, captureReason,
}: {
  photos: SalesCapturePhoto[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  windowClosed?: boolean;
  captureReason?: string | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchX = useRef<number | null>(null);
  const multiTouch = useRef(false);
  const count = photos.length;
  const safeIndex = Math.min(Math.max(index, 0), Math.max(count - 1, 0));
  const photo = photos[safeIndex];
  useBodyScrollLock();

  const go = useCallback(
    (delta: number) => {
      if (count < 2) return;
      onIndexChange((safeIndex + delta + count) % count);
    },
    [count, safeIndex, onIndexChange],
  );

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { try { opener?.focus?.(); } catch { /* opener gone */ } };
  }, []);

  if (!photo) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); return; }
    trapTab(e, rootRef.current);
  };

  const taken = takenByLine(photo);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Photo viewer: ${photo.label}`}
      data-testid="photo-lightbox"
      onKeyDown={onKeyDown}
      onTouchStart={(e) => {
        if (e.touches.length > 1) { multiTouch.current = true; touchX.current = null; return; }
        multiTouch.current = false;
        touchX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchMove={(e) => { if (e.touches.length > 1) { multiTouch.current = true; touchX.current = null; } }}
      onTouchEnd={(e) => {
        const start = touchX.current;
        // A pinch (any multi-touch during the gesture) or a finger still down → never a swipe.
        if (multiTouch.current || e.touches.length > 0) {
          if (e.touches.length === 0) multiTouch.current = false;
          touchX.current = null;
          return;
        }
        touchX.current = null;
        const end = e.changedTouches[0]?.clientX;
        if (start == null || end == null) return;
        const dx = end - start;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
      }}
      className="fixed inset-0 z-[70] bg-black/95 flex flex-col overscroll-contain"
    >
      <div
        className="flex items-center gap-2 px-4 pb-3 text-white"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <p className="flex-1 min-w-0 text-sm font-semibold truncate" aria-live="polite" data-testid="photo-lightbox-label">
          {photo.label}
        </p>
        <span className="text-xs text-white/70" aria-live="polite" data-testid="photo-lightbox-counter">
          {safeIndex + 1} / {count}
        </span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          className="p-2 -mr-2 rounded-full hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="relative flex-1 min-h-0 flex items-center justify-center px-2" style={{ touchAction: 'pan-y pinch-zoom' }}>
        <SafeImage
          key={photo.fieldId}
          photo={photo}
          className="max-h-full max-w-full rounded-md text-white"
          imgClassName="object-contain"
          testId="photo-lightbox-img"
          showSpinner
        />
        {count > 1 && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label="Previous photo"
              className="absolute left-1 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white focus:outline-none focus:ring-2 focus:ring-white">
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button type="button" onClick={() => go(1)} aria-label="Next photo"
              className="absolute right-1 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white focus:outline-none focus:ring-2 focus:ring-white">
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        )}
      </div>
      <div className="px-4 pt-3 space-y-1 text-white" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <PhotoStatusBadge status={photo.status} windowClosed={windowClosed} />
          {photo.fenceStatus && (
            <span className="text-[11px] text-white/80" data-testid="photo-lightbox-fence">{FENCE_WORDS[photo.fenceStatus] ?? ''}</span>
          )}
        </div>
        {photo.status === 'needs_retake' && (photo.reason || captureReason) && (
          <p className="text-xs text-orange-200" data-testid="photo-lightbox-reason">Reason: {photo.reason || captureReason}</p>
        )}
        {taken && <p className="text-[11px] text-white/70" data-testid="photo-lightbox-taken">{taken}</p>}
      </div>
    </div>
  );
}

/* ─── On-demand bottom sheet (Visibility screen) ─────────────────────────────── */

/**
 * Loads ONE capture's photos on demand (GET sales/captures/:id/photos) and shows them as a thumbnail strip in a bottom
 * sheet; a tap opens the full-screen viewer. States: loading skeleton · error + Retry · "No photos in this capture".
 */
export function SalesCapturePhotosSheet({
  captureId, outletName, onClose,
}: { captureId: string; outletName: string; onClose: () => void }) {
  const [data, setData] = useState<SalesCapturePhotos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useBodyScrollLock();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    visibilityApi
      .getSalesCapturePhotos(captureId)
      .then((r) => {
        if (cancelled) return;
        if (r.success) setData(r.data);
        else setError(r.error || "Couldn't load the photos.");
      })
      .catch(() => { if (!cancelled) setError("Couldn't load the photos."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [captureId, attempt]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { try { opener?.focus?.(); } catch { /* opener gone */ } };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (viewer !== null) return; // the viewer handles its own keys
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    trapTab(e, rootRef.current);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" data-testid="photos-sheet">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Visibility photos — ${outletName}`}
        onKeyDown={onKeyDown}
        className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl p-4 pb-6 max-h-[85vh] overflow-y-auto overscroll-contain"
      >
        <div className="flex items-center gap-2 mb-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-gray-900 truncate">{outletName}</p>
            <p className="text-[11px] text-gray-500">This month&apos;s visibility photos</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close photos"
            className="p-2 -mr-2 rounded-full hover:bg-gray-100 text-gray-500 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex gap-2" data-testid="photos-sheet-loading" aria-busy="true" aria-label="Loading photos">
            {[0, 1, 2].map((i) => <div key={i} className="w-20 h-20 rounded-lg bg-gray-100 animate-pulse" />)}
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-2" data-testid="photos-sheet-error">
            <p className="text-xs text-red-600 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" />{error}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}
              className="flex items-center gap-1.5 text-xs font-semibold text-[var(--brand-primary)] hover:underline">
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        ) : !data || data.photos.length === 0 ? (
          <p className="text-xs text-gray-500" data-testid="photos-sheet-empty">No photos in this capture</p>
        ) : (
          <SalesPhotoThumbStrip data={data} onOpen={setViewer} testId="photos-sheet-strip" />
        )}
      </div>
      {viewer !== null && data && (
        <SalesPhotoLightbox
          photos={data.photos}
          index={viewer}
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
          windowClosed={data.windowClosed}
          captureReason={data.captureReason}
        />
      )}
    </div>
  );
}
