'use client';

import { Loader2, AlertTriangle, RefreshCw, Users, Copy, ShieldAlert } from 'lucide-react';
import {
  type WizardState,
  type WhatsappTemplate,
  categoryCostNote,
  categoryIsPaid,
} from '@/lib/whatsapp-broadcasts';

/**
 * Step ④ — Preview. Shows the resolved recipient count, dedup + invalid-number
 * pre-flight, a sample rendered message, and the cost note. Send stays locked
 * until a preview has succeeded (enforced by the reducer, surfaced here).
 */
export function PreviewStep({
  state,
  template,
  loading,
  error,
  onRun,
}: {
  state: WizardState;
  template: WhatsappTemplate | null;
  loading: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const p = state.preview;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          Review the audience and a sample message before sending.
        </p>
        <button
          onClick={onRun}
          disabled={loading}
          data-testid="preview-refresh"
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Refresh preview
        </button>
      </div>

      {loading && !p && (
        <div className="py-12 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Building preview…
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {error}
        </div>
      )}

      {p && (
        <>
          {/* Counters */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Recipients" value={p.recipientCount} highlight testId="preview-count" />
            <Stat label="Duplicates removed" value={p.deduped} />
            <Stat label="Invalid numbers" value={p.invalidCount} warn={p.invalidCount > 0} />
            <Stat
              label="Est. cost"
              value={p.estimatedCost != null ? `₹${Number(p.estimatedCost).toLocaleString('en-IN')}` : '—'}
              isText
            />
          </div>

          {p.recipientCount === 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800 flex items-center gap-2">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              No recipients match — adjust the audience. You cannot send an empty broadcast.
            </div>
          )}

          {/* Cost note */}
          {template && (
            <p
              className={`text-[11px] ${
                categoryIsPaid(template.category) ? 'text-amber-700' : 'text-gray-500'
              }`}
            >
              {p.costNote ?? categoryCostNote(template.category)}
            </p>
          )}

          {/* Sample rendered message */}
          {p.sample && p.sample.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                <Copy className="w-3.5 h-3.5 text-gray-400" />
                Sample message{p.sample.length > 1 ? 's' : ''}
              </p>
              <div className="space-y-2">
                {p.sample.slice(0, 3).map((s, i) => (
                  <div
                    key={i}
                    className="border border-gray-200 rounded-xl overflow-hidden"
                    data-testid={`preview-sample-${i}`}
                  >
                    <div className="bg-gray-50 px-3 py-1.5 text-[11px] text-gray-500 flex items-center gap-1.5 border-b border-gray-100">
                      <Users className="w-3 h-3" />
                      To {maskPhone(s.phone)}
                    </div>
                    <div className="bg-[#e7ffdb] px-4 py-3 text-sm text-gray-800 whitespace-pre-wrap">
                      {s.renderedBody}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
  warn,
  isText,
  testId,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
  warn?: boolean;
  isText?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${
        highlight
          ? 'border-[var(--brand-primary)]/30 bg-[var(--brand-primary)]/5'
          : warn
            ? 'border-amber-200 bg-amber-50'
            : 'border-gray-200 bg-white'
      }`}
      data-testid={testId}
    >
      <p className="text-[11px] text-gray-500">{label}</p>
      <p
        className={`text-lg font-bold tabular-nums ${
          highlight ? 'text-[var(--brand-primary)]' : warn ? 'text-amber-700' : 'text-gray-900'
        }`}
      >
        {isText ? value : Number(value).toLocaleString('en-IN')}
      </p>
    </div>
  );
}

function maskPhone(phone: string): string {
  if (phone.length < 4) return phone;
  return `${phone.slice(0, 2)}••••${phone.slice(-2)}`;
}
