'use client';

/**
 * EnrollmentFormRenderer
 *
 * Partner-facing dynamic form rendered inside SchemeSheet when a scheme
 * has an enrollment form configured by the admin.
 *
 * Handles all field types:
 *   TEXT, NUMBER, DROPDOWN, DATE, DOCUMENT
 *   IMAGE          — file picker with thumbnail preview
 *   CAMERA         — live webcam capture → still photo
 *   GPS_POINT      — geolocation capture with accuracy badge
 *   UPI_QR_SCAN    — text input + jsQR-powered camera scan (reuses BankOrUpiSection logic)
 *   DATA_DISPLAY   — read-only chip showing outlet's Excel data point
 *   AUTO_POPULATED — prefilled input, locked or editable per admin config
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Camera, MapPin, QrCode, StopCircle, Lock, Upload,
  AlertCircle, CheckCircle, Eye,
} from 'lucide-react';
import { filterFieldsByAudience, validateFieldValues, type FormField } from '@/lib/campaign';
import { isValidUpiId, parseUpiFromQr } from '@/lib/upi-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface EnrollmentFormRendererProps {
  fields:          FormField[];
  isLoyaltyMember: boolean;
  /** Outlet Excel data keyed by dataDisplayKey / label */
  prefillData:     Record<string, string>;
  /** Controlled values map: fieldId → value */
  values:          Record<string, unknown>;
  onChange:        (fieldId: string, value: unknown) => void;
  onSubmit:        (values: Record<string, unknown>) => void;
  /** Optional submit button label. Defaults to "Submit". */
  submitLabel?:    string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared style tokens
// ─────────────────────────────────────────────────────────────────────────────

const inputCls =
  'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 ' +
  'focus:border-[var(--brand-primary)] bg-white disabled:bg-gray-50 disabled:text-gray-400';

const labelCls = 'text-xs font-medium text-gray-700 block mb-1';
const helpCls  = 'text-[11px] text-gray-400 mt-0.5';

// ─────────────────────────────────────────────────────────────────────────────
// Individual field renderers
// ─────────────────────────────────────────────────────────────────────────────

function RequiredStar() {
  return <span className="text-red-500 ml-0.5">*</span>;
}

// ── DATA_DISPLAY ──────────────────────────────────────────────────────────────

function DataDisplayField({ field, prefillData }: { field: FormField; prefillData: Record<string, string> }) {
  const key   = field.dataDisplayKey ?? field.label;
  const value = prefillData[key];
  return (
    <div>
      <p className={labelCls}>{field.label}</p>
      <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl">
        <Eye className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        <span className="text-sm font-medium text-gray-700">{value || '—'}</span>
      </div>
      {field.helpText && <p className={helpCls}>{field.helpText}</p>}
    </div>
  );
}

// ── AUTO-POPULATED (locked or editable) ───────────────────────────────────────

function AutoPopulatedField({
  field, value, onChange,
}: { field: FormField; value: string; onChange: (v: string) => void }) {
  const locked = !field.autoFillEditable;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className={labelCls}>
          {field.label}{field.required && <RequiredStar />}
        </label>
        {locked && (
          <span
            data-testid={`lock-icon-${field.id}`}
            className="flex items-center gap-1 text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full"
          >
            <Lock className="h-2.5 w-2.5" /> Auto-filled
          </span>
        )}
      </div>
      <input
        type="text"
        className={inputCls}
        value={value}
        disabled={locked}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
      />
      {field.helpText && <p className={helpCls}>{field.helpText}</p>}
    </div>
  );
}

// ── UPI_QR_SCAN ───────────────────────────────────────────────────────────────

function UpiQrScanField({
  field, value, onChange,
}: { field: FormField; value: string; onChange: (v: string) => void }) {
  const [scanning, setScanning]  = useState(false);
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => {
    if (!scanning) return;
    let intervalId: ReturnType<typeof setInterval>;

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        intervalId = setInterval(() => {
          const video  = videoRef.current;
          const canvas = canvasRef.current;
          if (!video || !canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          canvas.width  = video.videoWidth  || 320;
          canvas.height = video.videoHeight || 240;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          import('jsqr').then(({ default: jsqr }) => {
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const res = jsqr(img.data, img.width, img.height);
            if (res) {
              const vpa = parseUpiFromQr(res.data);
              if (vpa) { onChange(vpa); stopCamera(); }
            }
          });
        }, 300);
      } catch { setScanning(false); }
    };

    startCamera();
    return () => {
      clearInterval(intervalId);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [scanning, onChange, stopCamera]);

  const showError = value.length > 0 && !isValidUpiId(value);

  return (
    <div className="space-y-2">
      <label className={labelCls}>
        {field.label}{field.required && <RequiredStar />}
      </label>

      <input
        type="text"
        aria-label={field.label}
        className={inputCls + (showError ? ' border-red-400' : '')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder || '9876543210@paytm'}
        inputMode="email"
        autoCapitalize="none"
      />

      {showError && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          Invalid UPI ID — use format like name@bank
        </p>
      )}

      {!scanning ? (
        <button
          type="button"
          aria-label="Scan QR"
          onClick={() => setScanning(true)}
          className="flex items-center gap-1.5 text-sm font-semibold text-[var(--brand-primary)] hover:underline"
        >
          <QrCode className="h-4 w-4" /> Scan QR
        </button>
      ) : (
        <button
          type="button"
          onClick={stopCamera}
          className="flex items-center gap-1.5 text-sm font-semibold text-red-500 hover:underline"
        >
          <StopCircle className="h-4 w-4" /> Stop Scanning
        </button>
      )}

      {scanning && (
        <div
          data-testid="qr-camera-view"
          className="relative rounded-xl overflow-hidden border border-gray-200 bg-black aspect-square"
        >
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="w-44 h-44 border-2 border-white/70 rounded-2xl" />
          </div>
          <p className="absolute bottom-3 left-0 right-0 text-center text-xs text-white/80 z-10">
            Point camera at UPI QR code
          </p>
          <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
          <canvas ref={canvasRef} className="hidden" />
        </div>
      )}

      {field.helpText && <p className={helpCls}>{field.helpText}</p>}
    </div>
  );
}

// ── GPS_POINT ─────────────────────────────────────────────────────────────────

function GpsField({
  field, value, onChange,
}: { field: FormField; value: { lat: number; lng: number; accuracy?: number } | null; onChange: (v: unknown) => void }) {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const capture = () => {
    setLoading(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onChange({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) });
        setLoading(false);
      },
      () => { setError('Could not get location. Please try again.'); setLoading(false); },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <div>
      <label className={labelCls}>
        {field.label}{field.required && <RequiredStar />}
      </label>

      {value ? (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-green-50 border border-green-200 rounded-xl">
          <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
          <span className="text-xs text-green-700 font-medium">
            {value.lat.toFixed(6)}, {value.lng.toFixed(6)}
          </span>
          {value.accuracy && (
            <span className="ml-auto text-[10px] text-green-500">±{value.accuracy}m</span>
          )}
          <button type="button" onClick={capture} className="text-[10px] text-green-600 underline ml-1">
            Re-capture
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={capture}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 py-2.5 border border-dashed border-green-300 bg-green-50 rounded-xl text-sm font-medium text-green-700 hover:bg-green-100 disabled:opacity-50 transition-colors"
        >
          <MapPin className="h-4 w-4" />
          {loading ? 'Getting location…' : 'Capture Location'}
        </button>
      )}

      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      {field.helpText && <p className={helpCls}>{field.helpText}</p>}
    </div>
  );
}

// ── IMAGE (file picker) ───────────────────────────────────────────────────────

function ImageField({
  field, value, onChange,
}: { field: FormField; value: string[]; onChange: (v: string[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const urls  = files.map((f) => URL.createObjectURL(f));
    onChange([...value, ...urls]);
  };

  const remove = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  return (
    <div>
      <label className={labelCls}>
        {field.label}{field.required && <RequiredStar />}
      </label>

      {value.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 mb-2">
          {value.map((src, i) => (
            <div key={i} className="relative aspect-square rounded-lg overflow-hidden bg-gray-100">
              <img src={src} alt="" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => remove(i)}
                className="absolute top-1 right-1 w-5 h-5 bg-black/50 text-white rounded-full text-[10px] flex items-center justify-center"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-sm text-gray-500 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors"
      >
        <Upload className="h-4 w-4" /> {value.length > 0 ? 'Add more' : 'Upload photo'}
      </button>
      <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFiles} />
      {field.helpText && <p className={helpCls}>{field.helpText}</p>}
    </div>
  );
}

// ── CAMERA (live capture) ─────────────────────────────────────────────────────

function CameraField({
  field, value, onChange,
}: { field: FormField; value: string[]; onChange: (v: string[]) => void }) {
  const [active, setActive]  = useState(false);
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setActive(true);
    } catch { /* camera unavailable */ }
  };

  const capture = () => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    onChange([...value, dataUrl]);
    stopCamera();
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActive(false);
  };

  const remove = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  return (
    <div>
      <label className={labelCls}>
        {field.label}{field.required && <RequiredStar />}
      </label>

      {value.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 mb-2">
          {value.map((src, i) => (
            <div key={i} className="relative aspect-square rounded-lg overflow-hidden bg-gray-100">
              <img src={src} alt="" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => remove(i)}
                className="absolute top-1 right-1 w-5 h-5 bg-black/50 text-white rounded-full text-[10px] flex items-center justify-center"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {active ? (
        <div className="space-y-2">
          <div className="relative rounded-xl overflow-hidden bg-black aspect-video">
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={capture}
              className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
            >
              <Camera className="h-4 w-4" /> Capture
            </button>
            <button
              type="button"
              onClick={stopCamera}
              className="px-4 py-2.5 bg-gray-100 text-gray-600 rounded-xl text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
          <canvas ref={canvasRef} className="hidden" />
        </div>
      ) : (
        <button
          type="button"
          onClick={startCamera}
          className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-pink-200 bg-pink-50 rounded-xl text-sm font-medium text-pink-600 hover:bg-pink-100 transition-colors"
        >
          <Camera className="h-4 w-4" />
          {value.length > 0 ? 'Take another photo' : 'Open Camera'}
        </button>
      )}

      {field.helpText && <p className={helpCls}>{field.helpText}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main renderer
// ─────────────────────────────────────────────────────────────────────────────

export function EnrollmentFormRenderer({
  fields,
  isLoyaltyMember,
  prefillData,
  values,
  onChange,
  onSubmit,
  submitLabel = 'Submit',
}: EnrollmentFormRendererProps) {
  // Filter by audience first
  const visibleFields = filterFieldsByAudience(fields, isLoyaltyMember);

  // Validate to determine if submit is enabled
  const { valid } = validateFieldValues(visibleFields, values);

  const handleSubmit = () => {
    if (valid) onSubmit(values);
  };

  const str = (id: string) => String(values[id] ?? '');
  const arr = (id: string): string[] => {
    const v = values[id];
    return Array.isArray(v) ? v : [];
  };
  const gps = (id: string) => {
    const v = values[id];
    if (v && typeof v === 'object' && 'lat' in v) return v as { lat: number; lng: number; accuracy?: number };
    return null;
  };

  return (
    <div className="space-y-4">
      {visibleFields.map((field) => {
        // DATA_DISPLAY — always read-only from prefillData
        if (field.type === 'DATA_DISPLAY') {
          return <DataDisplayField key={field.id} field={field} prefillData={prefillData} />;
        }

        // AUTO_POPULATED — locked or editable input
        if (field.autoFillFromExcel) {
          return (
            <AutoPopulatedField
              key={field.id}
              field={field}
              value={str(field.id)}
              onChange={(v) => onChange(field.id, v)}
            />
          );
        }

        // UPI QR scan
        if (field.type === 'UPI_QR_SCAN') {
          return (
            <UpiQrScanField
              key={field.id}
              field={field}
              value={str(field.id)}
              onChange={(v) => onChange(field.id, v)}
            />
          );
        }

        // GPS
        if (field.type === 'GPS_POINT') {
          return (
            <GpsField
              key={field.id}
              field={field}
              value={gps(field.id)}
              onChange={(v) => onChange(field.id, v)}
            />
          );
        }

        // Camera (live capture)
        if (field.type === 'CAMERA') {
          return (
            <CameraField
              key={field.id}
              field={field}
              value={arr(field.id)}
              onChange={(v) => onChange(field.id, v)}
            />
          );
        }

        // Image (file picker)
        if (field.type === 'IMAGE') {
          return (
            <ImageField
              key={field.id}
              field={field}
              value={arr(field.id)}
              onChange={(v) => onChange(field.id, v)}
            />
          );
        }

        // Dropdown
        if (field.type === 'DROPDOWN') {
          return (
            <div key={field.id}>
              <label htmlFor={field.id} className={labelCls}>
                {field.label}{field.required && <RequiredStar />}
              </label>
              <select
                id={field.id}
                value={str(field.id)}
                onChange={(e) => onChange(field.id, e.target.value)}
                className={inputCls}
              >
                <option value="">Select…</option>
                {(field.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
              {field.helpText && <p className={helpCls}>{field.helpText}</p>}
            </div>
          );
        }

        // Number
        if (field.type === 'NUMBER') {
          return (
            <div key={field.id}>
              <label htmlFor={field.id} className={labelCls}>
                {field.label}{field.required && <RequiredStar />}
              </label>
              <input
                id={field.id}
                type="number"
                className={inputCls}
                value={str(field.id)}
                onChange={(e) => onChange(field.id, e.target.value)}
                placeholder={field.placeholder}
              />
              {field.helpText && <p className={helpCls}>{field.helpText}</p>}
            </div>
          );
        }

        // Date
        if (field.type === 'DATE') {
          return (
            <div key={field.id}>
              <label htmlFor={field.id} className={labelCls}>
                {field.label}{field.required && <RequiredStar />}
              </label>
              <input
                id={field.id}
                type="date"
                className={inputCls}
                value={str(field.id)}
                onChange={(e) => onChange(field.id, e.target.value)}
              />
              {field.helpText && <p className={helpCls}>{field.helpText}</p>}
            </div>
          );
        }

        // TEXT (default + DOCUMENT treated as text path)
        return (
          <div key={field.id}>
            <label htmlFor={field.id} className={labelCls}>
              {field.label}{field.required && <RequiredStar />}
            </label>
            <input
              id={field.id}
              type="text"
              className={inputCls}
              value={str(field.id)}
              onChange={(e) => onChange(field.id, e.target.value)}
              placeholder={field.placeholder}
              maxLength={field.type === 'TEXT' ? undefined : undefined}
            />
            {field.helpText && <p className={helpCls}>{field.helpText}</p>}
          </div>
        );
      })}

      {/* Submit */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!valid}
        className="w-full py-3 rounded-xl text-sm font-bold transition-all
          disabled:opacity-40 disabled:cursor-not-allowed
          bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-dark)]
          active:scale-[0.98] flex items-center justify-center gap-2"
      >
        {submitLabel}
      </button>
    </div>
  );
}
