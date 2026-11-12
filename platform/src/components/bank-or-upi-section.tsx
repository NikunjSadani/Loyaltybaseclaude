'use client';

import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { CreditCard, Smartphone, QrCode, StopCircle, X, CheckCircle } from 'lucide-react';
import { parseUpiFromQr } from '@/lib/upi-utils';
import { getGifsySettings } from '@/lib/gifsy-settings';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

export type PaymentMode = 'bank' | 'upi';

/** How a UPI ID was captured — QR scan vs typed by hand (VPA-safeguards provenance). */
export type UpiCaptureMethod = 'QR' | 'MANUAL';

export interface BankOrUpiSectionProps {
  /** Controlled mode — parent decides which panel is active */
  paymentMode:          PaymentMode;
  onPaymentModeChange:  (mode: PaymentMode) => void;

  /**
   * Per-outlet payout MANDATE pin. When set, the Bank/UPI toggle is HIDDEN and the panel
   * is FORCED to this mode (the rep cannot change it) — wins over the tenant UPI gate.
   * Omitted → the rep chooses (subject to the tenant UPI gate below). The parent derives
   * this from the outlet's requiredPaymentType via `pinnedPaymentMode`.
   */
  lockedMode?: PaymentMode;

  /** Bank fields (controlled) */
  bankName:           string;
  accountHolderName:  string;
  accountNumber:      string;
  ifscCode:           string;
  onFieldChange: (field: 'bankName' | 'accountHolderName' | 'accountNumber' | 'ifscCode') =>
    React.ChangeEventHandler<HTMLInputElement>;

  /**
   * UPI field (controlled).
   * In UPI mode this is populated via QR scan, plus manual text entry when the tenant's
   * salesApp.upiManualEntry flag is ON. Call onUpiChange('') to clear a previously-scanned ID.
   */
  upiId:       string;
  onUpiChange: (value: string) => void;

  /**
   * Optional: reports HOW the current UPI ID was captured, so the parent can send
   * `upiCaptureMethod` with the submit body. 'QR' after a successful scan, 'MANUAL' when
   * the rep/partner types into the manual input, null when the value is cleared.
   * Omitted → no-op (callers that don't track provenance are unaffected).
   */
  onUpiCaptureMethodChange?: (method: UpiCaptureMethod | null) => void;

  /**
   * Per-field lock set (re-KYC locked-edit mode): any bank field whose key is
   * present is rendered disabled + read-only. Pre-filled values stay visible.
   * Omitted / empty → all editable (the normal case).
   */
  disabledFields?: Partial<Record<'bankName' | 'accountHolderName' | 'accountNumber' | 'ifscCode' | 'upiId', boolean>>;

  /**
   * Called when a payment geo capture should be triggered in the parent.
   * Fires after a successful QR scan (the scan = the presence-at-outlet moment).
   * For cheque upload the parent triggers geo directly in handleFileSelect.
   */
  onPaymentGeoTrigger?: () => void;

  /**
   * Optional: whether a payment geo (presence-at-outlet moment) has ALREADY been captured
   * for the current UPI ID. Seeds the manual-entry fire-once geo guard at mount:
   * true → editing the existing value does not re-fire geo; false → the first keystroke
   * fires geo even when a UPI ID was pre-filled (e.g. a parent-prefilled child outlet that
   * has no payment geo of its own yet). Omitted → falls back to "a UPI ID is present at mount".
   * An EMPTY UPI ID is always a fresh entry (the guard re-arms whenever upiId is empty), so
   * this only changes behaviour when a UPI ID is present at mount.
   */
  paymentGeoCaptured?: boolean;

  /**
   * Slot for the Cancelled Cheque upload card (rendered only in bank mode).
   * Pass the `<FileUploadCard>` element from the parent page.
   */
  children?: React.ReactNode;
}

/* ─── Shared class strings ───────────────────────────────────────────────────── */

const inputCls =
  'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 ' +
  'focus:border-[var(--brand-primary)] bg-white';

const labelCls = 'text-xs font-medium text-gray-600 block mb-1';

/* ─── Component ──────────────────────────────────────────────────────────────── */

export function BankOrUpiSection({
  paymentMode,
  onPaymentModeChange,
  lockedMode,
  bankName,
  accountHolderName,
  accountNumber,
  ifscCode,
  onFieldChange,
  upiId,
  onUpiChange,
  onUpiCaptureMethodChange,
  onPaymentGeoTrigger,
  paymentGeoCaptured,
  disabledFields,
  children,
}: BankOrUpiSectionProps) {
  const [qrScanning, setQrScanning] = useState(false);
  /* The UPI ID decoded from a QR scan IN THIS SESSION (null = none). The display only claims
     "UPI ID Scanned" while the current value IS that scanned value — a pre-filled ID (re-KYC /
     group prefill) or one changed by any other path gets the neutral "UPI ID" label. */
  const [scannedUpiId, setScannedUpiId] = useState<string | null>(null);
  /* Latest capture-method callback, read through a ref so an inline parent callback
     doesn't restart the camera/QR-poll effect on every parent render. */
  const captureMethodCbRef = useRef(onUpiCaptureMethodChange);
  captureMethodCbRef.current = onUpiCaptureMethodChange;
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /* Fires onPaymentGeoTrigger ONCE on the first keystroke of a fresh manual UPI entry.
     Re-armed below when upiId is cleared, so a later fresh entry triggers geo again.
     Seeded at MOUNT from `paymentGeoCaptured` when the parent knows whether a payment geo
     already exists (a pre-filled UPI with NO geo yet must still fire on the first keystroke);
     otherwise from whether a UPI ID is present (returning to this step → assume its
     presence/geo moment already happened, so editing it must not re-fire). An empty upiId
     always re-arms it (effect below), so the seed matters only for a UPI present at mount. */
  const manualGeoFiredRef = useRef(paymentGeoCaptured ?? !!upiId);
  /* Scan generation — bumped whenever the scan is stopped (stopCamera / effect cleanup) or the
     rep starts typing. Every async step of a scan (camera start, a frame decode in flight)
     captures the generation it began under and DROPS its result if it changed meanwhile, so a
     late decode can never overwrite a typed value or report 'QR' after the scan was stopped. */
  const scanGenRef = useRef(0);
  const manualUpiInputId = useId();

  /* ── Per-tenant UPI gate (default OFF → bank-transfer only) ── */
  const upiEnabled = getGifsySettings().salesApp?.upiEnabled === true;

  /* ── Per-tenant OPTIONAL manual UPI text entry (default OFF → QR-scan only).
        When ON (e.g. Bajaj) the UPI panel also offers a text <input> alongside the
        QR scanner; both drive the same `upiId`. ── */
  const upiManualEntry = getGifsySettings().salesApp?.upiManualEntry === true;

  /* ── When UPI is disabled, force the effective mode to 'bank' so the parent's
        submit-validation `paymentMode === 'upi'` branch can never fire. Guarded so it
        does not loop (only fires while not already 'bank'). ── */
  useEffect(() => {
    if (!upiEnabled && paymentMode !== 'bank') onPaymentModeChange('bank');
  }, [upiEnabled, paymentMode, onPaymentModeChange]);

  /* ── Stop camera when mode changes away from UPI ── */
  useEffect(() => {
    if (paymentMode !== 'upi') stopCamera();
  }, [paymentMode]);

  /* ── Camera + QR poll lifecycle ── */
  useEffect(() => {
    if (!qrScanning) return;

    // This scan's generation — any later stop/typing bumps scanGenRef and invalidates it.
    const gen = ++scanGenRef.current;
    const isCurrent = () => scanGenRef.current === gen;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        // Stopped while the permission prompt / camera start was pending → release the
        // camera we just got instead of leaking a live stream + an orphaned poll interval.
        if (!isCurrent()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (!isCurrent()) return; // stopped during play(); cleanup already released the stream

        intervalId = setInterval(() => {
          if (!videoRef.current || !canvasRef.current) return;
          const video  = videoRef.current;
          const canvas = canvasRef.current;
          const ctx    = canvas.getContext('2d');
          if (!ctx) return;

          canvas.width  = video.videoWidth  || 320;
          canvas.height = video.videoHeight || 240;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          // Dynamic import keeps jsqr out of the SSR bundle
          import('jsqr').then(({ default: jsqr }) => {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const result    = jsqr(imageData.data, imageData.width, imageData.height);
            // The decode resolves asynchronously — if the scan was stopped or the rep began
            // typing while it was in flight, DROP the result: it must not overwrite the typed
            // value, report 'QR', or fire geo for a scan that no longer exists.
            if (!isCurrent()) return;
            if (result) {
              const vpa = parseUpiFromQr(result.data);
              if (vpa) {
                setScannedUpiId(vpa);
                onUpiChange(vpa);
                captureMethodCbRef.current?.('QR');
                onPaymentGeoTrigger?.();  // ← trigger geo capture at payment moment
                // The scan WAS this value's presence/geo moment — a follow-up manual edit of
                // the scanned value must not fire geo a second time.
                manualGeoFiredRef.current = true;
                stopCamera();
              }
            }
          });
        }, 300);
      } catch {
        setQrScanning(false);
      }
    };

    startCamera();

    return () => {
      scanGenRef.current++; // invalidate any camera start / decode still in flight
      clearInterval(intervalId);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [qrScanning, onUpiChange, onPaymentGeoTrigger]);

  const stopCamera = useCallback(() => {
    scanGenRef.current++; // drop any decode already in flight (see the poll above)
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setQrScanning(false);
  }, []);

  /* ── Re-arm the manual-entry geo trigger whenever the UPI value is cleared, so the
        NEXT fresh manual entry (or a cleared-then-retyped value) fires geo once again. ── */
  useEffect(() => {
    if (!upiId) manualGeoFiredRef.current = false;
  }, [upiId]);

  /* ── Toggle handler ── */
  const handleModeClick = (mode: PaymentMode) => {
    if (mode === paymentMode) return;
    if (qrScanning) stopCamera();
    onPaymentModeChange(mode);
  };

  /* ── Manual UPI text entry → same submit path as a scanned value. Fires the
        presence/geo capture ONCE on the first keystroke of a fresh entry. ── */
  const handleManualUpiChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const value = e.target.value;
    // Typing takes over from the camera: bump the scan generation so a decode ALREADY in flight
    // is dropped when it resolves (it can't overwrite what the rep is typing), and stop an
    // in-progress scan so no new frames are decoded.
    scanGenRef.current++;
    if (qrScanning) stopCamera();
    if (!manualGeoFiredRef.current && value) {
      manualGeoFiredRef.current = true;
      onPaymentGeoTrigger?.();
    }
    onUpiChange(value);
    // Any keystroke makes the value hand-typed (even an edit of a scanned ID); clearing the
    // field leaves no captured value → null.
    onUpiCaptureMethodChange?.(value ? 'MANUAL' : null);
  };

  // Effective mode: a per-outlet MANDATE pin (lockedMode) always wins. Otherwise, when UPI
  // is disabled for the tenant it's always bank (regardless of the controlled prop, which
  // the force-bank effect above is converging to 'bank'); else the controlled prop.
  const effectiveMode: PaymentMode = lockedMode ?? (upiEnabled ? paymentMode : 'bank');

  // Locked (re-KYC non-flagged) bank field → muted, non-editable, but value stays shown.
  const lockedInputCls = inputCls + ' disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed';

  // UPI locked on a re-KYC (upiId not flagged) → the scanned value stays visible but the
  // rep cannot clear or re-scan it. (The backend also pins upiId; this is the UI half.)
  const upiLocked = !!disabledFields?.upiId;

  return (
    <div className="space-y-4">
      {/* ── Mode toggle (hidden when UPI is disabled for the tenant, OR when a per-outlet
             MANDATE pins the mode via lockedMode — the rep can't change a pinned mode) ── */}
      {upiEnabled && !lockedMode && (
        <div className="flex rounded-xl border border-gray-200 overflow-hidden" data-testid="payment-mode-toggle">
          <button
            type="button"
            role="button"
            aria-pressed={effectiveMode === 'bank'}
            onClick={() => handleModeClick('bank')}
            className={
              'flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold transition-colors ' +
              (effectiveMode === 'bank'
                ? 'bg-[var(--brand-primary)] text-white'
                : 'bg-white text-gray-500 hover:bg-gray-50')
            }
          >
            <CreditCard className="h-3.5 w-3.5" />
            Bank Account
          </button>

          <button
            type="button"
            role="button"
            aria-pressed={effectiveMode === 'upi'}
            onClick={() => handleModeClick('upi')}
            className={
              'flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold transition-colors ' +
              (effectiveMode === 'upi'
                ? 'bg-[var(--brand-primary)] text-white'
                : 'bg-white text-gray-500 hover:bg-gray-50')
            }
          >
            <Smartphone className="h-3.5 w-3.5" />
            UPI ID
          </button>
        </div>
      )}

      {/* ── Bank mode panel ── */}
      {effectiveMode === 'bank' && (
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Bank Name *</label>
            <input
              className={lockedInputCls}
              placeholder="HDFC Bank"
              value={bankName}
              onChange={onFieldChange('bankName')}
              disabled={!!disabledFields?.bankName}
              readOnly={!!disabledFields?.bankName}
            />
          </div>
          <div>
            <label className={labelCls}>Account Holder Name *</label>
            <input
              data-testid="account-holder-name-input"
              className={lockedInputCls}
              placeholder="As printed on the passbook"
              value={accountHolderName}
              onChange={onFieldChange('accountHolderName')}
              autoComplete="off"
              disabled={!!disabledFields?.accountHolderName}
              readOnly={!!disabledFields?.accountHolderName}
            />
          </div>
          <div>
            <label className={labelCls}>Account Number *</label>
            <input
              className={lockedInputCls}
              placeholder="Account number"
              value={accountNumber}
              onChange={onFieldChange('accountNumber')}
              inputMode="numeric"
              disabled={!!disabledFields?.accountNumber}
              readOnly={!!disabledFields?.accountNumber}
            />
          </div>
          <div>
            <label className={labelCls}>IFSC Code *</label>
            <input
              className={lockedInputCls}
              placeholder="HDFC0001234"
              value={ifscCode}
              onChange={onFieldChange('ifscCode')}
              disabled={!!disabledFields?.ifscCode}
              readOnly={!!disabledFields?.ifscCode}
            />
          </div>
          {/* Cheque upload slot — provided by parent */}
          {children}
        </div>
      )}

      {/* ── UPI mode panel — QR scan, plus OPTIONAL manual text entry (tenant-gated) ── */}
      {effectiveMode === 'upi' && (
        <div className="space-y-3">

          {/* Manual UPI text entry — rendered only when the tenant flag is ON. Controlled by
              upiId/onUpiChange so it flows through the exact same submit path as a scanned
              value. Respects the re-KYC per-field lock (disabledFields.upiId → upiLocked). */}
          {upiManualEntry && (
            <div>
              <label className={labelCls} htmlFor={manualUpiInputId}>UPI ID *</label>
              <input
                id={manualUpiInputId}
                data-testid="manual-upi-input"
                className={lockedInputCls}
                placeholder="yourname@bank"
                value={upiId}
                onChange={handleManualUpiChange}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                maxLength={100}
                // Matches the "*" label for assistive tech. aria-required (not native `required`)
                // so the host forms' own submit validation stays the single gate — a native
                // constraint would add a second, browser-styled validation path.
                aria-required="true"
                disabled={upiLocked}
                readOnly={upiLocked}
              />
            </div>
          )}

          {/* Scanned UPI ID display — QR-scan feedback (QR-only tenants). In manual-entry
              mode the input above is the source of truth, so this is suppressed there. */}
          {!upiManualEntry && upiId ? (
            <div
              data-testid="scanned-upi-display"
              className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5"
            >
              <CheckCircle className="h-4 w-4 text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p data-testid="scanned-upi-label" className="text-xs font-semibold text-emerald-700">
                  {scannedUpiId !== null && scannedUpiId === upiId ? 'UPI ID Scanned' : 'UPI ID'}
                </p>
                <p className="text-xs font-mono text-emerald-800 truncate">{upiId}</p>
              </div>
              {!upiLocked && (
                <button
                  type="button"
                  data-testid="clear-scanned-upi"
                  onClick={() => { setScannedUpiId(null); onUpiChange(''); onUpiCaptureMethodChange?.(null); }}
                  className="shrink-0 p-1 rounded-full text-emerald-500 hover:bg-emerald-100 hover:text-emerald-700 transition-colors"
                  title="Clear and re-scan"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ) : null}

          {/* Scan QR / Stop buttons — suppressed entirely when upiId is re-KYC locked */}
          {upiLocked ? null : !qrScanning ? (
            <button
              type="button"
              onClick={() => setQrScanning(true)}
              className="flex items-center gap-2 text-sm font-semibold text-[var(--brand-primary)] hover:underline active:opacity-70 transition-opacity"
            >
              <QrCode className="h-4 w-4" />
              {upiId ? 'Re-scan QR Code' : 'Scan QR Code'}
            </button>
          ) : (
            <button
              type="button"
              onClick={stopCamera}
              className="flex items-center gap-2 text-sm font-semibold text-red-500 hover:underline active:opacity-70 transition-opacity"
            >
              <StopCircle className="h-4 w-4" />
              Stop Scanning
            </button>
          )}

          {/* Camera view */}
          {qrScanning && (
            <div
              data-testid="qr-camera-view"
              className="relative rounded-xl overflow-hidden border border-gray-200 bg-black aspect-square"
            >
              {/* Scanner guide overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                <div className="w-48 h-48 border-2 border-white/70 rounded-2xl" />
              </div>
              <p className="absolute bottom-3 left-0 right-0 text-center text-xs text-white/80 z-10">
                Point camera at QR code
              </p>
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                playsInline
                muted
              />
              {/* Hidden canvas for frame capture */}
              <canvas ref={canvasRef} className="hidden" />
            </div>
          )}

          {/* Helper hint */}
          {!qrScanning && (
            upiManualEntry ? (
              <p className="text-[11px] text-gray-400">
                Scan the QR code, or enter the UPI ID manually.
              </p>
            ) : (
              <p className="text-[11px] text-gray-400">
                Scan the QR code from the shop owner&apos;s payment app to capture the UPI ID.
                Manual entry is not permitted.
              </p>
            )
          )}
        </div>
      )}
    </div>
  );
}
