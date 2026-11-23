'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatISTDate } from '@/lib/ist-date';
import { DOWNLOADS_PAGE_HREF, downloadOrQueue } from '@/lib/exports/download';
import {
  EVENT_LABELS, SPEND_TYPE_LABELS, STATUS_LABELS, fundApi,
  type FundEvent, type FundSpendType, type FundStatement, type FundStatementLine, type FundStatus,
} from '@/lib/fund';
import { EmptyBlock, ErrorBlock, Field, FlagChips, LoadingBlock, Money, StatusPill, inputCls } from './fund-ui';

interface Filters { from: string; to: string; type: string; status: string; event: string; q: string }
const EMPTY_FILTERS: Filters = { from: '', to: '', type: '', status: '', event: '', q: '' };
const PAGE_SIZE = 50;

/**
 * Where a statement row's source record can be opened. Only routes that exist AND that the viewer can reach:
 * credit / visibility payout entries → Payout Status (both roles); 194C TDS → Recovery / Attribution (both roles);
 * a redemption payout transaction → Payout Batches (Gifsy only — that page is Gifsy-only). Redemption orders have no
 * admin detail page, so they stay plain text.
 */
export function sourceHref(line: Pick<FundStatementLine, 'sourceKind'>, isGifsy: boolean): string | null {
  switch (line.sourceKind) {
    case 'creditPayoutEntry': return '/admin/credits-payouts/status';
    case 'tdsRecoveryEntry': return '/admin/tds-recovery';
    case 'payoutTransaction': return isGifsy ? '/admin/payouts' : null;
    default: return null;
  }
}

export function FundStatementTab({ isGifsy, refreshKey }: { isGifsy: boolean; refreshKey: number }) {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<FundStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ kind: 'queued' | 'error' | 'done'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v.trim()) p.set(k, v.trim());
    p.set('order', 'desc');
    p.set('page', String(page));
    p.set('limit', String(PAGE_SIZE));
    const r = await fundApi.statement(p);
    if (r.ok) setData(r.data);
    else { setData(null); setError(r.message); }
    setLoading(false);
  }, [filters, page]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  function apply(e?: React.FormEvent) {
    e?.preventDefault();
    setPage(1);
    setFilters(draft);
  }
  function clear() {
    setDraft(EMPTY_FILTERS);
    setPage(1);
    setFilters(EMPTY_FILTERS);
  }

  async function exportExcel() {
    setExporting(true);
    setExportMsg(null);
    const p = new URLSearchParams();
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    const out = await downloadOrQueue(`/api/fund/export${p.toString() ? `?${p.toString()}` : ''}`, {
      fallbackFileName: 'fund-reconciliation.xlsx',
    });
    if (out.kind === 'queued') setExportMsg({ kind: 'queued', text: out.message });
    else if (out.kind === 'error') setExportMsg({ kind: 'error', text: out.message });
    else setExportMsg({ kind: 'done', text: `Downloaded ${out.fileName}.` });
    setExporting(false);
  }

  const period = data?.period;

  return (
    <div className="space-y-4">
      <form onSubmit={apply} className="grid grid-cols-2 gap-3 rounded-xl border border-gray-200 bg-white p-4 md:grid-cols-4 xl:grid-cols-7" aria-label="Statement filters">
        <Field id="st-from" label="From"><input id="st-from" type="date" value={draft.from} onChange={set('from')} className={inputCls} /></Field>
        <Field id="st-to" label="To (inclusive)"><input id="st-to" type="date" value={draft.to} onChange={set('to')} className={inputCls} /></Field>
        <Field id="st-type" label="Type">
          <select id="st-type" value={draft.type} onChange={set('type')} className={inputCls}>
            <option value="">All types</option>
            {(Object.keys(SPEND_TYPE_LABELS) as FundSpendType[]).map((t) => <option key={t} value={t}>{SPEND_TYPE_LABELS[t]}</option>)}
          </select>
        </Field>
        <Field id="st-status" label="Status">
          <select id="st-status" value={draft.status} onChange={set('status')} className={inputCls}>
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABELS) as FundStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </Field>
        <Field id="st-event" label="Event">
          <select id="st-event" value={draft.event} onChange={set('event')} className={inputCls}>
            <option value="">All events</option>
            {(Object.keys(EVENT_LABELS) as FundEvent[]).map((ev) => <option key={ev} value={ev}>{EVENT_LABELS[ev]}</option>)}
          </select>
        </Field>
        <Field id="st-q" label="Search"><input id="st-q" type="search" value={draft.q} onChange={set('q')} placeholder="Reference, outlet, UTR…" className={inputCls} /></Field>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="primary" size="sm">Apply</Button>
          <Button type="button" variant="outline" size="sm" onClick={clear}>Clear</Button>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={exportExcel} loading={exporting}>
          <Download className="h-4 w-4" aria-hidden /> {exporting ? 'Preparing…' : 'Download Excel'}
        </Button>
        <span className="text-xs text-gray-500">Excel covers the From / To dates above (all dates when blank).</span>
        {exportMsg?.kind === 'queued' && (
          <span role="status" className="text-xs text-sky-800">
            {exportMsg.text} <Link href={DOWNLOADS_PAGE_HREF} className="font-medium underline">Go to Downloads</Link>
          </span>
        )}
        {exportMsg?.kind === 'error' && <span role="alert" className="text-xs text-red-700">{exportMsg.text}</span>}
        {exportMsg?.kind === 'done' && <span role="status" className="text-xs text-green-700">{exportMsg.text}</span>}
      </div>

      {error && <ErrorBlock message={error} onRetry={() => void load()} />}
      {loading && !data && <LoadingBlock label="Loading statement…" />}

      {period && (
        <div data-testid="fund-period" className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            ['Opening balance for the period', period.openingBalancePaise],
            ['Money in (opening + receipts + adjustments)', period.openingEntryPaise + period.receiptsPaise + period.adjustmentsPaise],
            ['Charges', -Math.abs(period.chargesPaise)],
            ['Returns', Math.abs(period.returnsPaise)],
            ['Closing balance', period.closingBalancePaise],
          ].map(([label, v]) => (
            <div key={label as string} className="rounded-xl border border-gray-200 bg-white p-3">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="mt-1 text-sm font-bold"><Money paise={v as number} /></p>
            </div>
          ))}
        </div>
      )}

      {data && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            {data.lines.length === 0 ? (
              <EmptyBlock>No statement lines match these filters.</EmptyBlock>
            ) : (
              <table className="w-full min-w-[1200px] text-sm" aria-busy={loading}>
                <thead className="bg-gray-50">
                  <tr className="text-left text-xs text-gray-500">
                    {['Date', 'Event', 'Type', 'Reference', 'Description', 'Face', 'Discount', 'Fee', 'TDS', 'Amount', 'Balance', 'Status', 'Flags', 'UTR'].map((h) => (
                      <th key={h} className={`px-3 py-2 font-medium ${['Face', 'Discount', 'Fee', 'TDS', 'Amount', 'Balance'].includes(h) ? 'text-right' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.lines.map((l) => {
                    const href = sourceHref(l, isGifsy);
                    return (
                      <tr key={l.seq} data-testid="fund-statement-row">
                        <td className="whitespace-nowrap px-3 py-2">{formatISTDate(l.date)}</td>
                        <td className="px-3 py-2">{EVENT_LABELS[l.event] ?? l.event}</td>
                        <td className="px-3 py-2">{l.type ? SPEND_TYPE_LABELS[l.type] ?? l.type : '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                          {href ? <Link href={href} className="text-[var(--brand-primary)] underline">{l.ref}</Link> : l.ref}
                        </td>
                        <td className="px-3 py-2 text-gray-700">
                          {l.description}
                          {(l.brandLabel || l.rateLabel) && (
                            <span className="block text-xs text-gray-500">{[l.brandLabel, l.rateLabel].filter(Boolean).join(' · ')}</span>
                          )}
                          {l.receivablePaise > 0 && (
                            <span className="block text-xs font-medium text-red-700">To recover: <Money paise={l.receivablePaise} /></span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right"><Money paise={l.facePaise} /></td>
                        <td className="px-3 py-2 text-right"><Money paise={l.discountPaise} /></td>
                        <td className="px-3 py-2 text-right"><Money paise={l.feePaise} /></td>
                        <td className="px-3 py-2 text-right"><Money paise={l.tdsPaise} /></td>
                        <td className="px-3 py-2 text-right font-medium" data-testid="fund-statement-amount"><Money paise={l.amountPaise} signed /></td>
                        <td className="px-3 py-2 text-right"><Money paise={l.balancePaise} /></td>
                        <td className="px-3 py-2"><StatusPill status={l.status} /></td>
                        <td className="px-3 py-2"><FlagChips flags={l.flags} /></td>
                        <td className="px-3 py-2 font-mono text-xs">{l.utr ?? ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {data && data.pagination.pages > 1 && (
        <nav className="flex items-center justify-between text-sm" aria-label="Statement pages">
          <span className="text-gray-500">
            Page {data.pagination.page} of {data.pagination.pages} · {data.pagination.total.toLocaleString('en-IN')} lines
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button type="button" variant="outline" size="sm" disabled={loading || page >= data.pagination.pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </nav>
      )}
    </div>
  );
}
