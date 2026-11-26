'use client';

/**
 * Confirmation dialog for an on-screen payout cancellation (GIFSY_ADMIN working inside the client).
 *  1. POST …/payout-cancellations/preview → exactly the rows that WILL be cancelled, the invoices that will be voided,
 *     and every row that can NOT be cancelled (with its reason).
 *  2. The admin must: acknowledge the refused rows (when any), give a reason, and tick "I have checked …".
 *  3. POST …/payout-cancellations with exactly the previewed rows (status + amount the admin saw). The server refuses
 *     the WHOLE request (409, details.blocked) if any row changed meanwhile — shown with "Reload preview".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiJson, blockedFromDetails, CANCEL_REASON_MAX, fmtDate, inr, KIND_ACTION_LABEL, plural, useDialogA11y,
  type CancelBlocked, type CancelPreview, type CancelResult, type CancelRow, type InvoiceToVoid,
} from './payout-cancel-shared';
import type { CancelRequest } from './PayoutEntriesTable';

interface Props {
  request: CancelRequest;
  onClose: () => void;
  /** Called once after a successful cancellation (the parent refreshes the figures, rows and history). */
  onDone: (result: CancelResult) => void;
}

type Phase = 'loading' | 'error' | 'ready' | 'submitting' | 'refused' | 'done';

export default function CancelPayoutsDialog({ request, onClose, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [ackBlocked, setAckBlocked] = useState(false);
  const [checked, setChecked] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ message: string; blocked: CancelBlocked[] } | null>(null);
  const [result, setResult] = useState<CancelResult | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);

  const loadPreview = useCallback(async () => {
    const req = ++reqRef.current;
    setPhase('loading');
    setLoadError(null);
    setRefusal(null);
    setSubmitError(null);
    setAckBlocked(false);
    setChecked(false);
    const body = request.entryIds
      ? { kind: request.kind, entryIds: request.entryIds }
      : { kind: request.kind, batchId: request.batchId, ...(request.fieldId ? { fieldId: request.fieldId } : {}) };
    const r = await apiJson<CancelPreview>('/api/admin/credits/payout-cancellations/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (req !== reqRef.current) return;
    if (!r.ok || !Array.isArray(r.data?.ok)) {
      setLoadError(r.ok ? 'The preview came back empty.' : r.error);
      setPhase('error');
      return;
    }
    setPreview(r.data);
    setPhase('ready');
  }, [request]);

  useEffect(() => { void loadPreview(); }, [loadPreview]);

  const close = useCallback(() => {
    if (phase === 'submitting') return; // never walk away from a write in flight
    reqRef.current++;
    onClose();
  }, [phase, onClose]);
  const onKeyDown = useDialogA11y(dialogRef, close);

  const ok = preview?.ok ?? [];
  const blocked = preview?.blocked ?? [];
  const okTotal = ok.reduce((s, r) => s + r.amountPaise, 0);
  const trimmed = reason.trim();
  const canSubmit =
    phase === 'ready' && ok.length > 0 && trimmed.length > 0 && checked && (blocked.length === 0 || ackBlocked);

  async function submit() {
    if (!preview || !canSubmit) return;
    setPhase('submitting');
    setSubmitError(null);
    const r = await apiJson<CancelResult>('/api/admin/credits/payout-cancellations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: preview.kind,
        reason: trimmed,
        items: preview.ok.map((row) => ({ id: row.entryId, expectedStatus: row.status, expectedAmountPaise: row.amountPaise })),
      }),
    });
    if (r.ok) {
      setResult(r.data);
      setPhase('done');
      onDone(r.data);
      return;
    }
    const refused = blockedFromDetails<CancelBlocked>(r.details);
    if (r.status === 409 || refused) {
      setRefusal({ message: r.error, blocked: refused ?? [] });
      setPhase('refused');
      return;
    }
    setSubmitError(`Not cancelled: ${r.error}`);
    setPhase('ready');
  }

  const title = KIND_ACTION_LABEL[request.kind];

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-payouts-title"
        onKeyDown={onKeyDown}
        data-testid="cancel-payouts-dialog"
        className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 id="cancel-payouts-title" className="font-bold text-gray-900">{title}</h3>
          <button type="button" onClick={close} disabled={phase === 'submitting'} aria-label="Close" className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
        </div>
        <p className="text-xs text-gray-600">Chosen: {request.scopeLabel}</p>

        {phase === 'loading' && <p role="status" className="text-xs text-gray-500 animate-pulse">Checking which rows can be cancelled…</p>}

        {phase === 'error' && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">
            <span>Couldn&apos;t prepare the cancellation: {loadError}</span>
            <button type="button" onClick={() => void loadPreview()} className="px-2.5 py-1 rounded-lg border border-red-200 bg-white hover:bg-red-50">
              Retry
            </button>
          </div>
        )}

        {phase === 'done' && result && (
          <div role="status" data-testid="cancel-done" className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-xs text-emerald-800 space-y-1">
            <p className="font-semibold">
              Cancelled {plural(result.cancelled.length, 'payout', 'payouts')} · {inr(result.totals?.all?.paise ?? result.cancelled.reduce((s, r) => s + r.amountPaise, 0))}.
            </p>
            {result.invoicesVoided.length > 0 && (
              <p>Voided {plural(result.invoicesVoided.length, 'invoice', 'invoices')}: {result.invoicesVoided.map(invoiceLabel).join(', ')}.</p>
            )}
            <p>These rows will never go into a bank file. The figures, the rows and the history below were refreshed.</p>
            <button type="button" onClick={close} className="mt-2 px-3 py-1.5 rounded-lg border border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-50">
              Close
            </button>
          </div>
        )}

        {phase === 'refused' && refusal && (
          <div role="alert" data-testid="cancel-refused" className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-800 space-y-2">
            <p className="font-semibold">Nothing was cancelled. {refusal.message}</p>
            {refusal.blocked.length > 0 && <BlockedList blocked={refusal.blocked} testId="cancel-refused-list" />}
            <div className="flex gap-2">
              <button type="button" onClick={() => void loadPreview()} className="px-3 py-1.5 rounded-lg bg-white border border-red-300 hover:bg-red-50">
                Reload preview
              </button>
              <button type="button" onClick={close} className="px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50">
                Close
              </button>
            </div>
          </div>
        )}

        {(phase === 'ready' || phase === 'submitting') && preview && (
          <>
            <section aria-label="Rows that will be cancelled" className="space-y-1">
              <h4 className="text-xs font-semibold text-gray-800">
                {ok.length > 0
                  ? `${plural(ok.length, 'row', 'rows')} will be cancelled · total ${inr(okTotal)}`
                  : 'No row can be cancelled'}
              </h4>
              {ok.length > 0 ? <RowsTable rows={ok} /> : (
                <p className="text-xs text-gray-600">None of the chosen rows can be cancelled — see the reasons below. Nothing will change.</p>
              )}
            </section>

            {preview.invoicesToVoid.length > 0 && (
              <section aria-label="Invoices that will be voided" data-testid="cancel-invoices" className="space-y-1">
                <h4 className="text-xs font-semibold text-gray-800">
                  {plural(preview.invoicesToVoid.length, 'invoice', 'invoices')} will be voided (their payouts are cancelled)
                </h4>
                <ul className="text-xs text-gray-700 space-y-0.5 max-h-32 overflow-y-auto">
                  {preview.invoicesToVoid.map((iv) => (
                    <li key={iv.id}>
                      {invoiceLabel(iv)} · {iv.outletCode ?? '—'} · {iv.period ?? '—'} · {inr(iv.totalPaise)}
                      {iv.gstHeldPaise > 0 && ` (GST held ${inr(iv.gstHeldPaise)} — no longer released)`}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {blocked.length > 0 && (
              <section aria-label="Rows that will NOT be cancelled" className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 space-y-2">
                <h4 className="text-xs font-semibold text-amber-900">
                  {plural(blocked.length, 'row', 'rows')} will NOT be cancelled
                </h4>
                <BlockedList blocked={blocked} testId="cancel-blocked-list" />
                <label className="flex items-start gap-2 text-xs text-amber-900">
                  <input type="checkbox" className="mt-0.5" checked={ackBlocked} onChange={(e) => setAckBlocked(e.target.checked)} disabled={phase === 'submitting'} />
                  I understand these {plural(blocked.length, 'row', 'rows')} will NOT be cancelled
                </label>
              </section>
            )}

            {ok.length > 0 && (
              <>
                <div className="space-y-1">
                  <label htmlFor="cancel-reason" className="text-xs font-medium text-gray-700">Reason (required)</label>
                  <textarea
                    id="cancel-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={CANCEL_REASON_MAX}
                    rows={2}
                    disabled={phase === 'submitting'}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                  <p className="text-[11px] text-gray-500">{reason.length}/{CANCEL_REASON_MAX}</p>
                </div>
                <label className="flex items-start gap-2 text-xs text-gray-800">
                  <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={phase === 'submitting'} />
                  I have checked the rows and amounts above
                </label>
              </>
            )}

            {submitError && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">{submitError}</p>}

            <div className="flex gap-3 pt-1">
              {ok.length > 0 && (
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!canSubmit}
                  className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
                >
                  {phase === 'submitting' ? 'Cancelling…' : `Cancel ${plural(ok.length, 'payout', 'payouts')} (${inr(okTotal)})`}
                </button>
              )}
              <button type="button" onClick={close} disabled={phase === 'submitting'} className="px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
                Keep them
              </button>
            </div>
            {ok.length > 0 && !canSubmit && phase === 'ready' && (
              <p className="text-[11px] text-gray-500" data-testid="cancel-submit-hint">
                To continue: {[
                  blocked.length > 0 && !ackBlocked ? 'acknowledge the rows that will not be cancelled' : null,
                  trimmed.length === 0 ? 'give a reason' : null,
                  !checked ? 'tick “I have checked the rows and amounts above”' : null,
                ].filter(Boolean).join(', ')}.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function invoiceLabel(iv: InvoiceToVoid): string {
  return iv.invoiceNumber ?? `invoice ${iv.id}`;
}

function RowsTable({ rows }: { rows: CancelRow[] }) {
  return (
    <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-lg" data-testid="cancel-ok-list">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 sticky top-0">
          <tr>
            {['Outlet', 'Field', 'Period', 'Amount', 'Bank file / failure'].map((h) => (
              <th key={h} className="px-3 py-1.5 text-left font-semibold text-gray-600">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((r) => (
            <tr key={r.entryId} data-testid={`cancel-ok-${r.entryId}`}>
              <td className="px-3 py-1.5 text-gray-800">{r.outletName} <span className="font-mono text-gray-500">{r.outletId}</span></td>
              <td className="px-3 py-1.5 text-gray-700">{r.fieldName}</td>
              <td className="px-3 py-1.5 text-gray-700">{r.period}</td>
              <td className="px-3 py-1.5 text-right text-gray-900 whitespace-nowrap">{inr(r.amountPaise)}</td>
              <td className="px-3 py-1.5 text-gray-700">
                {r.kind === 'FAILED' || r.status === 'FAILED'
                  ? <>Failed{r.downloadCode ? ` in ${r.downloadCode}` : ''}{r.failureReason ? ` — ${r.failureReason}` : ''}{r.attemptedAt ? ` (${fmtDate(r.attemptedAt)})` : ''}</>
                  : 'Never sent to the bank'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlockedList({ blocked, testId }: { blocked: CancelBlocked[]; testId: string }) {
  return (
    <ul className="text-xs space-y-0.5 max-h-40 overflow-y-auto" data-testid={testId}>
      {blocked.map((b, i) => (
        <li key={`${b.entryId}-${i}`}>
          {b.row
            ? `${b.row.outletName} (${b.row.outletId}) · ${b.row.fieldName} · ${b.row.period} · ${inr(b.row.amountPaise)}`
            : `Payout row ${b.entryId}`}
          {' — '}<strong>{b.reason}</strong>
        </li>
      ))}
    </ul>
  );
}
