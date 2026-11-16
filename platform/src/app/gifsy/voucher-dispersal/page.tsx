'use client';

/* ─── Voucher Dispersal — campaign list (/gifsy/voucher-dispersal) ──────────────────
   Platform-level Gifsy-owner tool. Every number on this page comes from
   GET /api/admin/voucher-dispersal/campaigns — nothing is computed or invented here
   (a number the server did not send shows as "—").
──────────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Ticket, RefreshCw } from 'lucide-react';
import {
  CAMPAIGN_STATUS_TONE, billedToText, campaignStatusText, formatCount, formatRupees, formatWhen,
  isSetupCampaign, vdApi, type VdListItem,
} from '@/lib/voucher-dispersal';
import { ErrorPanel, LoadingBlock, StatusChip, TemplateDownloadButton } from '@/components/voucher-dispersal/vd-ui';

function Count({ label, value, alert, wide }: { label: string; value: string; alert?: 'danger' | 'warning'; wide?: boolean }) {
  const color = alert === 'danger' ? 'text-red-300' : alert === 'warning' ? 'text-amber-300' : 'text-white';
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <dt className="text-[10px] uppercase tracking-wide text-white/40">{label}</dt>
      <dd className={`text-sm font-semibold break-words ${color}`}>{value}</dd>
    </div>
  );
}

const gt0 = (v: number | null) => v !== null && v > 0;

export default function VoucherDispersalListPage() {
  const [items, setItems] = useState<VdListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await vdApi.listCampaigns();
    if (res.ok) setItems(res.data);
    else setError(res.error);
    setLoading(false);
  }, []);

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
          {items.length === 0 ? (
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
                  <li key={c.id} data-testid={`vd-campaign-${c.id}`} className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link href={href} className="text-base font-semibold text-white hover:underline break-words">
                          {c.name || 'Untitled campaign'}
                        </Link>
                        <p className="text-xs text-white/50 mt-0.5 break-words">
                          Programme: {c.programLabel || '—'} · Billed to: {billedToText(c)} · Created {formatWhen(c.createdAt)}
                        </p>
                      </div>
                      <StatusChip label={campaignStatusText(c)} tone={CAMPAIGN_STATUS_TONE[c.status]} testId={`vd-status-${c.id}`} />
                    </div>
                    {setup ? (
                      <p className="mt-3 text-xs text-white/60">
                        Not confirmed — nothing has been bought.{' '}
                        <Link href={href} className="font-semibold text-sky-300 underline underline-offset-2">Continue setup</Link>
                      </p>
                    ) : (
                      <dl className="mt-3 grid grid-cols-3 sm:grid-cols-8 gap-3">
                        <Count label="Bought" value={formatCount(s.bought)} />
                        <Count label="Pending" value={formatCount(s.pending)} alert={gt0(s.pending) ? 'warning' : undefined} />
                        <Count label="Buy failed" value={formatCount(s.buyFailed)} alert={gt0(s.buyFailed) ? 'danger' : undefined} />
                        <Count label="Delivered" value={formatCount(s.delivered)} />
                        <Count label="Read" value={formatCount(s.read)} />
                        <Count label="Msg failed" value={formatCount(s.messageFailed)} alert={gt0(s.messageFailed) ? 'danger' : undefined} />
                        <Count label="Spent / budget" value={`${formatRupees(s.spentRupees)} / ${formatRupees(c.budgetRupees)}`} wide />
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
