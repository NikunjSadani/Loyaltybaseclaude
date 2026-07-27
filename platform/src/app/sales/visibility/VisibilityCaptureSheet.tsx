'use client';

/**
 * VisibilityCaptureSheet — the SALES POSM photo-capture bottom sheet
 * (VISIBILITY-POSM-DESIGN.md §5 / D9 / D10 / D11).
 *
 * Cloned-and-adapted from `sales/tasks/SchemeEnrollSheet.tsx` — it does NOT import
 * from or depend on the scheme feature. Unlike the scheme sheet (which picks a target
 * first), the outlet + window are already chosen by the list, so this sheet is a plain
 * form → submit → read-back:
 *   1. loads the tenant's ACTIVE capture form schema,
 *   2. renders the SHARED `VisibilityCaptureForm` (mode SALES — it owns camera / GPS /
 *      compression / client validation),
 *   3. on submit calls `visibilityApi.submitCapture` for a fresh window, or
 *      `visibilityApi.resubmitCapture` when re-capturing a REJECTED window (D11),
 *   4. surfaces the server geo-fence BLOCK clearly (D10), any non-blocking flags
 *      (late / geo-unverifiable / duplicate), and a success read-back.
 *
 * FORM-SCHEMA READ: the sheet fetches the schema via `visibilityApi.getSalesForm()`
 * (the sales-reachable `GET /v1/visibility/sales/form` — GIFSY still owns AUTHORING via
 * the admin-only `GET /form`, but sales can READ the active form here). Three outcomes
 * are kept distinct so an outage never masquerades as "nothing configured":
 *   - the load REJECTS or returns `success:false` → a retryable ERROR state (with a
 *     "Retry" button that re-invokes the load),
 *   - `success:true` with a null/empty form  → a "No capture form configured yet" state,
 *   - `success:true` with a real schema       → the capture form.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, CheckCircle2, Loader2, AlertTriangle, MapPin, Camera, Info, RefreshCw,
} from 'lucide-react';
import { visibilityApi } from '@/lib/visibility';
import {
  isResubmitCapture,
  type CaptureUiState,
  type SalesEligibleOutlet,
  type VisibilityFormSchema,
  type SubmitCaptureResult,
} from '@/lib/visibility-types';
import { VisibilityCaptureForm } from '@/components/visibility/VisibilityCaptureForm';

/** Human labels for the non-blocking server flags surfaced on a successful capture. */
const FLAG_LABELS: Record<string, string> = {
  LATE: 'Captured late — this window had already closed.',
  GEO_UNVERIFIABLE: 'Location could not be verified against the outlet (no reference geo on file).',
  LOW_ACCURACY: 'Low GPS accuracy — the location fix may be imprecise.',
};

function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] ?? flag.replace(/_/g, ' ').toLowerCase();
}

type View = 'form' | 'success';

export function VisibilityCaptureSheet({
  outlet,
  onCaptured,
  onClose,
}: {
  outlet: SalesEligibleOutlet;
  /** Called after a successful submit so the list can reflect the new window state. */
  onCaptured: (outletId: string, state: CaptureUiState) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>('form');
  // undefined = loading; null = no form configured; schema = loaded. A load ERROR is
  // tracked SEPARATELY (`loadError`) so an outage is never shown as "nothing configured".
  const [schema, setSchema] = useState<VisibilityFormSchema | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitCaptureResult | null>(null);

  // A REJECTED capture is re-captured through the resubmit endpoint (D11); anything else
  // is a fresh submit. Keyed on STATUS (not windowState) so a rejected-then-late capture
  // still resubmits instead of colliding on the window-unique row (M3).
  const isResubmit = isResubmitCapture(outlet);

  // Load the active capture form; re-invocable so the error state can offer a Retry.
  const reqIdRef = useRef(0);
  const loadForm = useCallback(() => {
    const reqId = ++reqIdRef.current;
    setSchema(undefined);
    setLoadError(null);
    visibilityApi
      .getSalesForm()
      .then((r) => {
        if (reqId !== reqIdRef.current) return;
        if (r.success) {
          const s = r.data?.formSchema ?? null;
          setSchema(s && Array.isArray(s.fields) && s.fields.length > 0 ? s : null);
        } else {
          // A rejected promise OR success:false is an OUTAGE, not "nothing configured".
          setLoadError(r.error || 'Could not load the capture form.');
        }
      })
      .catch(() => {
        if (reqId !== reqIdRef.current) return;
        setLoadError('Could not load the capture form.');
      });
  }, []);

  useEffect(() => {
    loadForm();
    // Invalidate any in-flight load if the sheet unmounts.
    return () => { reqIdRef.current++; };
  }, [loadForm]);

  /**
   * Controlled-form submit handler. The shared renderer has already validated + built
   * `formValues` (photo keys + fields, hidden fields stripped) and captured GPS on
   * submit; we only route it to the right endpoint and surface the outcome. Throwing
   * here lets the renderer show the error inline (its `onSubmit` contract).
   */
  const handleSubmit = async (formValues: Record<string, unknown>) => {
    setSubmitting(true);
    try {
      const res = isResubmit
        ? await visibilityApi.resubmitCapture(outlet.captureId as string, { formValues })
        : await visibilityApi.submitCapture({ outletId: outlet.outletId, formValues });
      if (!res.success) {
        // Surface the server message verbatim (geo-fence BLOCK, duplicate window,
        // scope/level 403, etc.) — the backend owns the exact wording.
        throw new Error(res.error);
      }
      setResult(res.data);
      onCaptured(outlet.outletId, 'awaiting');
      setView('success');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white rounded-t-3xl max-h-[92dvh] flex flex-col overflow-hidden shadow-2xl">
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="px-5 pt-5 pb-4 border-b border-gray-100 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold text-[var(--brand-primary)] uppercase tracking-widest mb-0.5">
                Visibility Capture
              </p>
              <h2 className="text-base font-bold text-gray-900 leading-snug truncate">
                {outlet.outletName}
              </h2>
              <p className="text-[12px] text-gray-400 mt-0.5 truncate">
                {outlet.outletCode}
                {isResubmit ? ' · Re-capture after rejection' : ''}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 -mr-1 rounded-xl hover:bg-gray-100 text-gray-400 transition-colors shrink-0"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ── VIEW: capture form ─────────────────────────────────────────────── */}
        {view === 'form' && (
          <div className="overflow-y-auto flex-1 px-5 pt-4 pb-8">
            {isResubmit && outlet.rejectionReason && (
              <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                <p className="text-xs text-red-700">
                  Previous capture was rejected: {outlet.rejectionReason}
                </p>
              </div>
            )}

            {loadError ? (
              // OUTAGE — the load failed. Distinct from "nothing configured": offer a retry.
              <div
                data-testid="visibility-form-error"
                className="flex flex-col items-center gap-3 py-12 text-center text-gray-500"
              >
                <AlertTriangle className="h-8 w-8 text-red-300" />
                <p className="text-sm font-medium text-gray-600">Couldn&apos;t load the capture form</p>
                <p className="text-xs text-gray-400 max-w-xs">{loadError}</p>
                <button
                  onClick={loadForm}
                  className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-[var(--brand-primary)] px-3 py-1.5 rounded-lg border border-[var(--brand-primary)]/30 hover:bg-[var(--brand-primary)]/5 transition-colors"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Retry
                </button>
              </div>
            ) : schema === undefined ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--brand-primary)]" />
              </div>
            ) : schema === null ? (
              // Genuinely nothing configured (success:true + null/empty form).
              <div
                data-testid="visibility-form-unavailable"
                className="flex flex-col items-center gap-2 py-12 text-center text-gray-500"
              >
                <Camera className="h-8 w-8 text-gray-300" />
                <p className="text-sm font-medium text-gray-600">No capture form configured</p>
                <p className="text-xs text-gray-400 max-w-xs">
                  No capture form has been configured yet.
                </p>
              </div>
            ) : (
              <VisibilityCaptureForm
                schema={schema}
                mode="SALES"
                submitting={submitting}
                onSubmit={handleSubmit}
              />
            )}
          </div>
        )}

        {/* ── VIEW: success read-back ────────────────────────────────────────── */}
        {view === 'success' && (
          <div className="overflow-y-auto flex-1 px-5 pt-10 pb-8">
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="h-9 w-9 text-emerald-600" />
              </div>
              <div className="text-center">
                <h3 className="text-lg font-bold text-gray-900">Capture submitted</h3>
                <p className="text-[13px] text-gray-500 mt-1">
                  <span className="font-semibold text-gray-700">{outlet.outletName}</span> is now
                  awaiting Gifsy approval for this window.
                </p>
              </div>
            </div>

            {/* Geo distance read-back (informational) */}
            {result?.distanceMeters != null && (
              <div className="mt-5 flex items-center gap-2 text-[12px] text-gray-500 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2.5">
                <MapPin className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                <span>
                  Captured {Math.round(Number(result.distanceMeters))}m from the outlet
                  {result.geoFenceOk === true ? ' — within the allowed radius.' : '.'}
                </span>
              </div>
            )}

            {/* Non-blocking server flags (late / geo-unverifiable / duplicate) */}
            {result && (result.flags.length > 0 || result.duplicatePhoto) && (
              <div className="mt-3 space-y-1.5">
                {result.flags.map((f) => (
                  <div
                    key={f}
                    className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2"
                  >
                    <Info className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-amber-700">{flagLabel(f)}</p>
                  </div>
                ))}
                {result.duplicatePhoto && (
                  <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    <Info className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-amber-700">
                      This photo matches an earlier capture — the reviewer will double-check it.
                    </p>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={onClose}
              className="mt-8 w-full py-3 rounded-xl text-sm font-bold bg-[var(--brand-primary)] text-white active:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default VisibilityCaptureSheet;
