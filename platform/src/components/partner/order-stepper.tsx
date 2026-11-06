import React from 'react';
import { CheckCircle, Clock, XCircle } from 'lucide-react';
import type { OrderStep, StepState } from '@/lib/order-timeline';
import { formatDateTime } from '@/lib/utils';

/* Partner order stepper (docs/plans/ORDER-TIMELINE-STEPPER-PLAN.md, owner D2):
   - compact: a horizontal dot + connector bar on every order card (no dates, no fetch);
   - detail: the dated vertical stepper behind "View timeline".
   Visual language copied (not imported) from the sales KYC ApprovalTimeline: emerald
   complete, amber current, red failed, grey upcoming. */

const DOT: Record<StepState, string> = {
  complete: 'bg-emerald-100 border-emerald-500 text-emerald-600',
  current: 'bg-amber-100 border-amber-500 text-amber-600',
  failed: 'bg-red-100 border-red-500 text-red-600',
  upcoming: 'bg-gray-100 border-gray-300 text-gray-300',
};

/** Connector tone = the state of the step it leads INTO (never green into a failed step). */
type Tone = 'complete' | 'failed' | 'upcoming';
const toneInto = (next: OrderStep): Tone =>
  next.state === 'failed' ? 'failed' : next.state === 'upcoming' ? 'upcoming' : 'complete';
const TONE: Record<Tone, string> = { complete: 'bg-emerald-400', failed: 'bg-red-300', upcoming: 'bg-gray-200' };
const SR_STATE: Record<StepState, string> = {
  complete: 'completed', current: 'current', upcoming: 'upcoming', failed: 'failed',
};

function DotIcon({ state, size }: { state: StepState; size: string }) {
  if (state === 'complete') return <CheckCircle className={size} />;
  if (state === 'current') return <Clock className={size} />;
  if (state === 'failed') return <XCircle className={size} />;
  return <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />;
}

export function OrderStepper({ steps, variant }: { steps: OrderStep[]; variant: 'compact' | 'detail' }) {
  if (variant === 'compact') {
    const next = steps.find((s) => s.state === 'upcoming');
    return (
      <div className="mt-3">
        <ol data-testid="order-stepper-compact" className="flex items-center w-full" aria-label="Order progress">
          {steps.map((s, i) => (
            <li
              key={s.key}
              data-testid={`order-compact-step-${s.key}`}
              data-state={s.state}
              aria-label={`${s.label} — ${s.state}`}
              aria-current={s.state === 'current' ? 'step' : undefined}
              className={`flex items-center ${i < steps.length - 1 ? 'flex-1' : ''}`}
            >
              <span
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${DOT[s.state]}`}
              >
                <DotIcon state={s.state} size="h-3 w-3" />
              </span>
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  data-testid={`order-compact-connector-${s.key}`}
                  data-tone={toneInto(steps[i + 1])}
                  className={`flex-1 h-0.5 mx-1 ${TONE[toneInto(steps[i + 1])]}`}
                />
              )}
            </li>
          ))}
        </ol>
        {next && (
          <p data-testid="order-stepper-next" className="mt-1 text-[11px] text-gray-500">
            Next: <span className="font-medium text-gray-700">{next.label}</span>
          </p>
        )}
      </div>
    );
  }

  return (
    <ol data-testid="order-stepper-detail" className="mt-3 space-y-0">
      {steps.map((s, i) => (
        <li
          key={s.key}
          data-testid={`order-step-${s.key}`}
          data-state={s.state}
          aria-current={s.state === 'current' ? 'step' : undefined}
          className="flex gap-3"
        >
          <div className="flex flex-col items-center">
            <span className={`w-7 h-7 rounded-full border-2 flex items-center justify-center shrink-0 ${DOT[s.state]}`}>
              <DotIcon state={s.state} size="h-3.5 w-3.5" />
            </span>
            {i < steps.length - 1 && (
              <span aria-hidden="true" className={`w-0.5 flex-1 min-h-3 ${TONE[toneInto(steps[i + 1])]}`} />
            )}
          </div>
          <div className="pb-3 min-w-0">
            <p
              className={`text-xs ${s.state === 'upcoming' ? 'text-gray-400' : 'text-gray-800'} ${
                s.state === 'current' || s.state === 'failed' ? 'font-semibold' : 'font-medium'
              } ${s.state === 'failed' ? 'text-red-700' : ''}`}
            >
              {s.label} <span className="sr-only">({SR_STATE[s.state]})</span>
            </p>
            {s.date && (
              <p data-testid={`order-step-date-${s.key}`} className="text-xs text-gray-400">
                {formatDateTime(s.date)}
              </p>
            )}
            {s.sublabel && <p className="text-xs text-gray-500 mt-0.5">{s.sublabel}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
