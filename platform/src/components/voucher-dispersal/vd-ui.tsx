'use client';

/* Small shared pieces for the Voucher Dispersal console (/gifsy/voucher-dispersal) â€” dark Gifsy shell. */

import React from 'react';
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { VD_TEMPLATE_URL, type Tone } from '@/lib/voucher-dispersal';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

/** "Download template" â€” GET /template.xlsx through the shared download state machine. */
export function TemplateDownloadButton() {
  const action = useDownloadAction();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void action.run(VD_TEMPLATE_URL, { fallbackFileName: 'voucher-dispersal-template.xlsx' })}
        disabled={action.blocked}
        aria-busy={action.busy}
        className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60"
      >
        {action.busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />}
        {downloadButtonLabel(action, 'Download template')}
      </button>
      <DownloadActionStatus action={action} tone="dark" downloadsHref="/gifsy/downloads" />
    </div>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-white/10 text-white/70 border-white/10',
  info: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  progress: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  success: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  warning: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  danger: 'bg-red-500/15 text-red-300 border-red-500/30',
};

export function StatusChip({ label, tone, testId }: { label: string; tone: Tone; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[tone]}`}
    >
      {label}
    </span>
  );
}

export function Tile({ label, value, tone = 'neutral', testId }: { label: string; value: React.ReactNode; tone?: Tone; testId?: string }) {
  const accent =
    tone === 'danger' ? 'text-red-300' : tone === 'warning' ? 'text-amber-300' : tone === 'success' ? 'text-emerald-300' : 'text-white';
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 min-w-0" data-testid={testId}>
      <p className="text-[11px] uppercase tracking-wide text-white/50 truncate">{label}</p>
      <p className={`text-lg font-bold ${accent} truncate`}>{value}</p>
    </div>
  );
}

export function ErrorPanel({ message, onRetry, testId = 'vd-error' }: { message: string; onRetry?: () => void; testId?: string }) {
  return (
    <div role="alert" data-testid={testId} className="flex flex-wrap items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      <p className="flex-1 min-w-0 break-words">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/40 px-2.5 py-1 text-xs font-semibold text-red-100 hover:bg-red-500/20"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Try again
        </button>
      )}
    </div>
  );
}

export function LoadingBlock({ label, testId = 'vd-loading' }: { label: string; testId?: string }) {
  return (
    <div role="status" data-testid={testId} className="flex items-center justify-center gap-2 py-16 text-sm text-white/50">
      <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> {label}
    </div>
  );
}

/**
 * Confirm dialog on the shared Radix Modal (role="dialog", aria-modal, focus trap, Escape closes).
 * While the action is in flight the dialog cannot be dismissed and the confirm button is disabled.
 * A refusal from the server is shown inside the dialog verbatim.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Close',
  busyLabel,
  busy,
  error,
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  /** One-line summary announced as the dialog's description (aria-describedby). */
  description: string;
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busyLabel: string;
  busy: boolean;
  error: string | null;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={title} description={description}>
      <div className="space-y-4 text-sm text-gray-700">
        {children}
        {error && (
          <p role="alert" data-testid="vd-dialog-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700 break-words">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
            data-testid="vd-dialog-confirm"
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-60 ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-900 hover:bg-gray-800'}`}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
