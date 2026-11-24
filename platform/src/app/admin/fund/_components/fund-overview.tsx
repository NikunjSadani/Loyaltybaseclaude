'use client';

import React from 'react';
import Link from 'next/link';
import { AlertTriangle, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatISTDate } from '@/lib/ist-date';
import { formatInrPaise } from '@/lib/money-format';
import { FLAG_TEXT, SPEND_TYPE_LABELS, type FundFlag, type FundSummary } from '@/lib/fund';
import { EmptyBlock, Money } from './fund-ui';

function StatCard({ label, paise, sub, tone = 'default', testId }: {
  label: string; paise: number; sub?: string; tone?: 'default' | 'good' | 'bad' | 'muted'; testId?: string;
}) {
  const box = tone === 'bad' ? 'border-red-300 bg-red-50' : tone === 'good' ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white';
  const val = tone === 'bad' ? 'text-red-800' : tone === 'good' ? 'text-green-800' : tone === 'muted' ? 'text-gray-600' : 'text-gray-900';
  return (
    <div data-testid={testId} className={`rounded-xl border p-4 ${box}`}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-1 text-lg font-bold ${val}`}><Money paise={paise} /></p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

function Warning({ title, children, testId }: { title: string; children?: React.ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden />{title}</p>
      {children && <div className="mt-1 text-xs text-amber-900">{children}</div>}
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where the settings are changed: Gifsy gets the console link; a client admin is told Gifsy manages them. */
function SettingsPointer({ summary, internal, what }: { summary: FundSummary; internal: boolean; what: string }) {
  if (!internal) return <> Gifsy sets {what}.</>;
  if (summary.settingsConsoleHref) {
    return <> Set {what} in the <Link href={summary.settingsConsoleHref} className="font-medium underline">Gifsy console (Fund section)</Link>.</>;
  }
  return <> Set {what} in the Gifsy console (client page → Fund).</>;
}

/**
 * Low-balance banner. `internal` = a Gifsy operator; a client admin gets client-appropriate copy (C11): no Gifsy
 * instructions, and the server already sends a client-safe sentence in place of a raw mail error.
 */
export function LowBalanceBanner({ summary, internal }: { summary: FundSummary; internal: boolean }) {
  const lb = summary.lowBalance;
  if (!lb?.isLow) return null;
  const sentTo = lb.lastAlertRecipients ?? lb.recipients;
  return (
    <div role="alert" data-testid="fund-low-balance" className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
      <p className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden />
        Low balance: {formatInrPaise(summary.totals.balancePaise)} is below the alert threshold
        {lb.thresholdPaise != null ? ` of ${formatInrPaise(lb.thresholdPaise)}` : ''}.
      </p>
      <p className="mt-1 text-xs">
        {internal
          ? 'Spend is never blocked — vouchers and payouts carry on. Gifsy decides case by case whether to ask the client for a top-up.'
          : 'Spend is never blocked — vouchers and payouts carry on. Gifsy may contact you about a top-up of the advance.'}
      </p>
      <p className="mt-1 text-xs">
        {lb.alertsPaused === 'NO_OPENING'
          ? 'Low-balance e-mails start once an opening balance is recorded.'
          : lb.alertsPaused === 'CLIENT_INACTIVE'
            ? 'Low-balance e-mails are paused while this client is not active.'
            : lb.lastAlertSentOn
              ? `Last low-balance e-mail sent on ${formatISTDate(lb.lastAlertSentOn)} to ${plural(sentTo, 'recipient')}. E-mails go Monday to Saturday while the balance stays low.`
              : lb.recipients > 0
                ? 'No low-balance e-mail has been sent yet. E-mails go Monday to Saturday while the balance stays low.'
                : internal
                  ? 'No alert recipients are set, so no low-balance e-mail is sent. Add recipients in the Gifsy console (client page → Fund).'
                  : 'No low-balance e-mail recipients are set up yet.'}
      </p>
      {lb.lastAlertError && (
        <p data-testid="fund-alert-error" className="mt-1 text-xs font-semibold">
          {internal ? `The last low-balance e-mail FAILED: ${lb.lastAlertError}` : lb.lastAlertError}
        </p>
      )}
    </div>
  );
}

/** Flags with their own warning below (the rest are listed in the generic flag block). */
const OWN_WARNING: FundFlag[] = ['NO_ITEM_RATE', 'NO_FEE_RATE'];

export function FundOverview({ summary, internal }: { summary: FundSummary; internal: boolean }) {
  const t = summary.totals;
  const flagCounts = summary.flagCounts ?? {};
  const itemsWithoutRate = summary.itemsWithoutRate ?? [];
  const totalsRow = summary.byType.reduce(
    (a, r) => ({
      count: a.count + r.count,
      face: a.face + r.facePaise,
      discount: a.discount + r.discountPaise,
      fee: a.fee + r.feePaise,
      committed: a.committed + r.committedPaise,
      paid: a.paid + r.paidPaise,
      returned: a.returned + r.returnedPaise,
      net: a.net + r.netChargedPaise,
    }),
    { count: 0, face: 0, discount: 0, fee: 0, committed: 0, paid: 0, returned: 0, net: 0 },
  );
  const otherFlags = (Object.keys(FLAG_TEXT) as FundFlag[]).filter((f) => !OWN_WARNING.includes(f) && (flagCounts[f] ?? 0) > 0);

  return (
    <div className="space-y-5">
      {!summary.hasOpening && (
        <p data-testid="fund-no-opening" className="flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <Info className="h-4 w-4 flex-shrink-0" aria-hidden />
          No opening balance recorded — all history is counted.
        </p>
      )}
      {summary.hasOpening && summary.openingDate && (
        <p className="text-xs text-gray-500">
          Tracking from the opening balance on {formatISTDate(summary.openingDate)}. Spend before that date is not counted.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Advance received" paise={t.openingPaise + t.receiptsPaise} sub="Opening balance + receipts" />
        <StatCard label="Adjustments" paise={t.adjustmentsPaise} sub="Recorded by Gifsy (±)" />
        <StatCard label="Committed (not yet paid)" paise={t.committedPaise} sub="Ordered / approved, not yet paid" />
        <StatCard label="Paid out" paise={t.paidPaise} />
        <StatCard label="Returned" paise={t.returnedPaise} tone="muted" sub="Already credited back (for information)" />
        <StatCard
          testId="fund-balance-card"
          label="Balance (available)"
          paise={t.balancePaise}
          tone={summary.lowBalance?.isLow || t.balancePaise < 0 ? 'bad' : 'good'}
          sub="Committed spend is already deducted"
        />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Spend by type</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {summary.byType.length === 0 ? (
            <EmptyBlock>No spend yet — no vouchers or payouts have been charged to the advance.</EmptyBlock>
          ) : (
          <table className="w-full min-w-[820px] text-sm" data-testid="fund-by-type">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="pb-2 font-medium">Type</th>
                <th className="pb-2 text-right font-medium">Count</th>
                <th className="pb-2 text-right font-medium">Face</th>
                <th className="pb-2 text-right font-medium">Discount</th>
                <th className="pb-2 text-right font-medium">Agency fee</th>
                <th className="pb-2 text-right font-medium">Committed</th>
                <th className="pb-2 text-right font-medium">Paid</th>
                <th className="pb-2 text-right font-medium">Returned</th>
                <th className="pb-2 text-right font-medium">Net charged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {summary.byType.map((r) => (
                <tr key={r.type}>
                  <td className="py-2 text-gray-800">{r.label || SPEND_TYPE_LABELS[r.type] || r.type}</td>
                  <td className="py-2 text-right tabular-nums">
                    {r.count.toLocaleString('en-IN')}
                    {(r.returnedCount ?? 0) > 0 && (
                      <span className="block text-xs text-gray-500" data-testid="fund-type-returned-count">
                        {(r.returnedCount ?? 0).toLocaleString('en-IN')} returned, not charged
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right"><Money paise={r.facePaise} /></td>
                  <td className="py-2 text-right"><Money paise={r.discountPaise} /></td>
                  <td className="py-2 text-right"><Money paise={r.feePaise} /></td>
                  <td className="py-2 text-right"><Money paise={r.committedPaise} /></td>
                  <td className="py-2 text-right"><Money paise={r.paidPaise} /></td>
                  <td className="py-2 text-right"><Money paise={r.returnedPaise} /></td>
                  <td className="py-2 text-right font-medium"><Money paise={r.netChargedPaise} /></td>
                </tr>
              ))}
              <tr className="border-t border-gray-200 font-semibold">
                <td className="py-2">Total</td>
                <td className="py-2 text-right tabular-nums">{totalsRow.count.toLocaleString('en-IN')}</td>
                <td className="py-2 text-right"><Money paise={totalsRow.face} /></td>
                <td className="py-2 text-right"><Money paise={totalsRow.discount} /></td>
                <td className="py-2 text-right"><Money paise={totalsRow.fee} /></td>
                <td className="py-2 text-right"><Money paise={totalsRow.committed} /></td>
                <td className="py-2 text-right"><Money paise={totalsRow.paid} /></td>
                <td className="py-2 text-right"><Money paise={totalsRow.returned} /></td>
                <td className="py-2 text-right"><Money paise={totalsRow.net} /></td>
              </tr>
            </tbody>
          </table>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3" aria-label="Warnings">
        {itemsWithoutRate.length > 0 && (
          <Warning testId="fund-warn-items" title={`${plural(itemsWithoutRate.length, 'voucher item')} without a discount — charged at face value`}>
            {itemsWithoutRate.map((b) => `${b.itemLabel} (${b.count})`).join(', ')}.
            <SettingsPointer summary={summary} internal={internal} what="the voucher item discounts" />
          </Warning>
        )}
        {(flagCounts.NO_FEE_RATE ?? 0) > 0 && (
          <Warning testId="fund-warn-fee" title={`${plural(flagCounts.NO_FEE_RATE ?? 0, 'payout')} with no agency fee set`}>
            {FLAG_TEXT.NO_FEE_RATE.detail}
            <SettingsPointer summary={summary} internal={internal} what="the agency fee" />
          </Warning>
        )}
        {otherFlags.length > 0 && (
          <div data-testid="fund-warn-flags" className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900">
            <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden />Flagged lines</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {otherFlags.map((f) => (
                <li key={f}><strong>{FLAG_TEXT[f].chip} ({flagCounts[f]})</strong>: {FLAG_TEXT[f].detail}</li>
              ))}
            </ul>
          </div>
        )}
        {summary.receivables.items.length > 0 && (
          <Warning testId="fund-warn-receivables" title={`To recover: ${formatInrPaise(summary.receivables.totalPaise)} — paid, then reversed`}>
            <p>
              {internal
                ? 'These were paid out and later reversed. Recover the money off-platform, then record an Adjustment (a positive amount) with the reason.'
                : 'These were paid out and later reversed. Gifsy recovers the money and records it as an adjustment to your advance.'}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {summary.receivables.items.map((r) => (
                <li key={`${r.sourceKind}:${r.sourceId}`}>
                  {r.ref} — {r.description} — {formatInrPaise(r.amountPaise)}{r.paidAt ? ` (paid ${formatISTDate(r.paidAt)})` : ''}
                </li>
              ))}
            </ul>
          </Warning>
        )}
        {summary.preOpeningReturns.items.length > 0 && (
          <Warning testId="fund-warn-preopening" title={`Returned after the opening date, but committed before it: ${formatInrPaise(summary.preOpeningReturns.facePaise)}`}>
            <p>
              {internal
                ? 'This spend was committed before the opening balance date and returned after it. It is NOT credited automatically — record an Adjustment if the client should get it back.'
                : 'This spend was committed before the opening balance date and returned after it. It is not credited automatically — Gifsy reviews these and records an adjustment where due.'}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {summary.preOpeningReturns.items.map((r) => (
                <li key={`${r.sourceKind}:${r.sourceId}`}>
                  {r.ref} — {SPEND_TYPE_LABELS[r.type] ?? r.type} — {formatInrPaise(r.facePaise)} (returned {formatISTDate(r.returnedAt)})
                </li>
              ))}
            </ul>
          </Warning>
        )}
        {summary.excludedEntries.length > 0 && (
          <Warning testId="fund-warn-excluded" title={`${summary.excludedEntries.length} entr${summary.excludedEntries.length === 1 ? 'y' : 'ies'} dated before the opening date — excluded`}>
            <ul className="list-disc pl-5">
              {summary.excludedEntries.map((e) => (
                <li key={e.id}>{e.ref || e.kind} — {formatInrPaise(e.amountPaise)} on {formatISTDate(e.date)}</li>
              ))}
            </ul>
          </Warning>
        )}
      </div>
    </div>
  );
}
