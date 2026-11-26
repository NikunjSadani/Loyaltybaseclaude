'use client';

/* ─── Off-portal payments — Upload (preview → review every warning → tick → confirm) ─────────────────────
   Gifsy admin (assumed) only — rendered by the page only when the register API says `canWrite`.
   1. Download the template, choose the filled file, Preview: the server classifies EVERY row (uncapped) and lists each
      warning category with its count. Nothing is saved by a preview.
   2. B1: every warning category is its own section listing ALL of its rows (paged, with a filter). A category's
      checkbox is enabled only after its rows have been shown (the section opened). Confirm stays disabled until every
      category is ticked. The full row table (filter by category) is kept below.
   3. Confirm re-sends the SAME file + its preview fingerprint. One click = one request (in-flight guard).
   4. B3: a confirm refused for a missing tick (the file / portal changed since the preview) re-runs the preview with the
      same file and says "Preview updated — review the new warning"; the new category is unticked and must be opened.
──────────────────────────────────────────────────────────────────────────────────────────────────────── */

import React, { useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';
import { formatISTDate } from '@/lib/ist-date';
import {
  categoryShort,
  formatPaiseString,
  missingAcknowledgementsOf,
  MODE_LABEL,
  offPortalApi,
  STREAM_LABEL,
  type OffPortalPreview,
  type OffPortalPreviewRow,
} from '@/lib/off-portal-payments';
import { ErrorBlock, inputCls } from '../../fund/_components/fund-ui';

const LOST_REPLY_NOTE =
  'The server did not answer — the payments may or may not have been recorded. Check the register below before confirming again.';

/** Rows per page inside a category section and in the full table. */
export const PREVIEW_PAGE_SIZE = 50;

type InvalidRow = OffPortalPreview['invalid'][number];

/** The rows a category lists: INVALID → the error rows; any other → the recordable rows carrying that flag. */
function rowsOfCategory(p: OffPortalPreview, category: string): Array<OffPortalPreviewRow | InvalidRow> {
  return category === 'INVALID' ? p.invalid : p.rows.filter((r) => r.flags.includes(category));
}

function matchesText(r: OffPortalPreviewRow | InvalidRow, q: string): boolean {
  if (!q) return true;
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const hay = [r.outletCode, r.outletName, 'utr' in r ? r.utr : null, 'panNumber' in r ? r.panNumber : null, String(r.rowNumber)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(s);
}

export function OffPortalUploadPanel({ onRecorded }: { onRecorded: () => void }) {
  const template = useDownloadAction();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<OffPortalPreview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  /** Categories whose rows have been shown (section opened at least once) — their checkbox is enabled. */
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  /** B3: the categories a refused confirm reported (shown as "new" after the automatic re-preview). */
  const [updatedFor, setUpdatedFor] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function reset(keepSuccess = false) {
    setPreview(null);
    setTicked(new Set());
    setRevealed(new Set());
    setUpdatedFor(null);
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
    setUpdatedFor(null);
    const r = await offPortalApi.confirm(file, preview.fileSha256, required.filter((c) => ticked.has(c)));
    if (r.ok) {
      setSuccess(r.data.message || `Recorded ${r.data.recorded} off-portal payments.`);
      setPreview(null);
      setTicked(new Set());
      setRevealed(new Set());
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setBusy(null);
      inFlight.current = false;
      onRecorded();
      return;
    }
    const missing = missingAcknowledgementsOf(r);
    if (r.status === 400 && missing.length > 0) {
      // B3: something changed since the preview — re-run it with the SAME file so the new warning is listed.
      setBusy('preview');
      const old = preview;
      const again = await offPortalApi.preview(file);
      if (again.ok) {
        const oldCount = new Map(old.categories.map((c) => [c.category, c.count]));
        // A tick / reveal survives only for a category that is unchanged (same count) and not reported as missing.
        const keep = (c: { category: string; count: number }) => !missing.includes(c.category) && oldCount.get(c.category) === c.count;
        const kept = again.data.categories.filter(keep).map((c) => c.category);
        setTicked(new Set(kept.filter((c) => ticked.has(c))));
        setRevealed(new Set(kept.filter((c) => revealed.has(c))));
        setPreview(again.data);
        setUpdatedFor(missing);
      } else {
        setError(`${r.message} The preview could not be refreshed: ${again.message} Preview the file again.`);
      }
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

  const reveal = (category: string) => setRevealed((prev) => (prev.has(category) ? prev : new Set(prev).add(category)));

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
          {updatedFor && (
            <div role="alert" data-testid="opp-preview-updated" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold">Preview updated — review the new warning</p>
              <p className="mt-0.5 text-xs">
                Nothing was recorded. Since the first preview the server found:{' '}
                {updatedFor.map((c) => preview.categories.find((x) => x.category === c)?.label ?? categoryShort(c)).join('; ')}.
                Open its rows below and tick it before confirming.
              </p>
            </div>
          )}

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
            <div className="space-y-2">
              <p className="text-sm font-semibold text-amber-900">
                Review every warning — open its rows, then tick it ({ticked.size} of {required.length} ticked)
              </p>
              {preview.categories.map((c) => (
                <CategorySection
                  // A changed / newly reported category remounts closed, so its rows must be opened again.
                  key={`${c.category}|${c.count}|${updatedFor?.includes(c.category) ? 'new' : ''}`}
                  preview={preview}
                  category={c.category}
                  label={c.label}
                  count={c.count}
                  isNew={!!updatedFor?.includes(c.category)}
                  revealed={revealed.has(c.category)}
                  ticked={ticked.has(c.category)}
                  disabled={busy !== null}
                  onReveal={() => reveal(c.category)}
                  onToggle={() => toggle(c.category)}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-600">No warnings — every row matches the portal.</p>
          )}

          {preview.rows.length > 0 && <AllRowsTable preview={preview} />}

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
            {!allTicked && <p className="text-xs text-amber-800">Open and tick every warning above to enable Confirm.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

/** One warning category: header (checkbox + label + count + open/close) and, once open, ALL of its rows (paged). */
function CategorySection({
  preview, category, label, count, isNew, revealed, ticked, disabled, onReveal, onToggle,
}: {
  preview: OffPortalPreview; category: string; label: string; count: number; isNew: boolean;
  revealed: boolean; ticked: boolean; disabled: boolean; onReveal: () => void; onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const all = useMemo(() => rowsOfCategory(preview, category), [preview, category]);
  const filtered = useMemo(() => all.filter((r) => matchesText(r, q)), [all, q]);
  const pages = Math.max(1, Math.ceil(filtered.length / PREVIEW_PAGE_SIZE));
  const shownPage = Math.min(page, pages);
  const slice = filtered.slice((shownPage - 1) * PREVIEW_PAGE_SIZE, shownPage * PREVIEW_PAGE_SIZE);
  const bodyId = `opp-cat-${category}-rows`;
  const isInvalid = category === 'INVALID';

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) onReveal();
  }

  return (
    <div data-testid={`opp-cat-${category}`} className={`rounded-xl border px-4 py-3 ${isInvalid ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
      <div className="flex flex-wrap items-start gap-2">
        <input
          id={`opp-ack-${category}`}
          type="checkbox"
          className="mt-1"
          checked={ticked}
          onChange={onToggle}
          disabled={disabled || !revealed}
          data-testid={`opp-ack-${category}`}
          aria-describedby={!revealed ? `opp-ack-${category}-hint` : undefined}
        />
        <label htmlFor={`opp-ack-${category}`} className={`flex-1 text-sm ${isInvalid ? 'text-red-900' : 'text-amber-900'}`}>
          {isNew && <span className="mr-1 rounded bg-amber-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">New</span>}
          <span className="font-semibold">{count} row{count === 1 ? '' : 's'}:</span> {label}
          {!revealed && (
            <span id={`opp-ack-${category}-hint`} className="block text-xs font-medium text-amber-800">Open the rows to enable this tick.</span>
          )}
        </label>
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={`opp-cat-toggle-${category}`}
          className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          {open ? 'Hide rows' : `Show ${all.length} row${all.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {open && (
        <div id={bodyId} className="mt-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-64">
              <label htmlFor={`${bodyId}-q`} className="mb-1 block text-[11px] font-medium text-gray-700">Filter these rows</label>
              <input
                id={`${bodyId}-q`}
                type="search"
                className={inputCls}
                placeholder="Outlet ID, name, UTR, PAN or row"
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1); }}
              />
            </div>
            <p className="text-xs text-gray-600">{filtered.length === all.length ? `${all.length} rows` : `${filtered.length} of ${all.length} rows match`}</p>
          </div>
          {slice.length === 0 ? (
            <p className="text-xs text-gray-600">No rows match this filter.</p>
          ) : isInvalid ? (
            <InvalidTable rows={slice as InvalidRow[]} testId={`opp-cat-table-${category}`} />
          ) : (
            <RowsTable rows={slice as OffPortalPreviewRow[]} testId={`opp-cat-table-${category}`} />
          )}
          <Pager page={shownPage} pages={pages} total={filtered.length} onPage={setPage} label={`${category} rows`} />
        </div>
      )}
    </div>
  );
}

/** Every recordable row (B1 keeps it), filterable by warning category and text, paged. */
function AllRowsTable({ preview }: { preview: OffPortalPreview }) {
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () =>
      preview.rows.filter(
        (r) => (cat === '' ? true : cat === '__NONE__' ? r.flags.length === 0 : r.flags.includes(cat)) && matchesText(r, q),
      ),
    [preview.rows, cat, q],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PREVIEW_PAGE_SIZE));
  const shownPage = Math.min(page, pages);
  const slice = filtered.slice((shownPage - 1) * PREVIEW_PAGE_SIZE, shownPage * PREVIEW_PAGE_SIZE);
  const rowCats = preview.categories.filter((c) => c.category !== 'INVALID');

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-900">All rows that will be recorded ({preview.rows.length})</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-64">
          <label htmlFor="opp-all-cat" className="mb-1 block text-[11px] font-medium text-gray-700">Warning</label>
          <select id="opp-all-cat" className={inputCls} value={cat} onChange={(e) => { setCat(e.target.value); setPage(1); }}>
            <option value="">All rows</option>
            <option value="__NONE__">No warnings</option>
            {rowCats.map((c) => <option key={c.category} value={c.category}>{categoryShort(c.category)} ({c.count})</option>)}
          </select>
        </div>
        <div className="w-64">
          <label htmlFor="opp-all-q" className="mb-1 block text-[11px] font-medium text-gray-700">Filter</label>
          <input id="opp-all-q" type="search" className={inputCls} placeholder="Outlet ID, name, UTR, PAN or row" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <p className="text-xs text-gray-600">{filtered.length} of {preview.rows.length} rows</p>
      </div>
      {slice.length === 0 ? (
        <p className="text-xs text-gray-600">No rows match this filter.</p>
      ) : (
        <RowsTable rows={slice} testId="opp-preview-table" />
      )}
      <Pager page={shownPage} pages={pages} total={filtered.length} onPage={setPage} label="all rows" />
    </div>
  );
}

function RowsTable({ rows, testId }: { rows: OffPortalPreviewRow[]; testId: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-xs" data-testid={testId}>
        <thead className="bg-gray-50 text-left text-gray-600">
          <tr>
            <th className="px-3 py-2">Row</th><th className="px-3 py-2">Outlet</th><th className="px-3 py-2 text-right">Amount</th>
            <th className="px-3 py-2">Paid on</th><th className="px-3 py-2">Month</th><th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">UTR / reference</th><th className="px-3 py-2">PAN</th><th className="px-3 py-2">TDS treatment</th>
            <th className="px-3 py-2">Warnings</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
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
              <td className="px-3 py-2 min-w-[14rem]" data-testid="opp-row-tds">
                <div>{r.tdsTreatment || r.tdsSection}</div>
                {r.tdsKey && <div className="mt-0.5 text-[11px] text-gray-500">Counts under: <span className="font-mono">{r.tdsKey}</span></div>}
              </td>
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
  );
}

function InvalidTable({ rows, testId }: { rows: InvalidRow[]; testId: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-red-200 bg-white">
      <table className="w-full text-xs" data-testid={testId}>
        <thead className="bg-red-50 text-left text-red-900">
          <tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">Outlet ID</th><th className="px-3 py-2">Outlet name</th><th className="px-3 py-2">Errors</th></tr>
        </thead>
        <tbody className="divide-y divide-red-100">
          {rows.map((r) => (
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
  );
}

function Pager({ page, pages, total, onPage, label }: { page: number; pages: number; total: number; onPage: (p: number) => void; label: string }) {
  if (pages <= 1) return null;
  const first = (page - 1) * PREVIEW_PAGE_SIZE + 1;
  const last = Math.min(total, page * PREVIEW_PAGE_SIZE);
  return (
    <div className="flex items-center justify-between text-xs text-gray-600" aria-label={`Pages of ${label}`}>
      <span>Rows {first}–{last} of {total} · page {page} of {pages}</span>
      <div className="flex gap-2">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} className="rounded border border-gray-300 bg-white px-2 py-1 disabled:opacity-50">Previous</button>
        <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages} className="rounded border border-gray-300 bg-white px-2 py-1 disabled:opacity-50">Next</button>
      </div>
    </div>
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
