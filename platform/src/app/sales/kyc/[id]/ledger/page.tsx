'use client';

import React, { useState, useEffect, use } from 'react';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { buildStatementDoc, type StatementApiResponse } from '@/lib/wallet-statement/statement-model';
import {
  OutletWalletView,
  mapApiBalance,
  mapStatementRows,
  type ApiWalletBalance,
  type ApiWalletTransaction,
} from '@/components/wallet/outlet-wallet-view';
import { useGifsySettings } from '@/lib/gifsy-settings';
import type { PayoutLedgerEntry, WalletBalance, WalletTransaction } from '@/types';

/* The sales app's view of an outlet's wallet. Everything below the header — the summary cards
   and the combined statement — is the SHARED <OutletWalletView> the partner's own wallet renders
   (/partner/wallet), fed by GET /api/kyc/[id]/ledger whose `meta` carries the SAME card signals
   as /partner/me (shared backend resolveOutletWalletActivity). So a rep always sees exactly what
   the outlet sees: a payout-only retailer gets the ₹ card and no "0 pts" card, a wholesaler with
   points + payouts gets both, an outlet with no activity gets no cards. This page keeps only its
   own data loading and chrome (back link + outlet title). */

/** GET /api/kyc/[id]/ledger → data.meta */
interface LedgerMeta {
  name: string;
  outletCode: string;
  mobile: string;
  outletType?: string | null;
  hasPointsActivity?: boolean;
  hasPayoutActivity?: boolean;
  loyaltyEnabled?: boolean;
  wholesalerPayoutInclActivation?: boolean;
  /** The SAME balance fields GET /api/wallet returns. */
  walletBalance?: ApiWalletBalance;
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function OutletLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const settings = useGifsySettings();
  // The tenant's own name for this screen (salesApp.ledgerLabel — the same label the outlet
  // page's quick-action tile uses), falling back to the historical subtitle.
  const ledgerLabel = settings.salesApp?.ledgerLabel || 'Points Ledger';

  const [outlet,         setOutlet]         = useState<LedgerMeta | null>(null);
  const [balance,        setBalance]        = useState<WalletBalance | null>(null);
  const [transactions,   setTransactions]   = useState<WalletTransaction[]>([]);
  const [payouts,        setPayouts]        = useState<PayoutLedgerEntry[]>([]);
  const [statementError, setStatementError] = useState(false);
  const [loading,        setLoading]        = useState(true);
  const [fetchError,     setFetchError]     = useState('');

  useEffect(() => {
    // `loading` starts true; the route remounts per outlet id, so no synchronous reset here.
    fetch(`/api/kyc/${id}/ledger`)
      .then((r) => r.json())
      .then((body) => {
        if (!body?.success) { setFetchError(body?.error ?? 'Failed to load'); return; }
        const { meta, statement, payouts: apiPayouts } = body.data ?? {};
        if (!meta) { setFetchError('Failed to load'); return; }
        setOutlet(meta as LedgerMeta);
        setBalance(meta.walletBalance ? mapApiBalance(meta.walletBalance as ApiWalletBalance) : null);
        // Points statement — the SAME row shape (and mapping) as the partner's /api/wallet/statement.
        // A missing/malformed statement is an ERROR on screen, never an empty "No transactions".
        if (Array.isArray(statement?.rows)) {
          setTransactions(mapStatementRows(statement.rows as ApiWalletTransaction[]));
        } else {
          setStatementError(true);
        }
        setPayouts(Array.isArray(apiPayouts) ? (apiPayouts as PayoutLedgerEntry[]) : []);
      })
      .catch(() => setFetchError('Network error'))
      .finally(() => setLoading(false));
  }, [id]);

  /* Download (owner D4): the FULL statement for the selected range (all types, filters ignored)
     from the SAME shared builder + renderers the partner wallet uses, so the files can't drift. */
  const loadStatementDoc = async ({ from, to }: { from: string; to: string }) => {
    const res = await fetch(`/api/kyc/${id}/ledger/statement?from=${from}&to=${to}`);
    const json = await res.json();
    if (!res.ok || !json?.success || !Array.isArray(json.data?.rows)) throw new Error('statement unavailable');
    return buildStatementDoc(json.data as StatementApiResponse, payouts, {
      outletName: outlet?.name ?? '',
      outletCode: outlet?.outletCode ?? '',
      from,
      to,
    });
  };

  if (!loading && (fetchError || !outlet)) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <AlertTriangle className="h-10 w-10 text-amber-400" />
        <p className="text-sm text-gray-500">{fetchError || 'Outlet not found'}</p>
        <Link href="/sales/kyc" className="text-sm text-[var(--brand-primary)] font-medium">← Back</Link>
      </div>
    );
  }

  // Until the fetch resolves, `outlet` is null. The title below dereferences `o.name`, so render
  // a spinner until the outlet is loaded (also the SSR path, where the effect never runs — a bare
  // `outlet!` here once 500-ed the whole route).
  if (!outlet) {
    return <div className="flex items-center justify-center py-20"><Spinner size="lg" /></div>;
  }
  const o = outlet;

  return (
    <div className="space-y-5 fade-in">

      {/* Back + title */}
      <div className="flex items-center gap-2">
        <Link href={`/sales/kyc/${id}`} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div>
          <h1 className="text-base font-bold text-gray-900">{o.name}</h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p data-testid="ledger-label" className="text-xs text-gray-500">{ledgerLabel}</p>
            <span className="text-[10px] font-mono font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
              {o.outletCode}
            </span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : (
        <OutletWalletView
          balance={balance}
          transactions={transactions}
          payouts={payouts}
          statementError={statementError}
          showPointsCard={o.hasPointsActivity === true}
          showPayoutCard={o.hasPayoutActivity === true}
          inclActivationNote={o.outletType === 'WHOLESALER' && o.wholesalerPayoutInclActivation === true}
          loyaltyEnabled={o.loyaltyEnabled !== false}
          outletType={o.outletType ?? null}
          outletCode={o.outletCode}
          loadStatementDoc={loadStatementDoc}
          statementErrorMessage="Couldn't load this outlet's statement. Please try again."
        />
      )}
    </div>
  );
}
