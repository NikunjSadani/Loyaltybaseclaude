'use client';

/* ─── Voucher Dispersal — campaign detail = live delivery report (/gifsy/voucher-dispersal/[id]) ──
   Summary tiles + every row with its voucher status, Hubble ref, masked code and WhatsApp status.
   Auto-refreshes while the campaign is CONFIRMED / PROCESSING, while its status is unrecognised, and
   for 30 minutes after it completes (late WhatsApp delivered / read updates) — 3s, backing off ×1.5
   to 30s — then stops; paused while the tab is hidden. Only the LATEST request's reply is applied
   (filter / page / poll / manual refreshes can overlap). Per-row Resend (server `canResend`) and Retry
   purchase (server `canRetryBuy`): a refusal is shown word-for-word; a network error / 5xx means the
   outcome is UNKNOWN → the dialog closes, the page refreshes and says so, and the action stays locked
   until that refresh lands. Nothing here claims "sent" before the server says so.
   While the campaign is live (or in the 30-min settling window) each refresh also nudges the server
   with POST /process (a bounded processing pass — Cloud Run only gives CPU during a request; the drain
   scheduler is the backup). Single-flight (never two at once), paced by the same backoff, paused while
   hidden; 4xx are ignored quietly, repeated 5xx / network failures show a non-blocking note.
──────────────────────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Download, Loader2, RefreshCw, X } from 'lucide-react';
import {
  CAMPAIGN_STATUS_TONE, MESSAGE_STATUS_LABEL, MESSAGE_STATUS_TONE, PENDING_RECONCILE_NOTE, POLL_START_MS,
  PROCESS_FAILURES_BEFORE_NOTE, ROW_STATUSES, ROW_STATUS_LABEL, ROW_STATUS_TONE, billedToText, campaignStatusText,
  canCancelCampaign, canResendRow, canRetryRow, formatCount, formatRupees, formatWhen, isLiveCampaign, isProcessInFlight,
  isSetupCampaign, isUncertainFailure, nextPollDelay, nextProcessFailures, plural, pollPhase, rowStatusText,
  shouldNudgeProcessing, vdApi, vdReportUrl,
  type CampaignStatus, type RowStatus, type VdListItem, type VdRow, type VdRowsPage,
} from '@/lib/voucher-dispersal';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';
import { ConfirmDialog, ErrorPanel, LoadingBlock, StatusChip, Tile } from '@/components/voucher-dispersal/vd-ui';

type DialogState =
  | { kind: 'resend'; row: VdRow }
  | { kind: 'retry'; row: VdRow }
  | { kind: 'cancel' }
  | null;

type Notice = { text: string; tone: 'info' | 'warning' } | null;

const gt0 = (v: number | null) => v !== null && v > 0;

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
  const reason = row.reason
    ?? (row.status === 'PENDING_RECONCILE' ? PENDING_RECONCILE_NOTE
      : row.status === 'BUY_FAILED' ? 'Hubble gave no reason.'
        : row.status === 'UNKNOWN' ? 'This status is not recognised by this screen — check the report or ask engineering.'
          : null);
  const reasonTone = row.status === 'BUY_FAILED' || row.status === 'INVALID' ? 'text-red-200' : 'text-amber-200';
  const retryAt = row.status === 'PENDING_RECONCILE' && row.retryAvailableAt && !row.canRetryBuy ? formatWhen(row.retryAvailableAt) : null;
  return (
    <div className="space-y-1">
      <StatusChip label={rowStatusText(row)} tone={ROW_STATUS_TONE[row.status]} testId={`vd-row-status-${row.id}`} />
      {reason && <p className={`text-xs break-words ${reasonTone}`}>{reason}</p>}
      {retryAt && retryAt !== '—' && <p className="text-[11px] text-white/50">Retry available from {retryAt}.</p>}
      {row.warning && (
        <p className="text-xs break-words text-amber-200" data-testid={`vd-row-warning-${row.id}`}>
          <span className="font-semibold">Note:</span> {row.warning}
        </p>
      )}
    </div>
  );
}

function liveText(phase: string, c: { status: CampaignStatus; rawStatus: string }, hidden: boolean): string {
  const paused = hidden ? ' (paused while this tab is hidden)' : '';
  if (phase === 'live') return `Live — this page refreshes automatically while vouchers are being bought and sent${paused}.`;
  if (phase === 'unknown') return `The server reported a status this screen does not recognise (${c.rawStatus || 'none'}). Still refreshing automatically${paused}.`;
  if (phase === 'settling') return `Finished — still refreshing automatically for 30 minutes after completion to pick up late WhatsApp delivered / read updates${paused}.`;
  if (isSetupCampaign(c.status)) return 'Not confirmed — nothing has been bought or sent.';
  return 'Not refreshing automatically. Use Refresh to see the latest WhatsApp delivery / read updates.';
}

export default function VoucherCampaignDetailPage() {
  const params = useParams();
  const id = String(Array.isArray(params.id) ? params.id[0] : params.id ?? '');

  const [item, setItem] = useState<VdListItem | null>(null);
  const itemRef = useRef<VdListItem | null>(null);
  const [rows, setRows] = useState<VdRowsPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'' | RowStatus>('');
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [hidden, setHidden] = useState(false);
  const [processNote, setProcessNote] = useState<string | null>(null);
  const processFailures = useRef(0);
  const delayRef = useRef(POLL_START_MS);
  const seqRef = useRef(0);
  // When THIS page saw the campaign go from live to completed — the 30-min window's start when the
  // server sends no completedAt. Set before setItem so the same render sees it.
  const sawLive = useRef(false);
  const observedCompletedAt = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Pause polling while the tab is hidden.
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === 'hidden');
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  /** Fetch campaign + current rows page. Only the latest call's reply is applied. */
  const refresh = useCallback(async (mode: 'load' | 'manual' | 'poll') => {
    const seq = ++seqRef.current;
    if (mode === 'load' && !itemRef.current) { setLoading(true); setLoadError(null); }
    if (mode === 'manual') setRefreshing(true);
    // A 'poll' refresh is automatic → background requests (the Usage Report does not count them as activity).
    const background = mode === 'poll';
    const [c, r] = await Promise.all([
      background ? vdApi.getCampaign(id, { background }) : vdApi.getCampaign(id),
      vdApi.rows(id, background ? { status: filter || undefined, page, background } : { status: filter || undefined, page }),
    ]);
    if (!mounted.current || seq !== seqRef.current) return; // a newer request superseded this one
    if (c.ok) {
      const st = c.data.campaign.status;
      if (isLiveCampaign(st)) sawLive.current = true;
      else if ((st === 'COMPLETED' || st === 'COMPLETED_WITH_ERRORS') && sawLive.current && observedCompletedAt.current === null) {
        observedCompletedAt.current = Date.now();
      }
      itemRef.current = c.data;
      setItem(c.data);
      setPollError(null);
      setRefreshError(null);
      setLoadError(null);
    } else if (!itemRef.current) {
      setLoadError(c.error);
    } else if (mode === 'poll') {
      setPollError(c.error);
    } else {
      setRefreshError(c.error);
    }
    if (r.ok) { setRows(r.data); setRowsError(null); } else setRowsError(r.error);
    setLoading(false);
    setRefreshing(false);
    setTick((t) => t + 1);
  }, [id, filter, page]);

  // First load + every filter / page change.
  useEffect(() => { void refresh('load'); }, [refresh]);

  const phase = item ? pollPhase(item.campaign, Date.now(), observedCompletedAt.current) : 'off';
  const polling = phase !== 'off';
  useEffect(() => {
    if (!polling || hidden) return;
    const t = setTimeout(() => {
      delayRef.current = nextPollDelay(delayRef.current);
      void refresh('poll');
    }, delayRef.current);
    return () => clearTimeout(t);
  }, [polling, hidden, tick, refresh]);
  useEffect(() => { if (!polling) delayRef.current = POLL_START_MS; }, [polling]);

  // Nudge server-side processing alongside polling: once per completed refresh (so it follows the same
  // backoff), only while live / settling and visible, never while one is still in flight.
  const nudge = shouldNudgeProcessing(phase);
  useEffect(() => {
    if (!nudge || hidden || !id || isProcessInFlight(id)) return;
    void vdApi.process(id, { background: true }).then((res) => { // automatic nudge → background
      if (!mounted.current) return;
      processFailures.current = nextProcessFailures(processFailures.current, res);
      if (res.ok) setProcessNote(null);
      else if (processFailures.current >= PROCESS_FAILURES_BEFORE_NOTE) setProcessNote(res.error);
    });
  }, [nudge, hidden, tick, id]);

  // ── dialogs ──
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  /** Row ids (or 'campaign') whose action outcome is unknown — locked until the follow-up refresh lands. */
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const actionInFlight = useRef(false);
  const openDialog = (d: DialogState) => { setDialog(d); setDialogError(null); setNotice(null); };
  const closeDialog = () => { if (!dialogBusy) { setDialog(null); setDialogError(null); } };

  const runDialog = async () => {
    if (!dialog || actionInFlight.current) return;
    const d = dialog;
    const lockKey = d.kind === 'cancel' ? 'campaign' : d.row.id;
    actionInFlight.current = true;
    setDialogBusy(true);
    setDialogError(null);
    const res =
      d.kind === 'resend' ? await vdApi.resend(id, d.row.id)
      : d.kind === 'retry' ? await vdApi.retryBuy(id, d.row.id)
      : await vdApi.cancel(id);
    actionInFlight.current = false;
    setDialogBusy(false);
    if (!res.ok && !isUncertainFailure(res.status)) {
      setDialogError(res.error); // a definite refusal — word for word, dialog stays open
      return;
    }
    setDialog(null);
    if (res.ok) {
      let text: string;
      if (d.kind === 'resend') {
        text = `Resend requested for row ${formatCount(d.row.rowNumber)}. The WhatsApp status below updates when WhatsApp reports back.`;
      } else if (d.kind === 'retry') {
        const msg = (res.data as { message: string | null }).message;
        text = `Row ${formatCount(d.row.rowNumber)}: ${msg ?? 'purchase retry requested.'} The voucher status below updates as the server works on it.`;
      } else {
        const r = res.data as { cancelledRows: number | null; stillWithHubble: number | null; alreadyBought: number | null };
        const parts: string[] = [];
        if (r.cancelledRows !== null) parts.push(`${plural(r.cancelledRows, 'row')} will not be bought`);
        if (r.stillWithHubble !== null && r.stillWithHubble > 0) parts.push(`${plural(r.stillWithHubble, 'purchase')} already with Hubble may still complete`);
        if (r.alreadyBought !== null && r.alreadyBought > 0) parts.push(`${plural(r.alreadyBought, 'voucher')} already bought stay bought`);
        text = `Campaign cancelled${parts.length ? `: ${parts.join('; ')}` : ''}.`;
      }
      setNotice({ tone: 'info', text });
    } else {
      const what = d.kind === 'resend' ? 'the resend' : d.kind === 'retry' ? 'the purchase retry' : 'the cancel';
      const where = d.kind === 'cancel' ? 'the campaign status' : `row ${formatCount(d.row.rowNumber)}`;
      setNotice({
        tone: 'warning',
        text: `We couldn't tell whether ${what} started (${res.error}). Refreshing — check ${where} below before trying again.`,
      });
    }
    setLocked((s) => new Set(s).add(lockKey));
    delayRef.current = POLL_START_MS;
    await refresh('manual');
    setLocked((s) => { const n = new Set(s); n.delete(lockKey); return n; });
  };

  const report = useDownloadAction();

  if (loading && !item) return <LoadingBlock label="Loading campaign…" />;
  if (!item) return <ErrorPanel message={`Couldn't load this campaign: ${loadError ?? 'no reply from the server.'}`} onRetry={() => void refresh('load')} />;

  const { campaign: c, summary: s } = item;
  const pageCount = rows && rows.total !== null ? Math.max(1, Math.ceil(rows.total / Math.max(1, rows.pageSize))) : null;
  const hasNext = rows ? (pageCount !== null ? page < pageCount : rows.rows.length >= rows.pageSize && rows.rows.length > 0) : false;

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
              Programme: {c.programLabel || '—'} · Billed to: {billedToText(c)} · Created {formatWhen(c.createdAt)}
              {c.confirmedAt ? ` · Confirmed ${formatWhen(c.confirmedAt)}` : ''}
              {c.completedAt ? ` · Completed ${formatWhen(c.completedAt)}` : ''}
            </p>
            {c.note && <p className="text-xs text-white/60 mt-1 break-words">Note: {c.note}</p>}
          </div>
          <StatusChip label={campaignStatusText(c)} tone={CAMPAIGN_STATUS_TONE[c.status]} testId="vd-campaign-status" />
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
          <button type="button" onClick={() => openDialog({ kind: 'cancel' })} data-testid="vd-cancel" disabled={locked.has('campaign')}
            className="rounded-lg border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-50">
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

      <p className="text-xs text-white/60" role="status" data-testid="vd-live">{liveText(phase, c, hidden)}</p>
      {item.hubbleConfigured === false && !isSetupCampaign(c.status) && (
        <p role="alert" data-testid="vd-hubble-off" className="text-xs text-amber-200">
          Hubble is not configured on this server, so nothing can be bought right now. Rows stay queued / pending until it is.
        </p>
      )}
      {processNote && (
        <p role="status" data-testid="vd-process-note" className="text-xs text-amber-200">
          Couldn&apos;t nudge processing from this page ({processNote}). The server&apos;s scheduler keeps working in the background — the numbers below still refresh.
        </p>
      )}
      {pollError && (
        <p role="alert" data-testid="vd-poll-error" className="text-xs text-amber-200">
          The last automatic refresh failed ({pollError}). Still retrying — the numbers below may be out of date.
        </p>
      )}
      {refreshError && (
        <p role="alert" data-testid="vd-refresh-error" className="text-xs text-amber-200">
          Refresh failed ({refreshError}). The numbers below may be out of date — try Refresh again.
        </p>
      )}
      {notice && (
        <div role="status" data-testid="vd-notice"
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${notice.tone === 'warning' ? 'border-amber-500/40 bg-amber-500/10 text-amber-100' : 'border-sky-500/30 bg-sky-500/10 text-sky-200'}`}>
          <p className="flex-1 min-w-0 break-words">{notice.text}</p>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message" className="shrink-0 opacity-70 hover:opacity-100">
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3" data-testid="vd-tiles">
        <Tile label="Bought" value={formatCount(s.bought)} tone="success" testId="vd-tile-bought" />
        <Tile label="Pending" value={formatCount(s.pending)} tone={gt0(s.pending) ? 'warning' : 'neutral'} testId="vd-tile-pending" />
        <Tile label="Buy failed" value={formatCount(s.buyFailed)} tone={gt0(s.buyFailed) ? 'danger' : 'neutral'} testId="vd-tile-buyfailed" />
        <Tile label="WhatsApp sent" value={formatCount(s.messageSent)} testId="vd-tile-sent" />
        <Tile label="Delivered" value={formatCount(s.delivered)} testId="vd-tile-delivered" />
        <Tile label="Read" value={formatCount(s.read)} testId="vd-tile-read" />
        <Tile label="Msg failed" value={formatCount(s.messageFailed)} tone={gt0(s.messageFailed) ? 'danger' : 'neutral'} testId="vd-tile-msgfailed" />
        <Tile label="Spent / budget" value={`${formatRupees(s.spentRupees)} / ${formatRupees(c.budgetRupees)}`} testId="vd-tile-spent" wide />
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
                  ) : rows.rows.map((r, i) => (
                    <tr key={r.id || `i${i}`} data-testid={`vd-row-${r.id}`}>
                      <td className="px-3 py-2 text-white/60">{formatCount(r.rowNumber)}</td>
                      <td className="px-3 py-2"><p className="text-white">{r.name || '—'}</p><p className="font-mono text-xs text-white/60">{r.phone || '—'}</p></td>
                      <td className="px-3 py-2 text-white whitespace-nowrap">{formatRupees(r.amount)}<p className="text-xs text-white/60">{r.brand || '—'}</p></td>
                      <td className="px-3 py-2 min-w-[12rem]"><VoucherCell row={r} /></td>
                      <td className="px-3 py-2 font-mono text-xs text-white/70">{r.hubbleRef ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs text-white/70">{r.voucherCodeMasked ?? '—'}</td>
                      <td className="px-3 py-2 min-w-[11rem]"><MessageCell row={r} /></td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-1.5">
                          {r.id && canResendRow(r, c.status) && (
                            <button type="button" onClick={() => openDialog({ kind: 'resend', row: r })} data-testid={`vd-resend-${r.id}`}
                              disabled={locked.has(r.id)}
                              className="whitespace-nowrap rounded border border-white/20 px-2 py-1 text-xs text-white hover:bg-white/10 disabled:opacity-50">
                              Resend WhatsApp
                            </button>
                          )}
                          {r.id && canRetryRow(r) && (
                            <button type="button" onClick={() => openDialog({ kind: 'retry', row: r })} data-testid={`vd-retry-${r.id}`}
                              disabled={locked.has(r.id)}
                              className="whitespace-nowrap rounded border border-amber-500/40 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/10 disabled:opacity-50">
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
            {(page > 1 || hasNext) && (
              <nav aria-label="Row pages" className="flex items-center gap-3 text-xs text-white/70">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Previous</button>
                <span>Page {page}{pageCount !== null ? ` of ${pageCount}` : ''}{rows.total !== null ? ` · ${formatCount(rows.total)} rows` : ''}</span>
                <button type="button" disabled={!hasNext} onClick={() => setPage(page + 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Next</button>
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
            Try again to buy a {formatRupees(dialog.row.amount)} {dialog.row.brand} voucher for {dialog.row.phone} (row {formatCount(dialog.row.rowNumber)}).
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
            : 'Rows not bought yet will not be bought, but purchases already in progress may still complete. Vouchers already bought stay bought.'}
        </p>
      </ConfirmDialog>
    </div>
  );
}
