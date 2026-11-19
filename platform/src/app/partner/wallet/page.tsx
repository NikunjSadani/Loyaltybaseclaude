'use client';

import React, { useState, useEffect } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { buildStatementDoc, type StatementApiResponse } from '@/lib/wallet-statement/statement-model';
import {
  OutletWalletView,
  mapApiBalance,
  mapStatementRows,
  type ApiWalletBalance,
  type ApiWalletTransaction,
} from '@/components/wallet/outlet-wallet-view';
import type { WalletBalance, WalletTransaction } from '@/types';
import type { PayoutLedgerEntry } from '@/types';
import { usePartnerIdentity } from '@/lib/partner-identity';
import { statementOutlet } from '@/lib/wallet-statement/statement-outlet';
import { authHeader } from '@/lib/api-client';

/* The cards + combined statement (period picker, KPI filter, chips, rows, error states) are the
   SHARED <OutletWalletView> — also rendered by the sales app's view of this outlet's wallet
   (/sales/kyc/[id]/ledger), so a sales rep sees exactly what the partner sees. This page keeps
   only its own data loading and page chrome. */

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function WalletPage() {
  const identity = usePartnerIdentity(); // REAL firm name + presence signals (replaces demo persona/track)

  const [balance,      setBalance]      = useState<WalletBalance | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [payouts,      setPayouts]      = useState<PayoutLedgerEntry[]>([]);
  const [outletCode,   setOutletCode]   = useState('');
  /* True when the statement could not be loaded — shown as an error, never as an empty statement. */
  const [statementError, setStatementError] = useState(false);
  const [loading,      setLoading]      = useState(true);

  useEffect(() => {
    // Live data only — wallet summary + passbook + payouts from the backend (via the
    // Next proxy). No localStorage merge: the ledger is the single source of truth.
    // We fetch ALL three sources unconditionally so the combined statement below always
    // shows the full history (points AND payouts), independent of which cards are shown.
    Promise.all([
      fetch('/api/wallet', { headers: { ...authHeader() } }).then(r => r.json()).catch(() => null),
      // The FULL statement (no pagination) — the on-screen list, date bounds and download all agree.
      fetch('/api/wallet/statement', { headers: { ...authHeader() } }).then(r => r.json()).catch(() => null),
      fetch('/api/partner/payouts', { headers: { ...authHeader() } }).then(r => r.json()).catch(() => null),
    ]).then(([walletJson, txJson, payoutJson]) => {
      // Balance — API returns the flat {success,data} envelope; data is the
      // balance summary itself (earnedPoints, not nested under .balance).
      const hasApiBalance = walletJson?.success && walletJson.data?.earnedPoints !== undefined;
      if (hasApiBalance) {
        setBalance(mapApiBalance(walletJson.data as ApiWalletBalance));
      }

      // Transactions — the statement is OLDEST first (balance-chain order); the screen shows
      // newest first (mapStatementRows reverses, keeping same-timestamp rows in reverse-chain order).
      const apiTxs =
        txJson?.success && Array.isArray(txJson.data?.rows)
          ? mapStatementRows(txJson.data.rows as ApiWalletTransaction[])
          : [];
      if (apiTxs.length > 0) {
        setTransactions(apiTxs);
      }
      if (!(txJson?.success && Array.isArray(txJson.data?.rows))) {
        setStatementError(true);
      }
      if (txJson?.success && typeof txJson.data?.outletCode === 'string') {
        setOutletCode(txJson.data.outletCode);
      }

      // Payouts — INR credit-payout ledger for the combined statement + payout card.
      const apiPayouts =
        payoutJson?.success && Array.isArray(payoutJson.data?.payouts)
          ? (payoutJson.data.payouts as PayoutLedgerEntry[])
          : [];
      if (apiPayouts.length > 0) {
        setPayouts(apiPayouts);
      }
    }).finally(() => setLoading(false));
  }, []);

  /* Download (owner D4): the FULL statement for the selected date range — every transaction type,
     ignoring the on-screen Earn/Burn + KPI filters — with the opening/closing balance, so it ties
     out. Fetched fresh for exactly [from..to] (IST months) at click time. */
  const loadStatementDoc = async ({ from, to }: { from: string; to: string }) => {
    const res = await fetch(`/api/wallet/statement?from=${from}&to=${to}`, { headers: { ...authHeader() } });
    const json = await res.json();
    if (!res.ok || !json?.success || !Array.isArray(json.data?.rows)) throw new Error('statement unavailable');
    const api = json.data as StatementApiResponse & { outletCode?: string; outletName?: string | null };
    // Name AND code from the SAME outlet: the statement response's own pair (never the shell
    // identity's possibly-stale/seeded name next to the response's code). Throws — the button
    // shows its error state — rather than build a mixed-outlet statement.
    const outlet = statementOutlet(api, identity);
    return buildStatementDoc(api, payouts, {
      outletName: outlet.outletName,
      outletCode: outlet.outletCode,
      from,
      to,
    });
  };

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="text-lg font-bold text-gray-900">My Wallet</h1>
        <p className="text-xs text-gray-500 mt-0.5">{identity.businessName}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : (
        <OutletWalletView
          balance={balance}
          transactions={transactions}
          payouts={payouts}
          statementError={statementError}
          showPointsCard={identity.hasPointsActivity}
          showPayoutCard={identity.hasPayoutActivity}
          inclActivationNote={identity.outletType === 'WHOLESALER' && !!identity.features?.wholesalerPayoutInclActivation}
          loyaltyEnabled={identity.loyaltyEnabled}
          outletType={identity.outletType}
          outletCode={outletCode}
          loadStatementDoc={loadStatementDoc}
        />
      )}
    </div>
  );
}
