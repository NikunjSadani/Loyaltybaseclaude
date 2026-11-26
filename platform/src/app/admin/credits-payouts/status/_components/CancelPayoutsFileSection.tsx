'use client';

/**
 * "Cancel payouts — upload file" (GIFSY_ADMIN working inside the client). Client-wide at the top of the page, and a
 * per-upload shortcut inside an expanded upload (batchId / fieldId pre-fill the template).
 *  - Download template → the unpaid / failed rows (xlsx) to mark Y.
 *  - Upload → preview (apply='false'): header error, rows to cancel (Unpaid vs Failed), every refused row with its row
 *    number + reason, rows not marked Y (kept).
 *  - Apply → the SAME file again with apply='true' + acknowledgedRowNums (every refused row must be acknowledged) +
 *    previewedEntryIds (the rows of the preview shown). A 409 refusal (details.blocked, or details.added/removed when
 *    the rows differ from the preview) is shown with its list — nothing was cancelled.
 *  - Any change to the file or the reason clears the preview + acknowledgements: Apply only ever runs on the preview
 *    currently shown.
 */
import { useId, useRef, useState } from 'react';
import { downloadBlob } from '@/lib/download';
import {
  apiJson, blockedFromDetails, CANCEL_REASON_MAX, inr, plural,
  type CancelRow, type CancelTotals, type InvoiceToVoid,
} from './payout-cancel-shared';

type FileOkRow = CancelRow & { rowNum: number; reason: string };
interface FileBlockedRow { rowNum: number; entryId: string; outletId: string; reason: string; code: string }

interface FilePreview {
  applied: false;
  fileName: string | null;
  headerError: string | null;
  notMarked: number;
  ok: FileOkRow[];
  blocked: FileBlockedRow[];
  invoicesToVoid: InvoiceToVoid[];
  totals: CancelTotals;
  canApply: boolean;
}

interface FileApplied {
  applied: true;
  cancellationId: string;
  cancelled: CancelRow[];
  invoicesVoided: InvoiceToVoid[];
  totals: CancelTotals;
  notCancelled: FileBlockedRow[];
}

/** 409 drift: the rows the server would cancel now differ from the preview that was shown. */
interface DriftAdded { entryId: string; rowNum: number; outletId: string }
interface DriftRemoved { entryId: string }

interface Refusal {
  message: string;
  blocked: FileBlockedRow[];
  added: DriftAdded[];
  removed: DriftRemoved[];
}

function driftFromDetails(details?: Record<string, unknown>): { added: DriftAdded[]; removed: DriftRemoved[] } | null {
  const added = details?.added;
  const removed = details?.removed;
  if (!Array.isArray(added) && !Array.isArray(removed)) return null;
  return {
    added: Array.isArray(added) ? (added as DriftAdded[]) : [],
    removed: Array.isArray(removed) ? (removed as DriftRemoved[]) : [],
  };
}

interface Props {
  /** Per-upload shortcut: limit the template to this upload (and field). Absent = client-wide. */
  batchId?: string;
  batchCode?: string;
  fieldId?: string;
  fieldName?: string | null;
  /** After a successful apply — the parent refreshes its figures. */
  onApplied?: () => void;
}

const UPLOAD_URL = '/api/admin/credits/payout-cancellations/upload';

export default function CancelPayoutsFileSection({ batchId, batchCode, fieldId, fieldName, onApplied }: Props) {
  const uid = useId();
  const [templateStatus, setTemplateStatus] = useState<'ALL' | 'PENDING' | 'FAILED'>('ALL');
  const [period, setPeriod] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [templateMsg, setTemplateMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [acked, setAcked] = useState<Set<number>>(() => new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [applied, setApplied] = useState<FileApplied | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Bumped on every input change — a file check that answers for older inputs is discarded. */
  const inputsVersionRef = useRef(0);

  async function downloadTemplate() {
    setDownloading(true);
    setTemplateMsg(null);
    try {
      const params = new URLSearchParams({ status: templateStatus });
      if (batchId) params.set('batchId', batchId);
      if (fieldId) params.set('fieldId', fieldId);
      if (!batchId && period) params.set('period', period);
      const res = await fetch(`/api/admin/credits/payout-cancellations/template?${params.toString()}`);
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setTemplateMsg({ type: 'err', text: `Template not downloaded: ${json?.error ?? `HTTP ${res.status}`}` });
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const name = /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? 'cancel-payouts.xlsx';
      downloadBlob(blob, name);
      setTemplateMsg({ type: 'ok', text: `Downloaded ${name}. Mark Y on the rows to cancel, then upload it below.` });
    } catch (e) {
      setTemplateMsg({ type: 'err', text: `Template not downloaded: ${String((e as Error)?.message ?? e)}` });
    } finally {
      setDownloading(false);
    }
  }

  /** Any change to what feeds the preview: the shown preview + acknowledgements no longer apply — clear them. */
  function invalidatePreview() {
    inputsVersionRef.current += 1;
    setPreview(null);
    setAcked(new Set());
    setConfirmed(false);
    setRefusal(null);
    setChecking(false);
  }

  function resetResult() {
    invalidatePreview();
    setError(null);
    setApplied(null);
  }

  function formFor(apply: boolean, ackRowNums?: number[], previewedEntryIds?: string[]): FormData {
    const fd = new FormData();
    fd.append('file', file as File);
    const r = reason.trim();
    if (r) fd.append('reason', r);
    fd.append('apply', apply ? 'true' : 'false');
    if (apply) {
      fd.append('acknowledgedRowNums', JSON.stringify(ackRowNums ?? []));
      fd.append('previewedEntryIds', JSON.stringify(previewedEntryIds ?? []));
    }
    return fd;
  }

  async function checkFile() {
    if (!file) return;
    resetResult();
    const version = inputsVersionRef.current;
    setChecking(true);
    const r = await apiJson<FilePreview>(UPLOAD_URL, { method: 'POST', body: formFor(false) });
    if (version !== inputsVersionRef.current) return; // the inputs changed meanwhile — this answer is stale
    setChecking(false);
    if (!r.ok || !Array.isArray(r.data?.ok)) {
      setError(r.ok ? 'The file check came back empty.' : r.error);
      return;
    }
    setPreview(r.data);
  }

  async function apply() {
    if (!file || !preview) return;
    setApplying(true);
    setError(null);
    setRefusal(null);
    const previewedEntryIds = preview.ok.map((row) => row.entryId);
    const r = await apiJson<FileApplied>(UPLOAD_URL, { method: 'POST', body: formFor(true, [...acked], previewedEntryIds) });
    setApplying(false);
    if (r.ok) {
      setApplied(r.data);
      setPreview(null);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      onApplied?.();
      return;
    }
    const blocked = blockedFromDetails<FileBlockedRow>(r.details);
    const drift = driftFromDetails(r.details);
    if (r.status === 409 || blocked || drift) {
      // Nothing was cancelled — the preview shown is no longer what would be applied; it must be previewed again.
      if (drift) {
        setPreview(null);
        setAcked(new Set());
        setConfirmed(false);
      }
      setRefusal({ message: r.error, blocked: blocked ?? [], added: drift?.added ?? [], removed: drift?.removed ?? [] });
      return;
    }
    setError(`Not cancelled: ${r.error}`);
  }

  const blocked = preview?.blocked ?? [];
  const allAcked = blocked.every((b) => acked.has(b.rowNum));
  const unpaidRows = (preview?.ok ?? []).filter((r) => r.kind !== 'FAILED' && r.status !== 'FAILED');
  const failedRows = (preview?.ok ?? []).filter((r) => r.kind === 'FAILED' || r.status === 'FAILED');
  const canApply = !!preview && preview.canApply && !preview.headerError && (preview.ok.length > 0) && allAcked && confirmed && !applying;

  const scope = batchId
    ? `upload ${batchCode ?? batchId}${fieldName ? ` — field ${fieldName}` : ''}`
    : 'every upload of this client';

  return (
    <section
      aria-labelledby={`${uid}-title`}
      data-testid={batchId ? `cancel-file-${batchId}` : 'cancel-file-client'}
      className="bg-white border border-red-200 rounded-xl p-4 space-y-3"
    >
      <div>
        <h3 id={`${uid}-title`} className="text-sm font-semibold text-gray-900">Cancel payouts — upload file</h3>
        <p className="text-xs text-gray-500">
          For {scope}. Download the template (unpaid and/or failed rows), mark Y on the rows to cancel, upload it and check
          the result before anything changes. Paid rows can&apos;t be cancelled.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-1 text-gray-600">
          Rows in the template
          <select value={templateStatus} onChange={(e) => setTemplateStatus(e.target.value as typeof templateStatus)} className="border border-gray-300 rounded-lg px-2 py-1.5">
            <option value="ALL">Unpaid and failed</option>
            <option value="PENDING">Unpaid only (never sent to the bank)</option>
            <option value="FAILED">Failed only</option>
          </select>
        </label>
        {!batchId && (
          <label className="flex flex-col gap-1 text-gray-600">
            Month (optional)
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1.5" />
          </label>
        )}
        <button
          type="button"
          onClick={() => void downloadTemplate()}
          disabled={downloading}
          className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          {downloading ? 'Preparing template…' : 'Download template'}
        </button>
      </div>
      {templateMsg && (
        <p role={templateMsg.type === 'err' ? 'alert' : 'status'} className={`text-xs ${templateMsg.type === 'err' ? 'text-red-700' : 'text-emerald-700'}`}>
          {templateMsg.text}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-1 text-gray-600">
          Filled-in file
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            aria-label="Cancellation file"
            disabled={applying}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); resetResult(); }}
            className="text-xs"
          />
        </label>
        <label className="flex flex-col gap-1 text-gray-600 grow min-w-[12rem]">
          Reason for the whole file (optional — else each row&apos;s reason)
          <input
            type="text"
            value={reason}
            maxLength={CANCEL_REASON_MAX}
            disabled={applying}
            onChange={(e) => { setReason(e.target.value); invalidatePreview(); }}
            aria-label="Reason for the whole file"
            className="border border-gray-300 rounded-lg px-2 py-1.5"
          />
        </label>
        <button
          type="button"
          onClick={() => void checkFile()}
          disabled={!file || checking || applying}
          className="px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check file'}
        </button>
      </div>

      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      {applied && (
        <div role="status" data-testid="cancel-file-applied" className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-xs text-emerald-800 space-y-1">
          <p className="font-semibold">
            Cancelled {plural(applied.cancelled.length, 'payout', 'payouts')} · {inr(applied.totals?.all?.paise ?? 0)}.
          </p>
          {applied.invoicesVoided.length > 0 && <p>Voided {plural(applied.invoicesVoided.length, 'invoice', 'invoices')}.</p>}
          {applied.notCancelled.length > 0 && (
            <p className="text-amber-800">
              Not cancelled (acknowledged): {applied.notCancelled.map((b) => `row ${b.rowNum} — ${b.reason}`).join('; ')}
            </p>
          )}
        </div>
      )}

      {refusal && (
        <div role="alert" data-testid="cancel-file-refused" className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-800 space-y-2">
          <p className="font-semibold">Nothing was cancelled. {refusal.message}</p>
          {refusal.blocked.length > 0 && <FileBlockedList rows={refusal.blocked} />}
          {(refusal.added.length > 0 || refusal.removed.length > 0) && (
            <div data-testid="cancel-file-drift" className="space-y-1">
              <p>The rows that would be cancelled are no longer the ones in the preview you checked. Preview the file again before cancelling.</p>
              {refusal.added.length > 0 && (
                <div>
                  <p className="font-medium">{plural(refusal.added.length, 'row', 'rows')} would now be cancelled that were not in the preview:</p>
                  <ul className="space-y-0.5 max-h-32 overflow-y-auto" data-testid="cancel-file-drift-added">
                    {refusal.added.map((a) => (
                      <li key={a.entryId}>Row {a.rowNum}{a.outletId ? ` · ${a.outletId}` : ''}</li>
                    ))}
                  </ul>
                </div>
              )}
              {refusal.removed.length > 0 && (
                <div>
                  <p className="font-medium">{plural(refusal.removed.length, 'row', 'rows')} in the preview can no longer be cancelled this way:</p>
                  <ul className="space-y-0.5 max-h-32 overflow-y-auto font-mono" data-testid="cancel-file-drift-removed">
                    {refusal.removed.map((r) => (
                      <li key={r.entryId}>{r.entryId}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <button type="button" onClick={() => void checkFile()} disabled={!file || checking} className="px-3 py-1.5 rounded-lg bg-white border border-red-300 hover:bg-red-50 disabled:opacity-50">
            {refusal.added.length > 0 || refusal.removed.length > 0 ? 'Preview again' : 'Check the file again'}
          </button>
        </div>
      )}

      {preview && (
        <div data-testid="cancel-file-preview" className="space-y-3 border-t border-gray-100 pt-3">
          {preview.headerError && (
            <p role="alert" data-testid="cancel-file-header-error" className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm font-semibold text-red-800">
              The file can&apos;t be read: {preview.headerError}
            </p>
          )}

          {!preview.headerError && (
            <>
              <p className="text-xs text-gray-700">
                {preview.fileName ? `${preview.fileName}: ` : ''}
                {plural(preview.ok.length, 'row', 'rows')} will be cancelled · total {inr(preview.totals.all.paise)}
                {preview.notMarked > 0 && ` · ${plural(preview.notMarked, 'row', 'rows')} not marked Y (kept)`}
              </p>
              <FileRowsGroup title="Unpaid — never sent to the bank" rows={unpaidRows} total={preview.totals.unpaid} testId="cancel-file-unpaid" />
              <FileRowsGroup title="Failed — will not be re-banked" rows={failedRows} total={preview.totals.failed} testId="cancel-file-failed" />
              {preview.invoicesToVoid.length > 0 && (
                <p className="text-xs text-gray-700">
                  {plural(preview.invoicesToVoid.length, 'invoice', 'invoices')} will be voided:{' '}
                  {preview.invoicesToVoid.map((iv) => iv.invoiceNumber ?? iv.id).join(', ')}
                </p>
              )}
            </>
          )}

          {blocked.length > 0 && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 space-y-2" data-testid="cancel-file-blocked">
              <p className="text-xs font-semibold text-amber-900">{plural(blocked.length, 'row', 'rows')} in the file will NOT be cancelled</p>
              <ul className="space-y-1 max-h-48 overflow-y-auto text-xs text-amber-900">
                {blocked.map((b) => (
                  <li key={`${b.rowNum}-${b.entryId}`}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={acked.has(b.rowNum)}
                        disabled={applying}
                        onChange={() => setAcked((cur) => {
                          const next = new Set(cur);
                          if (next.has(b.rowNum)) next.delete(b.rowNum); else next.add(b.rowNum);
                          return next;
                        })}
                        aria-label={`Acknowledge row ${b.rowNum} will not be cancelled`}
                      />
                      <span>Row {b.rowNum}{b.outletId ? ` · ${b.outletId}` : ''} — {b.reason}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <label className="flex items-start gap-2 text-xs font-medium text-amber-900">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={allAcked}
                  disabled={applying}
                  onChange={(e) => setAcked(e.target.checked ? new Set(blocked.map((b) => b.rowNum)) : new Set())}
                />
                Acknowledge all {plural(blocked.length, 'row', 'rows')} that will not be cancelled
              </label>
            </div>
          )}

          {!preview.headerError && preview.ok.length > 0 && (
            <>
              <label className="flex items-start gap-2 text-xs text-gray-800">
                <input type="checkbox" className="mt-0.5" checked={confirmed} disabled={applying} onChange={(e) => setConfirmed(e.target.checked)} />
                I have checked the rows and amounts above
              </label>
              <button
                type="button"
                onClick={() => void apply()}
                disabled={!canApply}
                className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {applying ? 'Cancelling…' : `Cancel ${plural(preview.ok.length, 'payout', 'payouts')} (${inr(preview.totals.all.paise)})`}
              </button>
              {!canApply && !applying && (
                <p className="text-[11px] text-gray-500">
                  To continue: {[
                    !allAcked ? 'acknowledge every row that will not be cancelled' : null,
                    !confirmed ? 'tick “I have checked the rows and amounts above”' : null,
                  ].filter(Boolean).join(', ') || 'this file cannot be applied'}.
                </p>
              )}
            </>
          )}
          {!preview.headerError && preview.ok.length === 0 && (
            <p className="text-xs text-gray-600">No row in this file can be cancelled — nothing will change.</p>
          )}
        </div>
      )}
    </section>
  );
}

function FileRowsGroup({ title, rows, total, testId }: { title: string; rows: FileOkRow[]; total: { count: number; paise: number }; testId: string }) {
  if (rows.length === 0) return null;
  return (
    <div data-testid={testId} className="space-y-1">
      <p className="text-xs font-semibold text-gray-800">{title}: {plural(total.count, 'row', 'rows')} · {inr(total.paise)}</p>
      <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              {['Row', 'Outlet', 'Field', 'Period', 'Amount', 'Bank file / failure', 'Reason'].map((h) => (
                <th key={h} className="px-2 py-1.5 text-left font-semibold text-gray-600">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((r) => (
              <tr key={r.entryId}>
                <td className="px-2 py-1 text-gray-500">{r.rowNum}</td>
                <td className="px-2 py-1 text-gray-800">{r.outletName} <span className="font-mono text-gray-500">{r.outletId}</span></td>
                <td className="px-2 py-1 text-gray-700">{r.fieldName}</td>
                <td className="px-2 py-1 text-gray-700">{r.period}</td>
                <td className="px-2 py-1 text-right text-gray-900 whitespace-nowrap">{inr(r.amountPaise)}</td>
                <td className="px-2 py-1 text-gray-700">
                  {r.status === 'FAILED' ? `${r.downloadCode ?? ''}${r.failureReason ? ` — ${r.failureReason}` : ''}` || 'Failed' : 'Never sent to the bank'}
                </td>
                <td className="px-2 py-1 text-gray-700">{r.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FileBlockedList({ rows }: { rows: FileBlockedRow[] }) {
  return (
    <ul className="space-y-0.5 max-h-40 overflow-y-auto" data-testid="cancel-file-refused-list">
      {rows.map((b) => (
        <li key={`${b.rowNum}-${b.entryId}`}>Row {b.rowNum}{b.outletId ? ` · ${b.outletId}` : ''} — <strong>{b.reason}</strong></li>
      ))}
    </ul>
  );
}
