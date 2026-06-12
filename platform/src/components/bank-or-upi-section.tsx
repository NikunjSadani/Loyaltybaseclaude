'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CreditCard, Smartphone, QrCode, StopCircle, X, CheckCircle } from 'lucide-react';
import { parseUpiFromQr } from '@/lib/upi-utils';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

export type PaymentMode = 'bank' | 'upi';

export interface BankOrUpiSectionProps {
  /** Controlled mode — parent decides which panel is active */
  paymentMode:          PaymentMode;
  onPaymentModeChange:  (mode: PaymentMode) => void;

  /** Bank fields (controlled) */
  bankName:           string;
  accountHolderName:  string;
  accountNumber:      string;
  ifscCode:           string;
  onFieldChange: (field: 'bankName' | 'accountHolderName' | 'accountNumber' | 'ifscCode') =>
    React.ChangeEventHandler<HTMLInputElement>;

  /**
   * UPI field (controlled).
   * In UPI mode this is populated ONLY via QR scan — there is no manual text entry.
   * Call onUpiChange('') to clear a previously-scanned ID.
   */
  upiId:       string;
  onUpiChange: (value: string) => void;

  /**
   * Called when a payment geo capture should be triggered in the parent.
   * Fires after a successful QR scan (the scan = the presence-at-outlet moment).
   * For cheque upload the parent triggers geo directly in handleFileSelect.
   */
  onPaymentGeoTrigger?: () => void;

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
  bankName,
  accountHolderName,
  accountNumber,
  ifscCode,
  onFieldChange,
  upiId,
  onUpiChange,
  onPaymentGeoTrigger,
  children,
}: BankOrUpiSectionProps) {
  const [qrScanning, setQrScanning] = useState(false);
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  /* ── Stop camera when mode changes away from UPI ── */
  useEffect(() => {
    if (paymentMode !== 'upi') stopCamera();
  }, [paymentMode]);

  /* ── Camera + QR poll lifecycle ── */
  useEffect(() => {
    if (!qrScanning) return;

    let intervalId: ReturnType<typeof setInterval>;

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

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
            if (result) {
              const vpa = parseUpiFromQr(result.data);
              if (vpa) {
                onUpiChange(vpa);
                onPaymentGeoTrigger?.();  // ← trigger geo capture at payment moment
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
      clearInterval(intervalId);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [qrScanning, onUpiChange, onPaymentGeoTrigger]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setQrScanning(false);
  }, []);

  /* ── Toggle handler ── */
  const handleModeClick = (mode: PaymentMode) => {
    if (mode === paymentMode) return;
    if (qrScanning) stopCamera();
    onPaymentModeChange(mode);
  };

  return (
    <div className="space-y-4">
      {/* ── Mode toggle ── */}
      <div className="flex rounded-xl border border-gray-200 overflow-hidden">
        <button
          type="button"
          role="button"
          aria-pressed={paymentMode === 'bank'}
          onClick={() => handleModeClick('bank')}
          className={
            'flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold transition-colors ' +
            (paymentMode === 'bank'
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
          aria-pressed={paymentMode === 'upi'}
          onClick={() => handleModeClick('upi')}
          className={
            'flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold transition-colors ' +
            (paymentMode === 'upi'
              ? 'bg-[var(--brand-primary)] text-white'
              : 'bg-white text-gray-500 hover:bg-gray-50')
          }
        >
          <Smartphone className="h-3.5 w-3.5" />
          UPI ID
        </button>
      </div>

      {/* ── Bank mode panel ── */}
      {paymentMode === 'bank' && (
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Bank Name *</label>
            <input
              className={inputCls}
              placeholder="HDFC Bank"
              value={bankName}
              onChange={onFieldChange('bankName')}
            />
          </div>
          <div>
            <label className={labelCls}>Account Holder Name *</label>
            <input
              data-testid="account-holder-name-input"
              className={inputCls}
              placeholder="As printed on the passbook"
              value={accountHolderName}
              onChange={onFieldChange('accountHolderName')}
              autoComplete="off"
            />
          </div>
          <div>
            <label className={labelCls}>Account Number *</label>
            <input
              className={inputCls}
              placeholder="Account number"
              value={accountNumber}
              onChange={onFieldChange('accountNumber')}
              inputMode="numeric"
            />
          </div>
          <div>
            <label className={labelCls}>IFSC Code *</label>
            <input
              className={inputCls}
              placeholder="HDFC0001234"
              value={ifscCode}
              onChange={onFieldChange('ifscCode')}
            />
          </div>
          {/* Cheque upload slot — provided by parent */}
          {children}
        </div>
      )}

      {/* ── UPI mode panel — QR scan only, no manual text entry ── */}
      {paymentMode === 'upi' && (
        <div className="space-y-3">

          {/* Scanned UPI ID display — shown only after a successful scan */}
          {upiId ? (
            <div
              data-testid="scanned-upi-display"
              className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5"
            >
              <CheckCircle className="h-4 w-4 text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-emerald-700">UPI ID Scanned</p>
                <p className="text-xs font-mono text-emerald-800 truncate">{upiId}</p>
              </div>
              <button
                type="button"
                data-testid="clear-scanned-upi"
                onClick={() => onUpiChange('')}
                className="shrink-0 p-1 rounded-full text-emerald-500 hover:bg-emerald-100 hover:text-emerald-700 transition-colors"
                title="Clear and re-scan"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {/* Scan QR / Stop buttons */}
          {!qrScanning ? (
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
            <p className="text-[11px] text-gray-400">
              Scan the QR code from the shop owner&apos;s payment app to capture the UPI ID.
              Manual entry is not permitted.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
