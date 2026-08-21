'use client';

import { useState } from 'react';
import { Send, Clock, Loader2, CheckCircle2, AlertTriangle, TestTube2 } from 'lucide-react';
import { api } from '@/lib/api-client';
import {
  type WizardState,
  type WhatsappTemplate,
  validateTestPhones,
  buildPreviewPayload,
  canSend,
} from '@/lib/whatsapp-broadcasts';

/**
 * Step ⑤ — Test & send. Send a test to 1–5 of your own numbers, optionally schedule,
 * then open the confirm dialog to send.
 *
 * NOTE (contract): the design lists POST /:id/test-send for an already-created
 * broadcast (exposed on the campaign detail page). The wizard has no broadcast id
 * yet, so its pre-send test posts to the id-less
 * POST /api/admin/whatsapp-broadcasts/test-send with the current template + mapping.
 */
export function SendStep({
  state,
  template,
  onRequestSend,
  onSchedule,
}: {
  state: WizardState;
  template: WhatsappTemplate | null;
  onRequestSend: () => void;
  onSchedule: (iso: string | null) => void;
}) {
  const [testPhonesRaw, setTestPhonesRaw] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>(
    state.scheduledAt ? 'later' : 'now',
  );

  const sendReady = canSend(state);

  async function handleTestSend() {
    const v = validateTestPhones(testPhonesRaw);
    if (!v.ok) {
      setTestResult({ ok: false, msg: v.error ?? 'Invalid numbers' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const payload = { ...buildPreviewPayload(state), phones: v.phones };
    const res = await api.post<{ sent: number }>(
      '/api/admin/whatsapp-broadcasts/test-send',
      payload,
    );
    setTesting(false);
    if (res.success) {
      setTestResult({
        ok: true,
        msg: `Test sent to ${v.phones.length} number${v.phones.length !== 1 ? 's' : ''}. Check WhatsApp.`,
      });
    } else {
      setTestResult({ ok: false, msg: res.error });
    }
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-700 space-y-1">
        <p>
          Template:{' '}
          <span className="font-semibold text-gray-900">{template?.name ?? '—'}</span>
        </p>
        <p>
          Audience:{' '}
          <span className="font-semibold text-gray-900">
            {state.audienceMode === 'FILTER'
              ? `Filter · ${state.scope.toLowerCase()}`
              : 'Uploaded Excel list'}
          </span>
        </p>
        <p>
          Recipients:{' '}
          <span className="font-semibold text-gray-900">
            {(state.preview?.recipientCount ?? 0).toLocaleString('en-IN')}
          </span>
        </p>
      </div>

      {/* Test-send */}
      <div className="border border-gray-200 rounded-xl p-4">
        <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <TestTube2 className="w-4 h-4 text-gray-400" />
          Test-send to yourself
        </p>
        <p className="text-[11px] text-gray-400 mt-0.5">
          Send this exact message to up to 5 of your own numbers before the blast.
        </p>
        <div className="flex items-center gap-2 mt-3">
          <input
            type="text"
            value={testPhonesRaw}
            onChange={(e) => setTestPhonesRaw(e.target.value)}
            placeholder="e.g. 9830011252, 6289864191"
            data-testid="test-phones"
            className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          />
          <button
            onClick={() => void handleTestSend()}
            disabled={testing || !testPhonesRaw.trim()}
            data-testid="test-send-btn"
            className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Send test
          </button>
        </div>
        {testResult && (
          <p
            className={`text-[11px] mt-2 flex items-center gap-1.5 ${
              testResult.ok ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {testResult.ok ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5" />
            )}
            {testResult.msg}
          </p>
        )}
      </div>

      {/* Schedule */}
      <div className="border border-gray-200 rounded-xl p-4">
        <p className="text-sm font-semibold text-gray-900">When to send</p>
        <div role="radiogroup" aria-label="Send timing" className="flex gap-2 mt-3">
          <button
            type="button"
            role="radio"
            aria-checked={scheduleMode === 'now'}
            onClick={() => {
              setScheduleMode('now');
              onSchedule(null);
            }}
            className={`text-xs px-4 py-2 rounded-lg font-medium transition-colors ${
              scheduleMode === 'now'
                ? 'bg-[var(--brand-primary)] text-white'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Send now
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={scheduleMode === 'later'}
            onClick={() => setScheduleMode('later')}
            className={`inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg font-medium transition-colors ${
              scheduleMode === 'later'
                ? 'bg-[var(--brand-primary)] text-white'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            Schedule
          </button>
        </div>
        {scheduleMode === 'later' && (
          <div className="mt-3">
            <input
              type="datetime-local"
              value={state.scheduledAt ? toLocalInput(state.scheduledAt) : ''}
              onChange={(e) =>
                onSchedule(e.target.value ? new Date(e.target.value).toISOString() : null)
              }
              data-testid="schedule-input"
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
            />
          </div>
        )}
      </div>

      {/* Primary send */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-gray-400">
          {sendReady
            ? 'Preview succeeded — you can send.'
            : 'Run a preview with at least one recipient to enable send.'}
        </p>
        <button
          onClick={onRequestSend}
          disabled={!sendReady || (scheduleMode === 'later' && !state.scheduledAt)}
          data-testid="open-confirm-btn"
          className="inline-flex items-center gap-1.5 text-sm px-6 py-2.5 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {scheduleMode === 'later' ? <Clock className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          {scheduleMode === 'later' ? 'Schedule broadcast' : 'Send broadcast'}
        </button>
      </div>
    </div>
  );
}

/** ISO → the value a <input type="datetime-local"> expects (local, no seconds). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
