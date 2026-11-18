'use client';

/* ─── Voucher Dispersal — campaign list (/gifsy/voucher-dispersal) ──────────────────
   Platform-level Gifsy-owner tool. Every number on this page comes from
   GET /api/admin/voucher-dispersal/campaigns — nothing is computed or invented here
   (a number the server did not send shows as "—"). The list carries purchase counts only — WhatsApp
   delivered / read counts are on each campaign's page. 50 campaigns per page (server `?page=`).
   Each card is ONE real link (the title, stretched over the card with an ::after overlay — keyboard
   focusable, announced by its name); the per-card "Download Excel" button / "Continue setup" link sit
   above the overlay (relative z-10) and are NOT nested inside the link.
──────────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, Loader2, Plus, Ticket, RefreshCw } from 'lucide-react';
import {
  CAMPAIGN_STATUS_TONE, billedToText, campaignStatusText, formatCount, formatRupees, formatWhen,
  isSetupCampaign, vdApi, vdReportFallbackName, vdReportUrl, VD_CAMPAIGNS_PAGE_SIZE, type VdListItem,
} from '@/lib/voucher-dispersal';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';
import { ErrorPanel, LoadingBlock, StatusChip, TemplateDownloadButton } from '@/components/voucher-dispersal/vd-ui';

/** Per-card report download (same report.xlsx as the campaign page), above the card's stretched link. */
function CardDownload({ id, name }: { id: string; name: string }) {
  const action = useDownloadAction();
  return (
    <div className="relative z-10 flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid={`vd-card-download-${id}`}
        aria-label={`Download Excel report for ${name || 'this campaign'}`}
        disabled={action.blocked}
        aria-busy={action.busy}
        onClick={() => void action.run(vdReportUrl(id), { fallbackFileName: vdReportFallbackName(id) })}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {action.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Download className="w-3.5 h-3.5" aria-hidden="true" />}
        {downloadButtonLabel(action, 'Download Excel')}
      </button>
      <DownloadActionStatus action={action} tone="dark" downloadsHref="/gifsy/downloads" />
    </div>
  );
}

function Count({ label, value, alert, wide }: { label: string; value: string; alert?: 'danger' | 'warning'; wide?: boolean }) {
  const color = alert === 'danger' ? 'text-red-300' : alert === 'warning' ? 'text-amber-300' : 'text-white';
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <dt className="text-[10px] uppercase tracking-wide text-white/40">{label}</dt>
      {/* The value sits above the card's link overlay so it can be selected / copied. */}
      <dd className={`relative z-10 w-fit select-text cursor-text text-sm font-semibold break-words ${color}`}>{value}</dd>
    </div>
  );
}

const gt0 = (v: number | null) => v !== null && v > 0;

export default function VoucherDispersalListPage() {
  const [items, setItems] = useState<VdListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const seq = React.useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    const res = await vdApi.listCampaigns(page);
    if (mine !== seq.current) return; // a newer page / refresh superseded this reply
    if (res.ok) setItems(res.data);
    else setError(res.error);
    setLoading(false);
  }, [page]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6" data-testid="vd-list">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Ticket className="w-5 h-5" aria-hidden="true" /> Voucher Dispersal
          </h1>
          <p className="text-sm text-white/50 mt-0.5 max-w-2xl">
            Upload a list of people, check the preview, then confirm to buy one Hubble voucher per valid row and
            send it on WhatsApp. Nothing is bought until you confirm.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <TemplateDownloadButton />
          <Link
            href="/gifsy/voucher-dispersal/new"
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand-primary)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <Plus className="w-4 h-4" aria-hidden="true" /> New campaign
          </Link>
        </div>
      </div>

      {loading && !items ? (
        <LoadingBlock label="Loading campaigns…" />
      ) : !items ? (
        <ErrorPanel message={`Couldn't load campaigns: ${error ?? 'no reply from the server.'}`} onRetry={() => void load()} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {error && (
              <p role="alert" data-testid="vd-refresh-error" className="text-xs text-amber-200">
                Refresh failed ({error}). Showing the last list loaded.
              </p>
            )}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 text-xs text-white/60 hover:text-white disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {items.length === 0 && page > 1 ? (
            <p data-testid="vd-empty-page" className="text-sm text-white/60">No more campaigns on this page.</p>
          ) : items.length === 0 ? (
            <div data-testid="vd-empty" className="rounded-xl border border-white/10 bg-white/5 px-6 py-12 text-center">
              <p className="text-sm font-semibold text-white/80">No campaigns yet</p>
              <p className="text-xs text-white/50 mt-1">Download the template, fill it in, then start a new campaign.</p>
            </div>
          ) : (
            <ul className="space-y-3" aria-label="Campaigns">
              {items.map(({ campaign: c, summary: s }) => {
                const setup = isSetupCampaign(c.status);
                const href = setup
                  ? `/gifsy/voucher-dispersal/new?campaign=${encodeURIComponent(c.id)}`
                  : `/gifsy/voucher-dispersal/${encodeURIComponent(c.id)}`;
                return (
                  <li key={c.id} data-testid={`vd-campaign-${c.id}`}
                    className="relative rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:border-white/25 hover:bg-white/[0.08]">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link href={href} data-testid={`vd-card-link-${c.id}`}
                          className="text-base font-semibold text-white hover:underline break-words outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-sky-400">
                          {c.name || 'Untitled campaign'}
                        </Link>
                        {/* Above the link overlay so it can be selected / copied (plain text — nothing interactive). */}
                        <p data-testid={`vd-card-meta-${c.id}`} className="relative z-10 w-fit select-text cursor-text text-xs text-white/50 mt-0.5 break-words">
                          Programme: {c.programLabel || '—'} · Billed to: {billedToText(c)} · Created {formatWhen(c.createdAt)}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-start gap-2">
                        <StatusChip label={campaignStatusText(c)} tone={CAMPAIGN_STATUS_TONE[c.status]} testId={`vd-status-${c.id}`} />
                        {!setup && <CardDownload id={c.id} name={c.name} />}
                      </div>
                    </div>
                    {s.pendingBatchNumber !== null && (
                      <p data-testid={`vd-card-pending-batch-${c.id}`} className="mt-2 text-xs text-sky-200">
                        Batch {s.pendingBatchNumber} is waiting for confirmation — nothing in it has been bought.
                      </p>
                    )}
                    {setup ? (
                      <p className="mt-3 text-xs text-white/60">
                        Not confirmed — nothing has been bought.{' '}
                        {/* Mouse shortcut only: the card's own title link is THE link for keyboard / screen readers. */}
                        <Link href={href} tabIndex={-1} aria-hidden="true" data-testid={`vd-continue-setup-${c.id}`}
                          className="relative z-10 font-semibold text-sky-300 underline underline-offset-2">Continue setup</Link>
                      </p>
                    ) : (
                      <dl className="mt-3 grid grid-cols-3 sm:grid-cols-8 gap-3">
                        <Count label="Valid rows" value={formatCount(s.valid)} />
                        <Count label="Bought" value={formatCount(s.bought)} />
                        <Count label="Pending" value={formatCount(s.pending)} alert={gt0(s.pending) ? 'warning' : undefined} />
                        <Count label="Buy failed" value={formatCount(s.buyFailed)} alert={gt0(s.buyFailed) ? 'danger' : undefined} />
                        <Count label="Cancelled" value={formatCount(s.cancelled)} />
                        <Count label="Spent / budget" value={`${formatRupees(s.spentRupees)} / ${formatRupees(c.budgetRupees)}`} wide />
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {(page > 1 || items.length >= VD_CAMPAIGNS_PAGE_SIZE) && (
            <nav aria-label="Campaign pages" className="flex items-center gap-3 text-xs text-white/70">
              <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Previous</button>
              <span>Page {page}</span>
              <button type="button" disabled={items.length < VD_CAMPAIGNS_PAGE_SIZE || loading} onClick={() => setPage(page + 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Next</button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
