'use client';

/* ─── Voucher Dispersal — campaign list (/gifsy/voucher-dispersal) ──────────────────
   Platform-level Gifsy-owner tool. Every number on this page comes from
   GET /api/admin/voucher-dispersal/campaigns — nothing is computed or invented here.
──────────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Ticket, RefreshCw } from 'lucide-react';
import {
  CAMPAIGN_STATUS_LABEL, CAMPAIGN_STATUS_TONE, formatRupees, formatWhen,
  isSetupCampaign, vdApi, type VdListItem,
} from '@/lib/voucher-dispersal';
import { ErrorPanel, LoadingBlock, StatusChip, TemplateDownloadButton } from '@/components/voucher-dispersal/vd-ui';

function Count({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'danger' | 'warning' }) {
  const color = tone === 'danger' ? 'text-red-300' : tone === 'warning' ? 'text-amber-300' : 'text-white';
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-white/40">{label}</dt>
      <dd className={`text-sm font-semibold ${color}`}>{value}</dd>
    </div>
  );
}

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
      ) : error ? (
        <ErrorPanel message={`Couldn't load campaigns: ${error}`} onRetry={() => void load()} />
      ) : !items || items.length === 0 ? (
        <div data-testid="vd-empty" className="rounded-xl border border-white/10 bg-white/5 px-6 py-12 text-center">
          <p className="text-sm font-semibold text-white/80">No campaigns yet</p>
          <p className="text-xs text-white/50 mt-1">Download the template, fill it in, then start a new campaign.</p>
        </div>
      ) : (
        <>
          <div className="flex justify-end">
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
          <ul className="space-y-3" aria-label="Campaigns">
            {items.map(({ campaign: c, summary: s }) => {
              const href = isSetupCampaign(c.status)
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
                        Programme: {c.programLabel || '—'} · Billed to: {c.billedToClientName ?? '—'} · Created {formatWhen(c.createdAt)}
                      </p>
                    </div>
                    <StatusChip label={CAMPAIGN_STATUS_LABEL[c.status]} tone={CAMPAIGN_STATUS_TONE[c.status]} testId={`vd-status-${c.id}`} />
                  </div>
                  {isSetupCampaign(c.status) ? (
                    <p className="mt-3 text-xs text-white/60">
                      Not confirmed — nothing has been bought.{' '}
                      <Link href={href} className="font-semibold text-sky-300 underline underline-offset-2">Continue setup</Link>
                    </p>
                  ) : (
                    <dl className="mt-3 grid grid-cols-3 sm:grid-cols-7 gap-3">
                      <Count label="Bought" value={s.bought} />
                      <Count label="Pending" value={s.pending} tone={s.pending > 0 ? 'warning' : undefined} />
                      <Count label="Buy failed" value={s.buyFailed} tone={s.buyFailed > 0 ? 'danger' : undefined} />
                      <Count label="Delivered" value={s.delivered} />
                      <Count label="Read" value={s.read} />
                      <Count label="Msg failed" value={s.messageFailed} tone={s.messageFailed > 0 ? 'danger' : undefined} />
                      <Count label="Spent" value={`${formatRupees(s.spentRupees)} / ${formatRupees(c.budgetRupees)}`} />
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
