'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { PlusCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { formatISTDate, formatISTDateTime } from '@/lib/ist-date';
import { fundApi, parseRupees, todayIstKey, type FundEntry } from '@/lib/fund';
import { EmptyBlock, ErrorBlock, Field, LoadingBlock, Money, inputCls } from './fund-ui';

const ENTRY_LABELS: Record<FundEntry['entryType'], string> = {
  RECEIPT: 'Advance received',
  ADJUSTMENT: 'Adjustment',
  OPENING_BALANCE: 'Opening balance',
};

const PAYMENT_MODES = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Other'];

type FormKind = 'receipt' | 'adjustment' | 'opening' | null;

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>;
}

function ReceiptForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ amount: '', receivedOn: todayIstKey(), referenceNumber: '', bankName: '', paymentMode: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amountRupees = parseRupees(f.amount);
    if (amountRupees == null || amountRupees <= 0) return setErr('Enter the amount received in rupees (more than ₹0, up to 2 decimals).');
    if (!f.receivedOn) return setErr('Enter the date the money was received.');
    if (!f.referenceNumber.trim()) return setErr('Enter the UTR / bank reference — it is required.');
    setErr(null);
    setBusy(true);
    const r = await fundApi.post('receipts', {
      amountRupees,
      receivedOn: f.receivedOn,
      referenceNumber: f.referenceNumber.trim(),
      ...(f.bankName.trim() ? { bankName: f.bankName.trim() } : {}),
      ...(f.paymentMode ? { paymentMode: f.paymentMode } : {}),
      ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field id="rc-amount" label="Amount received (₹)" hint="Type rupees, e.g. 150000 or 1500.50.">
        <input id="rc-amount" inputMode="decimal" value={f.amount} onChange={set('amount')} className={inputCls} placeholder="0.00" />
      </Field>
      <Field id="rc-date" label="Date received">
        <input id="rc-date" type="date" value={f.receivedOn} onChange={set('receivedOn')} className={inputCls} />
      </Field>
      <Field id="rc-ref" label="UTR / reference (required)">
        <input id="rc-ref" value={f.referenceNumber} onChange={set('referenceNumber')} className={inputCls} placeholder="e.g. HDFCN52026112312345" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="rc-bank" label="Bank (optional)">
          <input id="rc-bank" value={f.bankName} onChange={set('bankName')} className={inputCls} />
        </Field>
        <Field id="rc-mode" label="Payment mode (optional)">
          <select id="rc-mode" value={f.paymentMode} onChange={set('paymentMode')} className={inputCls}>
            <option value="">—</option>
            {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      </div>
      <Field id="rc-notes" label="Note (optional)">
        <textarea id="rc-notes" rows={2} value={f.notes} onChange={set('notes')} className={inputCls} />
      </Field>
      <FormError message={err} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{busy ? 'Saving…' : 'Record advance'}</Button>
      </div>
    </form>
  );
}

function AdjustmentForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ amount: '', date: todayIstKey(), reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amountRupees = parseRupees(f.amount);
    if (amountRupees == null || amountRupees === 0) return setErr('Enter a non-zero amount in rupees (use a minus sign to take money off the advance).');
    if (!f.date) return setErr('Enter the date of the adjustment.');
    if (!f.reason.trim()) return setErr('A reason is required for every adjustment.');
    setErr(null);
    setBusy(true);
    const r = await fundApi.post('adjustments', { amountRupees, date: f.date, reason: f.reason.trim() });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field
        id="adj-amount"
        label="Amount (₹, + or −)"
        hint="Positive adds to the advance (e.g. money recovered for a reversed payout). Negative takes money off the advance."
      >
        <input id="adj-amount" inputMode="decimal" value={f.amount} onChange={set('amount')} className={inputCls} placeholder="e.g. 2500 or -2500" />
      </Field>
      <Field id="adj-date" label="Date">
        <input id="adj-date" type="date" value={f.date} onChange={set('date')} className={inputCls} />
      </Field>
      <Field id="adj-reason" label="Reason (required)">
        <textarea id="adj-reason" rows={3} value={f.reason} onChange={set('reason')} className={inputCls} placeholder="e.g. Recovered ₹2,500 for reversed payout CP-123" />
      </Field>
      <FormError message={err} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{busy ? 'Saving…' : 'Record adjustment'}</Button>
      </div>
    </form>
  );
}

function OpeningForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ amount: '', asOfDate: todayIstKey(), notes: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amountRupees = parseRupees(f.amount);
    if (amountRupees == null) return setErr('Enter the opening balance in rupees (up to 2 decimals).');
    if (!f.asOfDate) return setErr('Enter the as-of date.');
    setErr(null);
    setBusy(true);
    const r = await fundApi.post('opening-balance', {
      amountRupees,
      asOfDate: f.asOfDate,
      ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
        The opening balance is the client&apos;s balance at the <strong>start</strong> of the as-of date. Spend before that date is
        ignored; spend on or after it is tracked. It can be recorded only once per client — correct it later with an Adjustment.
      </p>
      <Field id="ob-amount" label="Opening balance (₹)">
        <input id="ob-amount" inputMode="decimal" value={f.amount} onChange={set('amount')} className={inputCls} placeholder="0.00" />
      </Field>
      <Field id="ob-date" label="As-of date (balance at the start of this day)">
        <input id="ob-date" type="date" value={f.asOfDate} onChange={set('asOfDate')} className={inputCls} />
      </Field>
      <Field id="ob-notes" label="Note (optional)">
        <textarea id="ob-notes" rows={2} value={f.notes} onChange={set('notes')} className={inputCls} />
      </Field>
      <FormError message={err} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{busy ? 'Saving…' : 'Record opening balance'}</Button>
      </div>
    </form>
  );
}

export function FundEntriesTab({
  canManage, hasOpening, refreshKey, onChanged,
}: { canManage: boolean; hasOpening: boolean; refreshKey: number; onChanged: () => void }) {
  const [entries, setEntries] = useState<FundEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormKind>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fundApi.entries();
    if (r.ok) setEntries(Array.isArray(r.data.entries) ? r.data.entries : []);
    else { setEntries(null); setError(r.message); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const openingExists = hasOpening || !!entries?.some((e) => e.entryType === 'OPENING_BALANCE');

  function done(msg: string) {
    setForm(null);
    setSaved(msg);
    onChanged();
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" onClick={() => { setSaved(null); setForm('receipt'); }}>
            <PlusCircle className="h-4 w-4" aria-hidden /> Record advance received
          </Button>
          <Button type="button" variant="outline" onClick={() => { setSaved(null); setForm('adjustment'); }}>Adjustment</Button>
          {!openingExists && (
            <Button type="button" variant="outline" onClick={() => { setSaved(null); setForm('opening'); }}>Opening balance</Button>
          )}
        </div>
      )}
      {saved && <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{saved}</p>}

      {error && <ErrorBlock message={error} onRetry={() => void load()} />}
      {loading && !entries && <LoadingBlock label="Loading receipts…" />}
      {entries && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            {entries.length === 0 ? (
              <EmptyBlock>No advances, adjustments or opening balance recorded yet.</EmptyBlock>
            ) : (
              <table className="w-full min-w-[960px] text-sm">
                <thead className="bg-gray-50">
                  <tr className="text-left text-xs text-gray-500">
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Number</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 font-medium">UTR / reference</th>
                    <th className="px-3 py-2 font-medium">Bank / mode</th>
                    <th className="px-3 py-2 font-medium">Note / reason</th>
                    <th className="px-3 py-2 font-medium">Recorded</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {entries.map((e) => (
                    <tr key={e.id} data-testid="fund-entry-row">
                      <td className="px-3 py-2">{ENTRY_LABELS[e.entryType] ?? e.entryType}</td>
                      <td className="px-3 py-2 font-mono text-xs">{e.receiptNumber ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2">{formatISTDate(e.date)}</td>
                      <td className="px-3 py-2 text-right"><Money paise={e.amountPaise} signed={e.entryType === 'ADJUSTMENT'} /></td>
                      <td className="px-3 py-2 font-mono text-xs">{e.referenceNumber ?? '—'}</td>
                      <td className="px-3 py-2">{[e.bankName, e.paymentMode].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{e.reason ?? e.notes ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500">
                        {e.createdByName ?? 'Unknown'}<br />{formatISTDateTime(e.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      <Modal open={form === 'receipt'} onOpenChange={(o) => !o && setForm(null)} title="Record advance received"
        description="Money the client has paid to Gifsy. Corrections are made with a new entry, never an edit.">
        <ReceiptForm onDone={() => done('Advance recorded.')} onCancel={() => setForm(null)} />
      </Modal>
      <Modal open={form === 'adjustment'} onOpenChange={(o) => !o && setForm(null)} title="Record an adjustment"
        description="A signed correction to the advance, with a reason. Every adjustment is audited.">
        <AdjustmentForm onDone={() => done('Adjustment recorded.')} onCancel={() => setForm(null)} />
      </Modal>
      <Modal open={form === 'opening'} onOpenChange={(o) => !o && setForm(null)} title="Record the opening balance">
        <OpeningForm onDone={() => done('Opening balance recorded.')} onCancel={() => setForm(null)} />
      </Modal>
    </div>
  );
}
