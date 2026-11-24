'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatISTDate } from '@/lib/ist-date';
import { formatInrPaise } from '@/lib/money-format';
import { bpsToPercentLabel, feeLabelOf, fundApi, type FundRateRow, type FundSettings, alertCheckLabel } from '@/lib/fund';
import { EmptyBlock, ErrorBlock, LoadingBlock, Money } from './fund-ui';

const feeLabel = (f: Parameters<typeof feeLabelOf>[0]) => feeLabelOf(f, formatInrPaise);

/** "Re-priced 12 lines (balance −₹340.00)" for a back-dated rate row; null otherwise. */
export function RepricedNote({ r }: { r: Pick<FundRateRow, 'repricedLines' | 'repriceDeltaPaise'> }) {
  if (r.repricedLines == null) return null;
  return (
    <span className="block text-xs text-gray-500">
      Back-dated: re-priced {r.repricedLines} line{r.repricedLines === 1 ? '' : 's'}, balance <Money paise={r.repriceDeltaPaise ?? 0} signed />
    </span>
  );
}

/**
 * /admin/fund "Rates & alerts" — READ-ONLY (owner D6, 2026-11-23): agency fee, voucher item discounts and the
 * low-balance alert are managed by Gifsy in the console (/gifsy/clients/[slug] → Fund). A Gifsy operator gets the
 * link (`consoleHref`); a client admin sees only that Gifsy manages them.
 */
export function FundRatesTab({ refreshKey, internal }: { refreshKey: number; internal: boolean }) {
  const [settings, setSettings] = useState<FundSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fundApi.settings();
    if (r.ok) setSettings(r.data);
    else { setSettings(null); setError(r.message); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  if (error) return <ErrorBlock message={error} onRetry={() => void load()} />;
  if (loading && !settings) return <LoadingBlock label="Loading rates…" />;
  if (!settings) return null;
  const items = settings.items ?? [];
  const env = settings.alertEnvironment;

  return (
    <div className="space-y-5">
      <p data-testid="fund-rates-managed" className="flex flex-wrap items-center gap-1.5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        <Info className="h-4 w-4 flex-shrink-0" aria-hidden />
        <span><strong>Managed by Gifsy in the console.</strong> This view is read-only.</span>
        {settings.consoleHref && (
          <Link href={settings.consoleHref} className="font-medium underline">Change the fund settings →</Link>
        )}
      </p>
      {settings.emailsSwitchedOff && (
        <p data-testid="fund-emails-off" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Low-balance alert e-mails are switched off on this server — no alert e-mail reaches your team from here.
        </p>
      )}
      {settings.lastCheck && (
        <p data-testid="fund-last-check" className="text-sm text-gray-600">
          Last daily check{settings.lastCheck.at ? ` (${formatISTDate(settings.lastCheck.at)})` : ''}: <strong>{alertCheckLabel(settings.lastCheck.status)}</strong>
        </p>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Agency fee on payouts</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm" data-testid="fund-current-fee">
            {settings.currentFee
              ? <>Current: <strong>{feeLabel(settings.currentFee)}</strong> (from {formatISTDate(settings.currentFee.effectiveFrom)})</>
              : <span className="font-medium text-amber-800">No agency fee set — payouts are charged at face value with no fee.</span>}
          </p>
          {settings.scheduledFee && (
            <p className="text-sm text-sky-800" data-testid="fund-scheduled-fee">
              Scheduled from {formatISTDate(settings.scheduledFee.effectiveFrom)}: <strong>{feeLabel(settings.scheduledFee)}</strong>
            </p>
          )}
          {settings.feeRates.length > 0 && (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-500"><th className="pb-1 font-medium">Fee</th><th className="pb-1 font-medium">Effective from</th><th className="pb-1 font-medium">Note</th>{internal && <th className="pb-1 font-medium">Set by</th>}</tr></thead>
              <tbody className="divide-y divide-gray-100">
                {settings.feeRates.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5">{feeLabel(r)}<RepricedNote r={r} /></td>
                    <td className="py-1.5">{formatISTDate(r.effectiveFrom)}</td>
                    <td className="py-1.5 text-gray-600">{r.note ?? '—'}</td>
                    {internal && <td className="py-1.5 text-xs text-gray-500">{r.createdByName ?? 'Unknown'} · {formatISTDate(r.createdAt)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Voucher discount by item</CardTitle></CardHeader>
        <CardContent className="space-y-4 overflow-x-auto">
          {items.length === 0 ? (
            <EmptyBlock>No voucher items in this client&apos;s catalogue yet.</EmptyBlock>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="text-left text-xs text-gray-500"><th className="pb-1 font-medium">Voucher item</th><th className="pb-1 font-medium">Current discount</th><th className="pb-1 font-medium">Since</th><th className="pb-1 font-medium">Scheduled</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((it) => (
                  <tr key={it.rewardId} data-testid="fund-item-row">
                    <td className="py-1.5">
                      {it.name}
                      {it.deleted ? <span className="ml-1.5 rounded bg-gray-200 px-1.5 py-0.5 text-[11px] text-gray-700">Deleted</span>
                        : !it.active ? <span className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">Inactive</span> : null}
                      <span className="block text-xs text-gray-500">{[it.code, it.brandText].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td className="py-1.5">
                      {it.currentRateBps == null
                        ? <span className="font-medium text-amber-800">Not set — charged at face</span>
                        : bpsToPercentLabel(it.currentRateBps)}
                    </td>
                    <td className="py-1.5">{it.currentEffectiveFrom ? formatISTDate(it.currentEffectiveFrom) : '—'}</td>
                    <td className="py-1.5 text-sky-800">
                      {it.scheduledFrom ? `${bpsToPercentLabel(it.scheduledRateBps)} from ${formatISTDate(it.scheduledFrom)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {settings.discountRates.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-medium text-gray-600">Discount history ({settings.discountRates.length})</summary>
              <table className="mt-2 w-full text-sm">
                <thead><tr className="text-left text-xs text-gray-500"><th className="pb-1 font-medium">Voucher item</th><th className="pb-1 font-medium">Discount</th><th className="pb-1 font-medium">Effective from</th><th className="pb-1 font-medium">Note</th>{internal && <th className="pb-1 font-medium">Set by</th>}</tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {settings.discountRates.map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5">{r.rewardLabel ?? r.rewardId ?? '—'}</td>
                      <td className="py-1.5">{bpsToPercentLabel(r.rateBps)}<RepricedNote r={r} /></td>
                      <td className="py-1.5">{formatISTDate(r.effectiveFrom)}</td>
                      <td className="py-1.5 text-gray-600">{r.note ?? '—'}</td>
                      {internal && <td className="py-1.5 text-xs text-gray-500">{r.createdByName ?? 'Unknown'} · {formatISTDate(r.createdAt)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Low-balance alert</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm" data-testid="fund-alert-view">
          <p>
            Threshold: {settings.thresholdPaise == null ? <span className="text-gray-500">not set — no low-balance alert</span> : <strong>{formatInrPaise(settings.thresholdPaise)}</strong>}
          </p>
          <p>
            Recipients: {settings.alertRecipients.length === 0 ? <span className="text-gray-500">none</span> : settings.alertRecipients.join(', ')}
          </p>
          <p className="text-xs text-gray-500">
            When the balance is below the threshold, e-mails go Monday to Saturday, once an opening balance is recorded. Spend is never blocked.
          </p>
          {settings.lastAlertSentOn && (
            <p className="text-xs text-gray-500">
              Last e-mail sent on {formatISTDate(settings.lastAlertSentOn)}
              {settings.lastAlertRecipients != null ? ` to ${settings.lastAlertRecipients} recipient${settings.lastAlertRecipients === 1 ? '' : 's'}` : ''}.
            </p>
          )}
          {settings.lastAlertError && (
            <p role="alert" className="text-xs font-semibold text-red-700">
              {internal ? `The last alert e-mail FAILED: ${settings.lastAlertError}` : settings.lastAlertError}
            </p>
          )}
          {internal && env && env !== 'live' && (
            <p data-testid="fund-alert-env" className="rounded-lg bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-900">
              {env === 'test'
                ? 'TEST environment: low-balance e-mails go to one test address only, not to these recipients.'
                : 'Low-balance e-mails are OFF in this environment — nothing is sent.'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
