'use client';

/* ─── Off-portal payments — Upload (preview → tick every warning → confirm) ─────────────────────────────
   Gifsy admin (assumed) only — rendered by the page only when the register API says `canWrite`.
   1. Download the template, choose the filled file, Preview: the server classifies every row and lists each warning
      category with its count. Nothing is saved by a preview.
   2. Every warning category gets a checkbox; Confirm stays disabled until ALL are ticked (the server re-checks and
      refuses a confirm with a missing tick — that message is shown as-is).
   3. Confirm re-sends the SAME file + its preview fingerprint. One click = one request (in-flight guard).
──────────────────────────────────────────────────────────────────────────────────────────────────────── */

import React, { useRef, useState } from 'react';
import { CheckCircle2, Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';
import { formatISTDate } from '@/lib/ist-date';
import {
  categoryShort,
  formatPaiseString,
  MODE_LABEL,
  offPortalApi,
  STREAM_LABEL,
  type OffPortalPreview,
} from '@/lib/off-portal-payments';
import { ErrorBlock } from '../../fund/_components/fund-ui';

const LOST_REPLY_NOTE =
  'The server did not answer — the payments may or may not have been recorded. Check the register below before confirming again.';

export function OffPortalUploadPanel({ onRecorded }: { onRecorded: () => void }) {
  const template = useDownloadAction();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<OffPortalPreview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function reset(keepSuccess = false) {
    setPreview(null);
    setTicked(new Set());
    setError(null);
    if (!keepSuccess) setSuccess(null);
  }

  function onChoose(e: React.ChangeEvent<HTMLInputElement>) {
    // A new file always invalidates the previous preview (the fingerprint belongs to the old file).
    setFile(e.target.files?.[0] ?? null);
    reset();
  }

  async function runPreview() {
    if (!file || inFlight.current) return;
    inFlight.current = true;
    setBusy('preview');
    reset();
    const r = await offPortalApi.preview(file);
    if (r.ok) setPreview(r.data);
    else setError(r.message);
    setBusy(null);
    inFlight.current = false;
  }

  const required = preview?.requiredAcknowledgements ?? [];
  const allTicked = required.every((c) => ticked.has(c));
  const canConfirm = !!preview && !!file && allTicked && preview.recordableCount > 0 && busy === null;

  async function runConfirm() {
    if (!preview || !file || !allTicked || inFlight.current) return;
    inFlight.current = true;
    setBusy('confirm');
    setError(null);
    const r = await offPortalApi.confirm(file, preview.fileSha256, required.filter((c) => ticked.has(c)));
    if (r.ok) {
      setSuccess(r.data.message || `Recorded ${r.data.recorded} off-portal payments.`);
      setPreview(null);
      setTicked(new Set());
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      onRecorded();
    } else {
      setError(r.status ? r.message : `${r.message} ${LOST_REPLY_NOTE}`);
    }
    setBusy(null);
    inFlight.current = false;
  }

  function toggle(category: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  return (
    <section aria-labelledby="opp-upload-h" className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="opp-upload-h" className="text-sm font-semibold text-gray-900">Record payments made outside the portal</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            For payments already made by bank transfer, UPI or as a gift. They are counted in TDS, Fund Reconciliation,
            the outlet&apos;s payout history and the Payments Report. Nothing is paid by this screen.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={() => void template.run(offPortalApi.templateUrl, { fallbackFileName: 'off-portal-payments-template.xlsx' })}
            disabled={template.blocked}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            <Download className="h-3.5 w-3.5" aria-hidden /> {downloadButtonLabel(template, 'Download template')}
          </button>
          <DownloadActionStatus action={template} />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="opp-file" className="mb-1 block text-xs font-medium text-gray-700">Filled template (.xlsx)</label>
          <input
            id="opp-file"
            ref={fileInput}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onChoose}
            disabled={busy !== null}
            className="block text-xs text-gray-700 file:mr-3 file:rounded-lg file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-xs"
          />
        </div>
        <button
          type="button"
          onClick={() => void runPreview()}
          disabled={!file || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-primary)] px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy === 'preview' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden />}
          {busy === 'preview' ? 'Checking the file…' : 'Preview'}
        </button>
      </div>

      {error && <ErrorBlock message={error} />}
      {success && (
        <div role="status" data-testid="opp-confirm-success" className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden /> <span>{success}</span>
        </div>
      )}

      {preview && (
        <div className="space-y-4" data-testid="opp-preview">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <PreviewFact label="Rows in file" value={`${preview.rowsInFile}${preview.blankRows ? ` (${preview.blankRows} blank, ignored)` : ''}`} />
            <PreviewFact label="Will be recorded" value={`${preview.recordableCount} · ${formatPaiseString(preview.recordableTotalPaise)}`} testId="opp-recordable" />
            <PreviewFact label="Rows with errors (not recorded)" value={String(preview.invalidCount)} tone={preview.invalidCount ? 'bad' : undefined} />
            <PreviewFact
              label="Visibility TDS for this client"
              value={`${preview.tdsPolicy.visibilitySection} · ${preview.tdsPolicy.methodology === 'DEDUCT' ? 'Deduct' : 'Gross-up'}`}
            />
          </dl>

          {preview.recordableCount === 0 && (
            <ErrorBlock message="No row in this file can be recorded — fix the errors below and preview again." />
          )}

          {preview.categories.length > 0 ? (
            <fieldset className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <legend className="px-1 text-sm font-semibold text-amber-900">
                Tick every warning to confirm you have checked it ({ticked.size} of {required.length} ticked)
              </legend>
              {preview.categories.map((c) => (
                <label key={c.category} className="flex items-start gap-2 text-sm text-amber-900">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={ticked.has(c.category)}
                    onChange={() => toggle(c.category)}
                    disabled={busy !== null}
                    data-testid={`opp-ack-${c.category}`}
                  />
                  <span>
                    <span className="font-semibold">{c.count} row{c.count === 1 ? '' : 's'}:</span> {c.label}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="text-sm text-gray-600">No warnings — every row matches the portal.</p>
          )}

          {preview.invalid.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold text-red-800">Rows with errors — they will NOT be recorded</h3>
              <div className="overflow-x-auto rounded-lg border border-red-200">
                <table className="w-full text-xs" data-testid="opp-invalid-table">
                  <thead className="bg-red-50 text-left text-red-900">
                    <tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">Outlet ID</th><th className="px-3 py-2">Outlet name</th><th className="px-3 py-2">Errors</th></tr>
                  </thead>
                  <tbody className="divide-y divide-red-100">
                    {preview.invalid.map((r) => (
                      <tr key={r.rowNumber}>
                        <td className="px-3 py-2 tabular-nums">{r.rowNumber}</td>
                        <td className="px-3 py-2 font-mono">{r.outletCode || '—'}</td>
                        <td className="px-3 py-2">{r.outletName || '—'}</td>
                        <td className="px-3 py-2 text-red-700">{r.errors.join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.invalidTruncated && (
                <p className="mt-1 text-xs font-medium text-red-700">
                  Only the first {preview.invalid.length} rows with errors are shown — {preview.invalidCount} in all.
                </p>
              )}
            </div>
          )}

          {preview.rows.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold text-gray-900">Rows that will be recorded</h3>
              <div className="max-h-[28rem] overflow-auto rounded-lg border border-gray-200">
                <table className="w-full text-xs" data-testid="opp-preview-table">
                  <thead className="sticky top-0 bg-gray-50 text-left text-gray-600">
                    <tr>
                      <th className="px-3 py-2">Row</th><th className="px-3 py-2">Outlet</th><th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Paid on</th><th className="px-3 py-2">Month</th><th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">UTR / reference</th><th className="px-3 py-2">PAN</th><th className="px-3 py-2">TDS</th>
                      <th className="px-3 py-2">Warnings</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {preview.rows.map((r) => (
                      <tr key={r.rowNumber} className="align-top">
                        <td className="px-3 py-2 tabular-nums">{r.rowNumber}</td>
                        <td className="px-3 py-2">
                          <div className="font-mono">{r.outletCode}</div>
                          <div>{r.outletName}</div>
                          {r.onPortal
                            ? r.portalOutletName && r.portalOutletName !== r.outletName && <div className="text-gray-500">Portal: {r.portalOutletName}</div>
                            : <div className="text-gray-500">Not on the portal</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPaiseString(r.amountPaise)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatISTDate(r.paymentDate) || r.paymentDate}</td>
                        <td className="px-3 py-2">{r.period}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{STREAM_LABEL[r.payoutStream] ?? r.payoutStream} · {MODE_LABEL[r.paymentMode] ?? r.paymentMode}</td>
                        <td className="px-3 py-2 font-mono">{r.utr || '—'}</td>
                        <td className="px-3 py-2 font-mono">
                          {r.panNumber || '—'}
                          <div className="font-sans text-gray-500">{r.panSource === 'FILE' ? 'from file' : r.panSource === 'PORTAL' ? 'from portal' : 'no PAN'}</div>
                        </td>
                        <td className="px-3 py-2">{r.tdsSection}</td>
                        <td className="px-3 py-2 min-w-[12rem]">
                          {r.flags.length > 0 && (
                            <span className="flex flex-wrap gap-1">
                              {r.flags.map((f) => (
                                <span key={f} className="rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-800">{categoryShort(f)}</span>
                              ))}
                            </span>
                          )}
                          {r.notes.map((n, i) => <p key={i} className="mt-0.5 text-[11px] text-gray-600">{n}</p>)}
                          {r.flags.length === 0 && r.notes.length === 0 && <span className="text-gray-400">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rowsTruncated && (
                <p className="mt-1 text-xs font-medium text-amber-800">
                  Only the first {preview.rows.length} rows are shown here — all {preview.recordableCount} will be recorded.
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
            <button
              type="button"
              onClick={() => void runConfirm()}
              disabled={!canConfirm}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy === 'confirm' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {busy === 'confirm'
                ? 'Recording…'
                : `Confirm — record ${preview.recordableCount} payment${preview.recordableCount === 1 ? '' : 's'} (${formatPaiseString(preview.recordableTotalPaise)})`}
            </button>
            <button
              type="button"
              onClick={() => reset()}
              disabled={busy !== null}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            {!allTicked && <p className="text-xs text-amber-800">Tick every warning above to enable Confirm.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

function PreviewFact({ label, value, tone, testId }: { label: string; value: string; tone?: 'bad'; testId?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2" data-testid={testId}>
      <dt className="text-[11px] text-gray-500">{label}</dt>
      <dd className={`mt-0.5 font-semibold tabular-nums ${tone === 'bad' ? 'text-red-700' : 'text-gray-900'}`}>{value}</dd>
    </div>
  );
}
