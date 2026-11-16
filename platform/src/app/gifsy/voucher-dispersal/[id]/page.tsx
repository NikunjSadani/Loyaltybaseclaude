'use client';

/* ─── Voucher Dispersal — campaign detail = live delivery report (/gifsy/voucher-dispersal/[id]) ──
   Summary tiles + every row with its voucher status, Hubble ref, masked code and WhatsApp status.
   Auto-refreshes while the campaign is CONFIRMED / PROCESSING (3s, backing off ×1.5 to 30s) and stops
   once it is done. Per-row Resend (BOUGHT only — no new voucher) and Retry purchase (only when allowed;
   the server's refusal is shown word-for-word). Nothing here claims "sent" before the server says so.
──────────────────────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Download, Loader2, RefreshCw } from 'lucide-react';
import {
  CAMPAIGN_STATUS_LABEL, CAMPAIGN_STATUS_TONE, MESSAGE_STATUS_LABEL, MESSAGE_STATUS_TONE, PENDING_RECONCILE_NOTE,
  POLL_START_MS, ROW_STATUSES, ROW_STATUS_LABEL, ROW_STATUS_TONE, canCancelCampaign, canResendRow, canRetryRow,
  formatRupees, formatWhen, isLiveCampaign, isSetupCampaign, nextPollDelay, vdApi, vdReportUrl,
  type RowStatus, type VdListItem, type VdRow, type VdRowsPage,
} from '@/lib/voucher-dispersal';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';
import { ConfirmDialog, ErrorPanel, LoadingBlock, StatusChip, Tile } from '@/components/voucher-dispersal/vd-ui';

type DialogState =
  | { kind: 'resend'; row: VdRow }
  | { kind: 'retry'; row: VdRow }
  | { kind: 'cancel' }
  | null;

function MessageCell({ row }: { row: VdRow }) {
  if (!row.messageStatus) {
    return <span className="text-xs text-white/50">{row.status === 'BOUGHT' ? 'Not sent yet' : '—'}</span>;
  }
  const times: string[] = [];
  if (row.messageSentAt) times.push(`Sent ${formatWhen(row.messageSentAt)}`);
  if (row.messageDeliveredAt) times.push(`Delivered ${formatWhen(row.messageDeliveredAt)}`);
  if (row.messageReadAt) times.push(`Read ${formatWhen(row.messageReadAt)}`);
  if (row.messageFailedAt) times.push(`Failed ${formatWhen(row.messageFailedAt)}`);
  return (
    <div className="space-y-1">
      <StatusChip label={MESSAGE_STATUS_LABEL[row.messageStatus]} tone={MESSAGE_STATUS_TONE[row.messageStatus]} testId={`vd-msg-${row.id}`} />
      {times.length > 0 && <p className="text-[11px] text-white/50">{times.join(' · ')}</p>}
      {row.messageStatus === 'failed' && (
        <p className="text-xs text-red-200 break-words">{row.messageError ?? 'WhatsApp gave no reason.'}</p>
      )}
    </div>
  );
}

function VoucherCell({ row }: { row: VdRow }) {
  const reason = row.reason ?? (row.status === 'PENDING_RECONCILE' ? PENDING_RECONCILE_NOTE : row.status === 'BUY_FAILED' ? 'Hubble gave no reason.' : null);
  const reasonTone = row.status === 'BUY_FAILED' || row.status === 'INVALID' ? 'text-red-200' : 'text-amber-200';
  return (
    <div className="space-y-1">
      <StatusChip label={ROW_STATUS_LABEL[row.status]} tone={ROW_STATUS_TONE[row.status]} testId={`vd-row-status-${row.id}`} />
      {reason && <p className={`text-xs break-words ${reasonTone}`}>{reason}</p>}
    </div>
  );
}

export default function VoucherCampaignDetailPage() {
  const params = useParams();
  const id = String(Array.isArray(params.id) ? params.id[0] : params.id ?? '');

  const [item, setItem] = useState<VdListItem | null>(null);
  const [rows, setRows] = useState<VdRowsPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'' | RowStatus>('');
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const delayRef = useRef(POLL_START_MS);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = useCallback(async (mode: 'initial' | 'manual' | 'poll') => {
    if (mode === 'initial') { setLoading(true); setLoadError(null); }
    if (mode === 'manual') setRefreshing(true);
    const [c, r] = await Promise.all([vdApi.getCampaign(id), vdApi.rows(id, { status: filter || undefined, page })]);
    if (!mounted.current) return;
    if (c.ok) {
      setItem(c.data);
      setPollError(null);
    } else if (mode === 'poll') {
      setPollError(c.error);
    } else {
      setLoadError(c.error);
    }
    if (r.ok) { setRows(r.data); setRowsError(null); } else setRowsError(r.error);
    setLoading(false);
    setRefreshing(false);
    setTick((t) => t + 1);
  }, [id, filter, page]);

  useEffect(() => { void refresh('initial'); }, [refresh]);

  // Auto-refresh while live, backing off; a failed poll keeps polling (with the error shown) — never silently stops.
  const live = !!item && isLiveCampaign(item.campaign.status);
  useEffect(() => {
    if (!live) { delayRef.current = POLL_START_MS; return; }
    const t = setTimeout(() => {
      delayRef.current = nextPollDelay(delayRef.current);
      void refresh('poll');
    }, delayRef.current);
    return () => clearTimeout(t);
  }, [live, tick, refresh]);

  // ── dialogs ──
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  const openDialog = (d: DialogState) => { setDialog(d); setDialogError(null); };
  const closeDialog = () => { if (!dialogBusy) { setDialog(null); setDialogError(null); } };

  const runDialog = async () => {
    if (!dialog || actionInFlight.current) return;
    actionInFlight.current = true;
    setDialogBusy(true);
    setDialogError(null);
    const res =
      dialog.kind === 'resend' ? await vdApi.resend(id, dialog.row.id)
      : dialog.kind === 'retry' ? await vdApi.retryBuy(id, dialog.row.id)
      : await vdApi.cancel(id);
    actionInFlight.current = false;
    setDialogBusy(false);
    if (!res.ok) { setDialogError(res.error); return; }
    setNotice(
      dialog.kind === 'resend'
        ? `Resend requested for row ${dialog.row.rowNumber}. The WhatsApp status below updates when WhatsApp reports back.`
        : dialog.kind === 'retry'
          ? `Purchase retry requested for row ${dialog.row.rowNumber}. The voucher status below updates as the server works on it.`
          : 'Cancel requested. The campaign status below shows what the server did.',
    );
    setDialog(null);
    delayRef.current = POLL_START_MS;
    void refresh('manual');
  };

  const report = useDownloadAction();

  if (loading && !item) return <LoadingBlock label="Loading campaign…" />;
  if (loadError && !item) return <ErrorPanel message={`Couldn't load this campaign: ${loadError}`} onRetry={() => void refresh('initial')} />;
  if (!item) return null;

  const { campaign: c, summary: s } = item;
  const pageCount = rows ? Math.max(1, Math.ceil(rows.total / Math.max(1, rows.pageSize))) : 1;

  return (
    <div className="space-y-6" data-testid="vd-detail">
      <div className="space-y-2">
        <Link href="/gifsy/voucher-dispersal" className="inline-flex items-center gap-1 text-xs text-white/50 hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> All campaigns
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-white break-words">{c.name || 'Untitled campaign'}</h1>
            <p className="text-xs text-white/50 mt-0.5 break-words">
              Programme: {c.programLabel || '—'} · Billed to: {c.billedToClientName ?? '—'} · Created {formatWhen(c.createdAt)}
              {c.confirmedAt ? ` · Confirmed ${formatWhen(c.confirmedAt)}` : ''}
            </p>
            {c.note && <p className="text-xs text-white/60 mt-1 break-words">Note: {c.note}</p>}
          </div>
          <StatusChip label={CAMPAIGN_STATUS_LABEL[c.status]} tone={CAMPAIGN_STATUS_TONE[c.status]} testId="vd-campaign-status" />
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <div className="flex flex-col gap-1">
          <button type="button" disabled={report.blocked} aria-busy={report.busy}
            onClick={() => void report.run(vdReportUrl(id), { fallbackFileName: `voucher-campaign-${id}.xlsx` })}
            className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60">
            {report.busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Download className="w-4 h-4" aria-hidden="true" />}
            {downloadButtonLabel(report, 'Download report (Excel)')}
          </button>
          <DownloadActionStatus action={report} tone="dark" downloadsHref="/gifsy/downloads" />
        </div>
        <button type="button" onClick={() => void refresh('manual')} disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-60">
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        {canCancelCampaign(c) && (
          <button type="button" onClick={() => openDialog({ kind: 'cancel' })} data-testid="vd-cancel"
            className="rounded-lg border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10">
            Cancel campaign
          </button>
        )}
        {isSetupCampaign(c.status) && (
          <Link href={`/gifsy/voucher-dispersal/new?campaign=${encodeURIComponent(c.id)}`}
            className="rounded-lg bg-[var(--brand-primary)] px-3 py-2 text-sm font-semibold text-white">
            Continue setup
          </Link>
        )}
      </div>

      <p className="text-xs text-white/60" role="status" data-testid="vd-live">
        {live
          ? 'Live — this page refreshes automatically while vouchers are being bought and sent.'
          : isSetupCampaign(c.status)
            ? 'Not confirmed — nothing has been bought or sent.'
            : 'Not refreshing automatically. Use Refresh to see late WhatsApp delivery / read updates.'}
      </p>
      {pollError && (
        <p role="alert" data-testid="vd-poll-error" className="text-xs text-amber-200">
          The last automatic refresh failed ({pollError}). Still retrying — the numbers below may be out of date.
        </p>
      )}
      {notice && (
        <p role="status" data-testid="vd-notice" className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
          {notice}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3" data-testid="vd-tiles">
        <Tile label="Bought" value={s.bought} tone="success" testId="vd-tile-bought" />
        <Tile label="Pending" value={s.pending} tone={s.pending > 0 ? 'warning' : 'neutral'} testId="vd-tile-pending" />
        <Tile label="Buy failed" value={s.buyFailed} tone={s.buyFailed > 0 ? 'danger' : 'neutral'} testId="vd-tile-buyfailed" />
        <Tile label="WhatsApp sent" value={s.messageSent} testId="vd-tile-sent" />
        <Tile label="Delivered" value={s.delivered} testId="vd-tile-delivered" />
        <Tile label="Read" value={s.read} testId="vd-tile-read" />
        <Tile label="Msg failed" value={s.messageFailed} tone={s.messageFailed > 0 ? 'danger' : 'neutral'} testId="vd-tile-msgfailed" />
        <Tile label="Spent / budget" value={`${formatRupees(s.spentRupees)} / ${formatRupees(c.budgetRupees)}`} testId="vd-tile-spent" />
      </div>

      <section aria-labelledby="vd-rows-heading" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="vd-rows-heading" className="text-base font-semibold text-white">Rows</h2>
          <div>
            <label htmlFor="vd-row-filter" className="block text-xs font-semibold text-white/70 mb-1">Voucher status</label>
            <select id="vd-row-filter" value={filter}
              onChange={(e) => { setFilter(e.target.value as '' | RowStatus); setPage(1); }}
              className="rounded-lg border border-white/15 bg-gray-900 px-3 py-2 text-sm text-white">
              <option value="">All rows</option>
              {ROW_STATUSES.map((st) => <option key={st} value={st}>{ROW_STATUS_LABEL[st]}</option>)}
            </select>
          </div>
        </div>
        {rowsError && <ErrorPanel message={`Couldn't load the rows: ${rowsError}`} onRetry={() => void refresh('manual')} testId="vd-rows-error" />}
        {!rows && !rowsError ? (
          <LoadingBlock label="Loading rows…" testId="vd-rows-loading" />
        ) : rows ? (
          <>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="min-w-full text-sm" data-testid="vd-rows-table">
                <caption className="sr-only">Voucher and WhatsApp status for each row</caption>
                <thead className="bg-white/5 text-left text-[11px] uppercase tracking-wide text-white/50">
                  <tr>
                    <th scope="col" className="px-3 py-2">Row</th>
                    <th scope="col" className="px-3 py-2">Person</th>
                    <th scope="col" className="px-3 py-2">Amount / brand</th>
                    <th scope="col" className="px-3 py-2">Voucher</th>
                    <th scope="col" className="px-3 py-2">Hubble ref</th>
                    <th scope="col" className="px-3 py-2">Code</th>
                    <th scope="col" className="px-3 py-2">WhatsApp</th>
                    <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 align-top">
                  {rows.rows.length === 0 ? (
                    <tr><td colSpan={8} className="px-3 py-6 text-center text-white/50">No rows{filter ? ' with this status' : ''}.</td></tr>
                  ) : rows.rows.map((r) => (
                    <tr key={r.id || r.rowNumber} data-testid={`vd-row-${r.id}`}>
                      <td className="px-3 py-2 text-white/60">{r.rowNumber}</td>
                      <td className="px-3 py-2"><p className="text-white">{r.name || '—'}</p><p className="font-mono text-xs text-white/60">{r.phone || '—'}</p></td>
                      <td className="px-3 py-2 text-white whitespace-nowrap">{formatRupees(r.amount)}<p className="text-xs text-white/60">{r.brand || '—'}</p></td>
                      <td className="px-3 py-2 min-w-[12rem]"><VoucherCell row={r} /></td>
                      <td className="px-3 py-2 font-mono text-xs text-white/70">{r.hubbleRef ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs text-white/70">{r.voucherCode ?? '—'}</td>
                      <td className="px-3 py-2 min-w-[11rem]"><MessageCell row={r} /></td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-1.5">
                          {canResendRow(r) && (
                            <button type="button" onClick={() => openDialog({ kind: 'resend', row: r })} data-testid={`vd-resend-${r.id}`}
                              className="whitespace-nowrap rounded border border-white/20 px-2 py-1 text-xs text-white hover:bg-white/10">
                              Resend WhatsApp
                            </button>
                          )}
                          {canRetryRow(r) && (
                            <button type="button" onClick={() => openDialog({ kind: 'retry', row: r })} data-testid={`vd-retry-${r.id}`}
                              className="whitespace-nowrap rounded border border-amber-500/40 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/10">
                              Retry purchase
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pageCount > 1 && (
              <nav aria-label="Row pages" className="flex items-center gap-3 text-xs text-white/70">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Previous</button>
                <span>Page {page} of {pageCount} · {rows.total} rows</span>
                <button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Next</button>
              </nav>
            )}
          </>
        ) : null}
      </section>

      <ConfirmDialog
        open={dialog?.kind === 'resend'}
        title="Resend WhatsApp message?"
        description="Sends the same voucher again. No new voucher is bought."
        confirmLabel="Resend message"
        busyLabel="Resending…"
        busy={dialogBusy}
        error={dialogError}
        onConfirm={() => void runDialog()}
        onClose={closeDialog}
      >
        {dialog?.kind === 'resend' && (
          <p>
            Re-send the same voucher ({formatRupees(dialog.row.amount)} {dialog.row.brand}) to {dialog.row.phone} on WhatsApp.{' '}
            <strong>No new voucher is bought.</strong>
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === 'retry'}
        title="Retry the purchase?"
        description="If the retry succeeds, money is spent on a new voucher."
        confirmLabel="Retry purchase"
        busyLabel="Retrying…"
        busy={dialogBusy}
        error={dialogError}
        danger
        onConfirm={() => void runDialog()}
        onClose={closeDialog}
      >
        {dialog?.kind === 'retry' && (
          <p>
            Try again to buy a {formatRupees(dialog.row.amount)} {dialog.row.brand} voucher for {dialog.row.phone} (row {dialog.row.rowNumber}).
            If it succeeds, the money is spent and the voucher is sent on WhatsApp. If the server refuses, its reason is shown here.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === 'cancel'}
        title="Cancel this campaign?"
        description="Vouchers already bought cannot be cancelled."
        confirmLabel="Cancel campaign"
        busyLabel="Cancelling…"
        busy={dialogBusy}
        error={dialogError}
        danger
        onConfirm={() => void runDialog()}
        onClose={closeDialog}
      >
        <p>
          {isSetupCampaign(c.status)
            ? 'Nothing has been bought for this campaign, so nothing is spent.'
            : 'Rows not bought yet will not be bought. Vouchers already bought stay bought and cannot be cancelled.'}
        </p>
      </ConfirmDialog>
    </div>
  );
}
