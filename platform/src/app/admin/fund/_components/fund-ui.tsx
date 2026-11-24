'use client';

import React from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { formatInrPaise } from '@/lib/money-format';
import { flagChip, flagDetail, STATUS_LABELS, type FundStatus } from '@/lib/fund';

/** ₹ from integer paise, en-IN grouping. `signed` colours negative red and positive green. */
export function Money({ paise, signed = false, className = '' }: { paise: number | null | undefined; signed?: boolean; className?: string }) {
  const v = typeof paise === 'number' ? paise : 0;
  const colour = !signed ? '' : v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : 'text-gray-500';
  const text = signed && v > 0 ? `+${formatInrPaise(v)}` : formatInrPaise(v);
  return <span className={`tabular-nums ${colour} ${className}`}>{text}</span>;
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden />
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-auto font-medium underline">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyBlock({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-gray-500">{children}</p>;
}

const STATUS_STYLES: Record<FundStatus, string> = {
  COMMITTED: 'bg-amber-100 text-amber-800',
  PAID: 'bg-green-100 text-green-800',
  RETURNED: 'bg-gray-100 text-gray-700',
};

export function StatusPill({ status }: { status: FundStatus | null }) {
  if (!status) return <span className="text-gray-400">—</span>;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function FlagChips({ flags }: { flags: string[] }) {
  if (!flags?.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span
          key={f}
          title={flagDetail(f)}
          className="inline-block rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-800"
        >
          {flagChip(f)}
        </span>
      ))}
    </span>
  );
}

/** C4: what each flag on screen means, as visible text (the chips' hover text is a convenience only). */
export function FlagLegend({ flags, testId }: { flags: string[]; testId?: string }) {
  const uniq = [...new Set(flags)];
  if (uniq.length === 0) return null;
  return (
    <dl data-testid={testId} className="space-y-1 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-xs text-orange-900">
      <p className="font-semibold">What the flags mean</p>
      {uniq.map((f) => (
        <div key={f} className="flex flex-wrap gap-1">
          <dt className="font-semibold">{flagChip(f)}:</dt>
          <dd>{flagDetail(f)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Labelled form field. The label is bound to the control via htmlFor/id; the hint and the field's error are linked
 * to the control with aria-describedby (and aria-invalid when there is an error) — C15.
 */
export function Field({
  id, label, hint, error, children,
}: { id: string; label: string; hint?: React.ReactNode; error?: string | null; children: React.ReactNode }) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        'aria-describedby': describedBy,
        ...(error ? { 'aria-invalid': true } : {}),
      })
    : children;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      {control}
      {hint && <p id={hintId} className="mt-1 text-xs text-gray-500">{hint}</p>}
      {error && <p id={errId} className="mt-1 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}

export const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] aria-[invalid=true]:border-red-500';

/** Server max lengths (api/src/fund/dto/fund.dto.ts) — the inputs never accept more (C15). */
export const MAXLEN = { reference: 100, bank: 100, paymentMode: 40, notes: 500, reason: 500, rateNote: 300 } as const;

/** Focus the first field whose id is listed (the first invalid field) — C15. */
export function focusField(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (el && typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();
}
