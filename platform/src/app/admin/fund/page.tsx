'use client';

/* ─── Fund reconciliation (/admin/fund) ───────────────────────────────────────────
   The client's prepaid advance vs what is spent from it (vouchers at face − brand discount; cash redemptions,
   target / credit payouts and visibility payouts at face + agency fee; Gifsy-borne 194C gross-up TDS).
   Design: platform/docs/plans/FUND-RECONCILIATION-DESIGN.md. Replaces the retired /admin/payouts/fund.

   Every number comes from GET /api/fund/* (computed by the backend from the source records). This page only
   formats paise. Writes (receipts, adjustments, opening balance, rates, alerts) are Gifsy-only: the controls
   render only when the API says `canManage` AND the viewer is GIFSY_ADMIN; the backend enforces it regardless.
──────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import { formatISTDateTime } from '@/lib/ist-date';
import { fundApi, type FundSummary } from '@/lib/fund';
import { ErrorBlock, LoadingBlock } from './_components/fund-ui';
import { FundOverview, LowBalanceBanner } from './_components/fund-overview';
import { FundStatementTab } from './_components/fund-statement';
import { FundEntriesTab } from './_components/fund-entries';
import { FundRatesTab } from './_components/fund-rates';

type TabKey = 'overview' | 'statement' | 'entries' | 'rates';
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'statement', label: 'Statement' },
  { key: 'entries', label: 'Receipts & adjustments' },
  { key: 'rates', label: 'Rates & alerts' },
];

export default function FundReconciliationPage() {
  const session = useAdminSession();
  const isGifsy = session.role === 'GIFSY_ADMIN';
  const [tab, setTab] = useState<TabKey>('overview');
  const [summary, setSummary] = useState<FundSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fundApi.summary();
    if (r.ok && r.data && typeof r.data === 'object' && r.data.totals) setSummary(r.data);
    else { setSummary(null); setError(r.ok ? 'The fund summary could not be read. Please refresh the page.' : r.message); }
    setLoading(false);
  }, []);

  useEffect(() => { void loadSummary(); }, [loadSummary, refreshKey]);

  /** After any successful write: refresh the summary and whichever tab is open. */
  const refreshAll = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Write controls: the API's canManage AND a Gifsy admin viewer (never for CLIENT_ADMIN).
  const canManage = isGifsy && !!summary?.canManage;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A2E]">Fund reconciliation</h1>
          <p className="mt-1 text-sm text-gray-500">
            The client&apos;s advance with Gifsy, and every voucher and payout charged to it.
            {!canManage && summary && ' Read-only view — Gifsy records receipts and sets the rates.'}
          </p>
          {summary?.asOf && <p className="mt-0.5 text-xs text-gray-400">As of {formatISTDateTime(summary.asOf)}</p>}
        </div>
        <button
          type="button"
          onClick={refreshAll}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden /> Refresh
        </button>
      </div>

      {error && <ErrorBlock message={`Could not load the fund summary: ${error}`} onRetry={() => void loadSummary()} />}
      {summary && <LowBalanceBanner summary={summary} />}

      <div role="tablist" aria-label="Fund reconciliation sections" className="flex gap-0 overflow-x-auto border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`fund-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`fund-panel-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'border-[var(--brand-primary)] text-[var(--brand-primary)]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`fund-panel-${tab}`} aria-labelledby={`fund-tab-${tab}`}>
        {tab === 'overview' && (
          summary ? <FundOverview summary={summary} /> : loading ? <LoadingBlock label="Loading fund summary…" /> : null
        )}
        {tab === 'statement' && <FundStatementTab isGifsy={isGifsy} refreshKey={refreshKey} />}
        {tab === 'entries' && (
          <FundEntriesTab canManage={canManage} hasOpening={!!summary?.hasOpening} refreshKey={refreshKey} onChanged={refreshAll} />
        )}
        {tab === 'rates' && <FundRatesTab canManage={canManage} refreshKey={refreshKey} onChanged={refreshAll} />}
      </div>
    </div>
  );
}
