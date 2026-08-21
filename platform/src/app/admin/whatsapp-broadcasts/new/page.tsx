'use client';

/**
 * /admin/whatsapp-broadcasts/new — the New-broadcast WIZARD (Gifsy-operator only).
 *
 * Steps: ① Audience (FILTER outlet/rep filters or EXCEL upload) → ② pick Template
 * from the library → ③ Map variables → ④ Preview (count/dedup/invalid/sample/cost)
 * → ⑤ Test & send (test-send to my numbers, then send now / schedule).
 *
 * All step-gating + preview-invalidation is driven by the pure reducer in
 * lib/whatsapp-broadcasts.ts, so Send can never fire against a stale count.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Check,
  AlertTriangle,
  Send,
  Clock,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Modal } from '@/components/ui/modal';
import {
  wizardReducer,
  initialWizardState,
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  stepIndex,
  isStepUnlocked,
  canAdvance,
  canSend,
  buildPreviewPayload,
  buildCreatePayload,
  categoryCostNote,
  categoryIsPaid,
  type WhatsappTemplate,
  type PreviewResult,
  type WizardStep,
} from '@/lib/whatsapp-broadcasts';
import { AudienceStep } from '@/components/whatsapp/audience-step';
import { TemplateStep } from '@/components/whatsapp/template-step';
import { MapStep } from '@/components/whatsapp/map-step';
import { PreviewStep } from '@/components/whatsapp/preview-step';
import { SendStep } from '@/components/whatsapp/send-step';

export default function NewBroadcastWizardPage() {
  const router = useRouter();
  const [state, dispatch] = useReducer(wizardReducer, undefined, initialWizardState);

  // Template library (ACTIVE-first) — needed for gating + the pick/map/preview steps.
  const [templates, setTemplates] = useState<WhatsappTemplate[]>([]);
  const [tplLoading, setTplLoading] = useState(true);
  const [tplError, setTplError] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    setTplLoading(true);
    setTplError(null);
    const res = await api.get<WhatsappTemplate[] | { items: WhatsappTemplate[] }>(
      '/api/admin/whatsapp-templates',
    );
    if (res.success) {
      const data = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
      setTemplates(data);
    } else {
      setTplError(res.error);
    }
    setTplLoading(false);
  }, []);
  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === state.templateId) ?? null,
    [templates, state.templateId],
  );

  // ── Preview ──────────────────────────────────────────────────────────────
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const runPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    const res = await api.post<PreviewResult>(
      '/api/admin/whatsapp-broadcasts/preview',
      buildPreviewPayload(state),
    );
    setPreviewLoading(false);
    if (res.success) {
      dispatch({ type: 'SET_PREVIEW', preview: res.data });
    } else {
      dispatch({ type: 'SET_PREVIEW', preview: null });
      setPreviewError(res.error);
    }
  }, [state]);

  // Auto-run the preview when the user first lands on the preview step with no
  // current (or invalidated) preview — e.g. arriving via the stepper. A ref holds
  // the latest runPreview so this fires on the step transition only, not on every
  // state change (which would loop).
  const runPreviewRef = useRef(runPreview);
  runPreviewRef.current = runPreview;
  const autoPreviewedRef = useRef(false);
  useEffect(() => {
    if (state.step === 'preview' && !state.preview && !previewLoading && !autoPreviewedRef.current) {
      autoPreviewedRef.current = true;
      void runPreviewRef.current();
    }
    if (state.step !== 'preview') autoPreviewedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step, state.preview]);

  // ── Send / schedule ──────────────────────────────────────────────────────
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Synchronous in-flight latch. `submitting` (React state) updates asynchronously,
  // so a fast double-click can fire handleSend twice before the first re-render — a
  // ref flips synchronously and blocks the second POST (which would be a double blast).
  const sendInFlightRef = useRef(false);

  const handleSend = useCallback(async () => {
    if (!canSend(state)) return;
    if (sendInFlightRef.current) return; // already POSTing — ignore the double-click
    sendInFlightRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.post<{ id: string }>(
        '/api/admin/whatsapp-broadcasts',
        buildCreatePayload(state),
      );
      if (res.success) {
        setConfirmOpen(false);
        router.push(`/admin/whatsapp-broadcasts/${res.data.id}`);
      } else {
        setSubmitError(res.error);
        // Only release the latch on failure so the user can retry; on success we
        // navigate away and never re-enable this handler.
        sendInFlightRef.current = false;
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong.');
      sendInFlightRef.current = false;
    } finally {
      setSubmitting(false);
    }
  }, [state, router]);

  const advanceOk = canAdvance(state, templates);
  const currentIdx = stepIndex(state.step);

  return (
    <div className="space-y-5 fade-in max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900">New WhatsApp broadcast</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Pick an audience, choose an approved template, preview, and send.
          </p>
        </div>
        <Link
          href="/admin/whatsapp-broadcasts"
          className="text-xs text-gray-500 hover:text-gray-800"
        >
          Cancel
        </Link>
      </div>

      {/* Stepper */}
      <Stepper
        current={state.step}
        onGo={(step) => dispatch({ type: 'GO', step, templates })}
        unlocked={(step) => isStepUnlocked(state, step, templates)}
      />

      {/* Step body */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 min-h-[280px]">
        {state.step === 'audience' && (
          <AudienceStep state={state} dispatch={dispatch} />
        )}
        {state.step === 'template' && (
          <TemplateStep
            state={state}
            dispatch={dispatch}
            templates={templates}
            loading={tplLoading}
            error={tplError}
            onRetry={loadTemplates}
          />
        )}
        {state.step === 'map' && (
          <MapStep state={state} dispatch={dispatch} template={selectedTemplate} />
        )}
        {state.step === 'preview' && (
          <PreviewStep
            state={state}
            template={selectedTemplate}
            loading={previewLoading}
            error={previewError}
            onRun={runPreview}
          />
        )}
        {state.step === 'send' && (
          <SendStep
            state={state}
            template={selectedTemplate}
            onRequestSend={() => setConfirmOpen(true)}
            onSchedule={(iso) => dispatch({ type: 'SET_SCHEDULE', scheduledAt: iso })}
          />
        )}
      </div>

      {/* Footer nav */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => dispatch({ type: 'BACK' })}
          disabled={currentIdx === 0}
          className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          Back
        </button>

        {state.step !== 'send' ? (
          <button
            onClick={() => {
              // Entering the preview step auto-runs the preview.
              if (state.step === 'map') {
                dispatch({ type: 'NEXT', templates });
                void runPreview();
              } else {
                dispatch({ type: 'NEXT', templates });
              }
            }}
            disabled={!advanceOk}
            data-testid="wizard-next"
            className="inline-flex items-center gap-1.5 text-xs px-5 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {state.step === 'preview' ? 'Continue to send' : 'Next'}
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        ) : (
          <span className="text-[11px] text-gray-400">
            Use the buttons above to test-send or send.
          </span>
        )}
      </div>

      {/* Confirm-before-send dialog */}
      <ConfirmSendModal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        preview={state.preview}
        scheduledAt={state.scheduledAt}
        paid={selectedTemplate ? categoryIsPaid(selectedTemplate.category) : false}
        costNote={selectedTemplate ? categoryCostNote(selectedTemplate.category) : ''}
        submitting={submitting}
        error={submitError}
        onConfirm={handleSend}
      />
    </div>
  );
}

// ─── Stepper ──────────────────────────────────────────────────────────────────

function Stepper({
  current,
  onGo,
  unlocked,
}: {
  current: WizardStep;
  onGo: (step: WizardStep) => void;
  unlocked: (step: WizardStep) => boolean;
}) {
  const currentIdx = stepIndex(current);
  return (
    <ol className="flex items-center gap-1 overflow-x-auto" aria-label="Broadcast steps">
      {WIZARD_STEPS.map((step, i) => {
        const isCurrent = step === current;
        const isDone = i < currentIdx;
        const canClick = unlocked(step);
        return (
          <li key={step} className="flex items-center flex-1 min-w-fit">
            <button
              type="button"
              onClick={() => canClick && onGo(step)}
              disabled={!canClick}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                isCurrent
                  ? 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                  : isDone
                    ? 'text-emerald-700 hover:bg-gray-50'
                    : 'text-gray-400'
              } ${canClick ? 'cursor-pointer' : 'cursor-not-allowed'}`}
            >
              <span
                className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] ${
                  isCurrent
                    ? 'bg-[var(--brand-primary)] text-white'
                    : isDone
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-gray-100 text-gray-400'
                }`}
              >
                {isDone ? <Check className="w-3 h-3" /> : i + 1}
              </span>
              {WIZARD_STEP_LABELS[step]}
            </button>
            {i < WIZARD_STEPS.length - 1 && (
              <ChevronRight className="w-3.5 h-3.5 text-gray-300 mx-0.5 shrink-0" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Confirm-before-send modal ──────────────────────────────────────────────────

function ConfirmSendModal({
  open,
  onOpenChange,
  preview,
  scheduledAt,
  paid,
  costNote,
  submitting,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  preview: PreviewResult | null;
  scheduledAt: string | null;
  paid: boolean;
  costNote: string;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const count = preview?.recipientCount ?? 0;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={scheduledAt ? 'Schedule this broadcast?' : 'Send this broadcast?'}
      description={
        scheduledAt
          ? 'It will be queued and sent at the scheduled time.'
          : 'Messages will be queued and sent right away.'
      }
    >
      <div className="space-y-4">
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <p className="text-sm text-gray-700">
            This will message{' '}
            <span className="font-bold text-gray-900" data-testid="confirm-count">
              {count.toLocaleString('en-IN')}
            </span>{' '}
            recipient{count !== 1 ? 's' : ''}.
          </p>
          {scheduledAt && (
            <p className="text-xs text-amber-700 mt-1 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Scheduled for {new Date(scheduledAt).toLocaleString('en-IN')}
            </p>
          )}
          <p className={`text-xs mt-2 ${paid ? 'text-amber-700' : 'text-gray-500'}`}>
            {costNote}
          </p>
          {preview?.estimatedCost != null && (
            <p className="text-xs text-gray-700 mt-1">
              Estimated cost:{' '}
              <span className="font-semibold">
                ₹{Number(preview.estimatedCost).toLocaleString('en-IN')}
              </span>
            </p>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting || count === 0}
            data-testid="confirm-send-btn"
            className="inline-flex items-center gap-1.5 text-xs px-5 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26] transition-colors disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : scheduledAt ? (
              <Clock className="w-3.5 h-3.5" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            {scheduledAt ? 'Schedule broadcast' : 'Send now'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
