'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { PlusCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { formatISTDate, formatISTDateTime } from '@/lib/ist-date';
import { formatInrPaise } from '@/lib/money-format';
import { fundApi, parseRupees, todayIstKey, type FundEntry } from '@/lib/fund';
import { EmptyBlock, ErrorBlock, Field, LoadingBlock, MAXLEN, Money, focusField, inputCls } from './fund-ui';

const ENTRY_LABELS: Record<FundEntry['entryType'], string> = {
  RECEIPT: 'Advance received',
  ADJUSTMENT: 'Adjustment',
  OPENING_BALANCE: 'Opening balance',
};

const PAYMENT_MODES = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Other'];

type FormKind = 'receipt' | 'adjustment' | 'opening' | null;
type FieldErrors = Record<string, string>;

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>;
}

/** Shared form state: field errors (linked to their inputs) + the first invalid field gets focus (C15). */
function useFormErrors() {
  const [fieldErr, setFieldErr] = useState<FieldErrors>({});
  const [err, setErr] = useState<string | null>(null);
  /** Show field errors (in DOM order of `order`) and focus the first. Returns true when there are any. */
  const check = (errors: FieldErrors, order: string[]) => {
    setFieldErr(errors);
    const first = order.find((id) => errors[id]);
    if (first) {
      setErr('Please fix the highlighted field' + (Object.keys(errors).length > 1 ? 's.' : '.'));
      setTimeout(() => focusField(first), 0);
      return true;
    }
    setErr(null);
    return false;
  };
  return { fieldErr, err, setErr, check };
}

interface FormProps { onDone: () => void; onCancel: () => void; onBusy: (b: boolean) => void }

function ReceiptForm({ onDone, onCancel, onBusy }: FormProps) {
  const [f, setF] = useState({ amount: '', receivedOn: todayIstKey(), referenceNumber: '', bankName: '', paymentMode: '', notes: '' });
  const [busy, setBusyState] = useState(false);
  const { fieldErr, err, setErr, check } = useFormErrors();
  const setBusy = (b: boolean) => { setBusyState(b); onBusy(b); };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const amountRupees = parseRupees(f.amount);
    const errors: FieldErrors = {};
    if (amountRupees == null || amountRupees <= 0) errors['rc-amount'] = 'Enter the amount received in rupees (more than ₹0, up to 2 decimals).';
    if (!f.receivedOn) errors['rc-date'] = 'Enter the date the money was received.';
    if (!f.referenceNumber.trim()) errors['rc-ref'] = 'Enter the UTR / bank reference — it is required.';
    if (check(errors, ['rc-amount', 'rc-date', 'rc-ref'])) return;
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
      <Field id="rc-amount" label="Amount received (₹)" hint="Type rupees, e.g. 150000 or 1500.50." error={fieldErr['rc-amount']}>
        <input id="rc-amount" inputMode="decimal" value={f.amount} onChange={set('amount')} className={inputCls} placeholder="0.00" disabled={busy} />
      </Field>
      <Field id="rc-date" label="Date received" error={fieldErr['rc-date']}>
        <input id="rc-date" type="date" value={f.receivedOn} onChange={set('receivedOn')} max={todayIstKey()} className={inputCls} disabled={busy} />
      </Field>
      <Field id="rc-ref" label="UTR / reference (required)" error={fieldErr['rc-ref']}>
        <input id="rc-ref" value={f.referenceNumber} onChange={set('referenceNumber')} maxLength={MAXLEN.reference} className={inputCls} placeholder="e.g. HDFCN52026112312345" disabled={busy} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="rc-bank" label="Bank (optional)">
          <input id="rc-bank" value={f.bankName} onChange={set('bankName')} maxLength={MAXLEN.bank} className={inputCls} disabled={busy} />
        </Field>
        <Field id="rc-mode" label="Payment mode (optional)">
          <select id="rc-mode" value={f.paymentMode} onChange={set('paymentMode')} className={inputCls} disabled={busy}>
            <option value="">—</option>
            {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      </div>
      <Field id="rc-notes" label="Note (optional)">
        <textarea id="rc-notes" rows={2} value={f.notes} onChange={set('notes')} maxLength={MAXLEN.notes} className={inputCls} disabled={busy} />
      </Field>
      <FormError message={err} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{busy ? 'Saving…' : 'Record advance'}</Button>
      </div>
    </form>
  );
}

function AdjustmentForm({ onDone, onCancel, onBusy }: FormProps) {
  const [f, setF] = useState({ amount: '', date: todayIstKey(), reason: '' });
  const [busy, setBusyState] = useState(false);
  const { fieldErr, err, setErr, check } = useFormErrors();
  const setBusy = (b: boolean) => { setBusyState(b); onBusy(b); };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const amountRupees = parseRupees(f.amount);
    const errors: FieldErrors = {};
    if (amountRupees == null || amountRupees === 0) errors['adj-amount'] = 'Enter a non-zero amount in rupees (use a minus sign to take money off the advance).';
    if (!f.date) errors['adj-date'] = 'Enter the date of the adjustment.';
    if (!f.reason.trim()) errors['adj-reason'] = 'A reason is required for every adjustment.';
    if (check(errors, ['adj-amount', 'adj-date', 'adj-reason'])) return;
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
        hint="Positive adds to the advance (e.g. money recovered for a reversed payout). Negative takes money off the advance. +2500, -2500 and −2500 all work."
        error={fieldErr['adj-amount']}
      >
        <input id="adj-amount" inputMode="decimal" value={f.amount} onChange={set('amount')} className={inputCls} placeholder="e.g. 2500 or -2500" disabled={busy} />
      </Field>
      <Field id="adj-date" label="Date" error={fieldErr['adj-date']}>
        <input id="adj-date" type="date" value={f.date} onChange={set('date')} max={todayIstKey()} className={inputCls} disabled={busy} />
      </Field>
      <Field id="adj-reason" label="Reason (required)" error={fieldErr['adj-reason']}>
        <textarea id="adj-reason" rows={3} value={f.reason} onChange={set('reason')} maxLength={MAXLEN.reason} className={inputCls} placeholder="e.g. Recovered ₹2,500 for reversed payout CP-123" disabled={busy} />
      </Field>
      <FormError message={err} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{busy ? 'Saving…' : 'Record adjustment'}</Button>
      </div>
    </form>
  );
}

/** Owner D2: the opening balance can never be changed — a confirmation step shows the amount + date first. */
function OpeningForm({ onDone, onCancel, onBusy }: FormProps) {
  const [f, setF] = useState({ amount: '', asOfDate: todayIstKey(), notes: '' });
  const [busy, setBusyState] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const { fieldErr, err, setErr, check } = useFormErrors();
  const setBusy = (b: boolean) => { setBusyState(b); onBusy(b); };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  function review(e: React.FormEvent) {
    e.preventDefault();
    const amountRupees = parseRupees(f.amount);
    const errors: FieldErrors = {};
    if (amountRupees == null) errors['ob-amount'] = 'Enter the opening balance in rupees (up to 2 decimals).';
    if (!f.asOfDate) errors['ob-date'] = 'Enter the as-of date.';
    if (check(errors, ['ob-amount', 'ob-date'])) return;
    setConfirming(amountRupees);
  }

  async function record() {
    if (busy || confirming == null) return;
    setErr(null);
    setBusy(true);
    const r = await fundApi.post('opening-balance', {
      amountRupees: confirming,
      asOfDate: f.asOfDate,
      ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    onDone();
  }

  if (confirming != null) {
    return (
      <div className="space-y-3" data-testid="fund-opening-confirm">
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">
            The opening balance can&apos;t be changed later — check the amount and the date (spend before this date is not tracked).
          </p>
          <p className="mt-1">
            Opening balance <strong>{formatInrPaise(Math.round(confirming * 100))}</strong> as of the start of{' '}
            <strong>{formatISTDate(f.asOfDate)}</strong>.
          </p>
        </div>
        <FormError message={err} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={() => { setErr(null); setConfirming(null); }} disabled={busy}>Back — change it</Button>
          <Button type="button" variant="primary" onClick={() => void record()} loading={busy}>{busy ? 'Saving…' : 'Yes, record the opening balance'}</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={review} className="space-y-3" noValidate>
      <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
        The opening balance is the client&apos;s balance at the <strong>start</strong> of the as-of date. Spend before that date is
        ignored; spend on or after it is tracked. It can be recorded only once per client and can&apos;t be changed — correct it
        later with an Adjustment.
      </p>
      <Field id="ob-amount" label="Opening balance (₹)" error={fieldErr['ob-amount']}>
        <input id="ob-amount" inputMode="decimal" value={f.amount} onChange={set('amount')} className={inputCls} placeholder="0.00" />
      </Field>
      <Field id="ob-date" label="As-of date (balance at the start of this day)" error={fieldErr['ob-date']}>
        <input id="ob-date" type="date" value={f.asOfDate} onChange={set('asOfDate')} max={todayIstKey()} className={inputCls} />
      </Field>
      <Field id="ob-notes" label="Note (optional)">
        <textarea id="ob-notes" rows={2} value={f.notes} onChange={set('notes')} maxLength={MAXLEN.notes} className={inputCls} />
      </Field>
      <FormError message={err} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary">Review opening balance</Button>
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
  const [formBusy, setFormBusy] = useState(false);
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
    setFormBusy(false);
    setForm(null);
    setSaved(msg);
    onChanged();
  }
  /** C9: a form can't be closed (Esc / outside click / ×) while it is saving. */
  const closeForm = (open: boolean) => { if (!open && !formBusy) setForm(null); };
  const cancel = () => { if (!formBusy) setForm(null); };
  const open = (k: Exclude<FormKind, null>) => { setSaved(null); setFormBusy(false); setForm(k); };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" onClick={() => open('receipt')}>
            <PlusCircle className="h-4 w-4" aria-hidden /> Record advance received
          </Button>
          <Button type="button" variant="outline" onClick={() => open('adjustment')}>Adjustment</Button>
          {!openingExists && (
            <Button type="button" variant="outline" onClick={() => open('opening')}>Opening balance</Button>
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

      <Modal open={form === 'receipt'} onOpenChange={closeForm} title="Record advance received"
        description="Money the client has paid to Gifsy. Corrections are made with a new entry, never an edit.">
        <ReceiptForm onDone={() => done('Advance recorded.')} onCancel={cancel} onBusy={setFormBusy} />
      </Modal>
      <Modal open={form === 'adjustment'} onOpenChange={closeForm} title="Record an adjustment"
        description="A signed correction to the advance, with a reason. Every adjustment is audited.">
        <AdjustmentForm onDone={() => done('Adjustment recorded.')} onCancel={cancel} onBusy={setFormBusy} />
      </Modal>
      <Modal open={form === 'opening'} onOpenChange={closeForm} title="Record the opening balance">
        <OpeningForm onDone={() => done('Opening balance recorded.')} onCancel={cancel} onBusy={setFormBusy} />
      </Modal>
    </div>
  );
}
