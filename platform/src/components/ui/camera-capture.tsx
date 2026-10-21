'use client';

/**
 * CameraCapture — a TRUE in-app live camera (getUserMedia) capture control.
 *
 * Unlike `<input type="file" capture>` (which, on desktop and some mobile browsers,
 * silently falls back to the device GALLERY), this component opens the camera stream
 * directly and lets the user shoot a frame — there is deliberately NO gallery fallback.
 * It is self-contained and reusable; the capture produces a JPEG `File` handed to
 * `onCapture`, so a parent can wire it into the exact same upload/validation path a
 * file input's `onChange` used.
 *
 * ── Tap-to-open + single-active lock ──
 * A single camera device can serve only ONE getUserMedia stream at a time. A visibility
 * sheet can show TWO camera fields at once (a sub-program conditional 2nd photo), so the
 * stream is NOT opened on mount: the field shows an "Open camera" button and only opens on
 * tap. A module-level `activeRelease` ensures opening one camera first CLOSES any other —
 * so two camera fields can never contend for the device.
 *
 * Shape copied from the proven KYC camera (`app/sales/kyc/new/page.tsx`): a `streamRef`
 * holding the live `MediaStream`, `getUserMedia({ video: { facingMode, … } })`, a live
 * `<video autoPlay playsInline muted>` preview, a canvas-draw → `toBlob` capture, and a
 * cleanup that stops EVERY track so the camera light never stays on.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, Loader2, RefreshCw } from 'lucide-react';

export interface CameraCaptureProps {
  /** Called with the captured JPEG File (one per shutter press). */
  onCapture: (file: File) => void;
  /** When true the stream is torn down and controls are inert (e.g. parent is uploading). */
  disabled?: boolean;
  /** Which camera to prefer; defaults to the rear/environment camera. */
  facingMode?: 'environment' | 'user';
  /** Prefix for the data-testid hooks (`<prefix>-video`, `<prefix>-capture`, …). */
  testIdPrefix?: string;
  'aria-label'?: string;
}

type CamError = 'denied' | 'notfound' | 'busy' | null;

/**
 * Module-level single-active-camera lock. Holds the `release` of the currently-open
 * CameraCapture; opening another calls it first so only ONE getUserMedia stream is ever
 * live (two camera fields on one sheet can't contend for the single device).
 */
let activeRelease: (() => void) | null = null;

function tid(prefix: string | undefined, suffix: string): string | undefined {
  return prefix ? `${prefix}-${suffix}` : undefined;
}

export function CameraCapture({
  onCapture,
  disabled = false,
  facingMode = 'environment',
  testIdPrefix,
  'aria-label': ariaLabel,
}: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const [facing, setFacing] = useState<'environment' | 'user'>(facingMode);
  // Tap-to-open: the stream is NOT opened until the user taps "Open camera" (anti-contention).
  const [opened, setOpened] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [error, setError] = useState<CamError>(null);
  // Transient capture failure (e.g. toBlob returned null) — shown over the LIVE preview so the
  // user can simply press Capture again; it does NOT tear the stream down.
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Bumped on Retry to force the open effect to re-run after a permission/busy error.
  const [retryTick, setRetryTick] = useState(0);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const revokePreview = useCallback(() => {
    if (previewUrlRef.current) {
      try { URL.revokeObjectURL(previewUrlRef.current); } catch { /* ignore */ }
      previewUrlRef.current = null;
    }
  }, []);

  // Stable `release` for the module lock (identity must survive re-renders so the ===-checks hold).
  const releaseRef = useRef<(() => void) | null>(null);
  if (!releaseRef.current) {
    releaseRef.current = () => { setOpened(false); setError(null); };
  }
  const clearLockIfOurs = useCallback(() => {
    if (activeRelease === releaseRef.current) activeRelease = null;
  }, []);

  // The live stream is open only while the user has opened it and we want it.
  const wantStream = opened && !captured && !disabled;

  // ── Open / close the live stream (mirrors the KYC camera effect) ──────────────
  useEffect(() => {
    if (!wantStream) {
      stopStream();
      return;
    }
    // Not supported at all (no secure context / old WebView) → "no camera" state.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('notfound');
      return;
    }

    let active = true;
    setError(null);
    setStarting(true);
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // play() returns a Promise in modern browsers but `undefined` in some older ones —
          // guard before calling .catch so the happy path never throws.
          const played = videoRef.current.play?.();
          if (played && typeof played.catch === 'function') played.catch(() => { /* autoplay guard */ });
        }
      } catch (err) {
        if (!active) return;
        const name = (err as { name?: string } | null)?.name;
        // NotReadableError / TrackStartError / AbortError → the device is busy (held by another
        // photo/app), NOT a permission problem. NotFoundError / OverconstrainedError → no usable
        // camera. Everything else (NotAllowedError / SecurityError / dismissed) → access denied.
        setError(
          name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError'
            ? 'busy'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'notfound'
              : 'denied',
        );
      } finally {
        if (active) setStarting(false);
      }
    })();

    return () => {
      active = false;
      stopStream();
    };
  }, [wantStream, facing, retryTick, stopStream]);

  // Final safety net: stop the camera + drop the module lock on unmount.
  useEffect(() => () => { stopStream(); revokePreview(); clearLockIfOurs(); }, [stopStream, revokePreview, clearLockIfOurs]);

  // Tap-to-open: close any OTHER open camera first, claim the lock, then open ours.
  const openCamera = useCallback(() => {
    if (activeRelease && activeRelease !== releaseRef.current) activeRelease();
    activeRelease = releaseRef.current;
    setCaptureError(null);
    setError(null);
    setCaptured(false);
    setOpened(true);
  }, []);

  const handleCapture = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCaptureError(null);
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setCaptureError("Couldn't capture the photo — please try again."); return; }
    ctx.drawImage(video, 0, 0, w, h);

    const finish = (blob: Blob) => {
      const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
      // Freeze to the still FIRST (stops the stream via the effect + releases the lock), then
      // hand the file up.
      revokePreview();
      let url = '';
      try { url = URL.createObjectURL(blob); } catch { url = ''; }
      previewUrlRef.current = url || null;
      setPreviewUrl(url);
      setCaptured(true);
      clearLockIfOurs();
      onCapture(file);
    };

    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        (blob) => {
          // A null blob (encoder failure / canvas too large) must NOT be a silent no-op —
          // surface a recoverable error so the user can retry the shutter.
          if (blob) finish(blob);
          else setCaptureError("Couldn't capture the photo — please try again.");
        },
        'image/jpeg',
        0.9,
      );
    } else {
      setCaptureError("Photo capture isn't supported in this browser.");
    }
  }, [onCapture, revokePreview, clearLockIfOurs]);

  const handleRetake = useCallback(() => {
    revokePreview();
    setPreviewUrl('');
    setCaptureError(null);
    setError(null);
    // Re-open (re-claims the lock, closing any other that opened meanwhile).
    openCamera();
  }, [revokePreview, openCamera]);

  const handleRetry = useCallback(() => {
    setError(null);
    setRetryTick((t) => t + 1);
    openCamera();
  }, [openCamera]);

  const toggleFacing = useCallback(() => {
    setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
  }, []);

  const frameCls =
    'relative w-full overflow-hidden rounded-xl border border-gray-200 bg-black aspect-[4/3]';

  // ── Captured still + Retake ───────────────────────────────────────────────────
  if (captured) {
    return (
      <div className="space-y-2" data-testid={tid(testIdPrefix, 'captured')}>
        <div className={frameCls}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={ariaLabel ? `${ariaLabel} — captured` : 'Captured photo'}
              className="h-full w-full object-cover"
              data-testid={tid(testIdPrefix, 'still')}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-white/70">
              Photo captured
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handleRetake}
          disabled={disabled}
          data-testid={tid(testIdPrefix, 'retake')}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed border-gray-200 text-sm text-gray-500 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] disabled:opacity-50 transition-colors"
        >
          <RefreshCw className="h-4 w-4" /> Retake
        </button>
      </div>
    );
  }

  // ── Error states (no gallery fallback — camera is the only path) ──────────────
  if (error) {
    const message =
      error === 'denied'
        ? 'Camera access is required — allow camera permission and retry.'
        : error === 'busy'
          ? 'The camera is in use by another photo or app — finish or close that one, then retry.'
          : 'No camera is available on this device or browser.';
    // 'denied' and 'busy' are recoverable (retry); 'notfound' may be a missing device OR an
    // insecure/unsupported context — still offer Retry (it's harmless and often a WebView gate).
    return (
      <div
        className="space-y-2 rounded-xl border border-red-200 bg-red-50 px-3 py-3"
        data-testid={tid(testIdPrefix, 'error')}
        role="alert"
      >
        <p className="flex items-start gap-1.5 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500 mt-0.5" />
          {message}
        </p>
        <button
          type="button"
          onClick={handleRetry}
          disabled={disabled}
          data-testid={tid(testIdPrefix, 'retry')}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-[var(--brand-primary)] text-white text-sm font-medium hover:bg-[var(--brand-primary-dark)] disabled:opacity-50 transition-colors"
        >
          <RefreshCw className="h-4 w-4" /> Retry
        </button>
      </div>
    );
  }

  // ── Not opened yet → tap-to-open (keeps only one live stream across camera fields) ──
  if (!opened) {
    return (
      <button
        type="button"
        onClick={openCamera}
        disabled={disabled}
        data-testid={tid(testIdPrefix, 'open')}
        aria-label={ariaLabel ? `Open camera for ${ariaLabel}` : 'Open camera'}
        className={`${frameCls} flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-300 bg-gray-50 text-gray-500 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] disabled:opacity-50 transition-colors`}
      >
        <Camera className="h-7 w-7" />
        <span className="text-sm font-medium">Open camera</span>
      </button>
    );
  }

  // ── Live preview + shutter ────────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      <div className={frameCls}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          aria-label={ariaLabel ?? 'Camera preview'}
          data-testid={tid(testIdPrefix, 'video')}
          className="h-full w-full object-cover"
          style={facing === 'user' ? { transform: 'scaleX(-1)' } : undefined}
        />
        {starting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="h-6 w-6 animate-spin text-white" />
          </div>
        )}
        {/* Switch-camera (optional) */}
        <button
          type="button"
          onClick={toggleFacing}
          disabled={disabled}
          aria-label="Switch camera"
          data-testid={tid(testIdPrefix, 'switch')}
          className="absolute top-2 right-2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
      {captureError && (
        <p className="flex items-center gap-1.5 text-xs text-red-600" role="alert" data-testid={tid(testIdPrefix, 'capture-error')}>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {captureError}
        </p>
      )}
      <button
        type="button"
        onClick={handleCapture}
        disabled={disabled || starting}
        aria-label={ariaLabel ? `Capture ${ariaLabel}` : 'Capture photo'}
        data-testid={tid(testIdPrefix, 'capture')}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[var(--brand-primary)] text-white text-sm font-semibold hover:bg-[var(--brand-primary-dark)] active:scale-[0.98] disabled:opacity-50 transition-all"
      >
        <Camera className="h-4 w-4" /> Capture
      </button>
    </div>
  );
}

export default CameraCapture;
