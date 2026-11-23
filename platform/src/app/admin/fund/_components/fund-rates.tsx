'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { formatISTDate } from '@/lib/ist-date';
import { formatInrPaise } from '@/lib/money-format';
import { bpsToPercentLabel, fundApi, parseRupees, todayIstKey, type FundSettings } from '@/lib/fund';
import { EmptyBlock, ErrorBlock, Field, LoadingBlock, inputCls } from './fund-ui';

function feeLabel(f: { feeType: 'PERCENT' | 'FLAT'; rateBps: number | null; flatPaise: number | null }): string {
  return f.feeType === 'PERCENT' ? `${bpsToPercentLabel(f.rateBps)} of each payout` : `${formatInrPaise(f.flatPaise ?? 0)} flat per payout`;
}

/** 0–100 with at most 2 decimals. */
function parsePercent(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : null;
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>;
}

function FeeForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ feeType: 'PERCENT' as 'PERCENT' | 'FLAT', value: '', effectiveFrom: todayIstKey(), note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let body: Record<string, unknown>;
    if (f.feeType === 'PERCENT') {
      const percent = parsePercent(f.value);
      if (percent == null) return setErr('Enter a percent between 0 and 100 (up to 2 decimals).');
      body = { feeType: 'PERCENT', percent };
    } else {
      const flatRupees = parseRupees(f.value);
      if (flatRupees == null || flatRupees < 0) return setErr('Enter the flat fee per payout in rupees (up to 2 decimals).');
      body = { feeType: 'FLAT', flatRupees };
    }
    if (!f.effectiveFrom) return setErr('Enter the date the fee applies from.');
    setErr(null);
    setBusy(true);
    const r = await fundApi.post('rates/fee', { ...body, effectiveFrom: f.effectiveFrom, ...(f.note.trim() ? { note: f.note.trim() } : {}) });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <p className="text-xs text-gray-600">
        The agency fee is added to every cash redemption, target / credit payout and visibility payout committed on or after the
        effective date. Earlier spend keeps the rate that applied then.
      </p>
      <Field id="fee-type" label="Fee type">
        <select id="fee-type" value={f.feeType} onChange={(e) => setF((p) => ({ ...p, feeType: e.target.value as 'PERCENT' | 'FLAT' }))} className={inputCls}>
          <option value="PERCENT">% of each payout</option>
          <option value="FLAT">Flat ₹ per payout</option>
        </select>
      </Field>
      <Field id="fee-value" label={f.feeType === 'PERCENT' ? 'Percent (%)' : 'Flat fee per payout (₹)'}>
        <input id="fee-value" inputMode="decimal" value={f.value} onChange={(e) => setF((p) => ({ ...p, value: e.target.value }))} className={inputCls} />
      </Field>
      <Field id="fee-from" label="Effective from">
        <input id="fee-from" type="date" value={f.effectiveFrom} onChange={(e) => setF((p) => ({ ...p, effectiveFrom: e.target.value }))} className={inputCls} />
      </Field>
      <Field id="fee-note" label="Note (optional)">
        <input id="fee-note" value={f.note} onChange={(e) => setF((p) => ({ ...p, note: e.target.value }))} className={inputCls} />
      </Field>
      <FormError message={err} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{busy ? 'Saving…' : 'Save fee'}</Button>
      </div>
    </form>
  );
}

function DiscountForm({ brand, onDone, onCancel }: {
  brand: { brandKey: string; brandLabel: string }; onDone: () => void; onCancel: () => void;
}) {
  const [f, setF] = useState({ percent: '', effectiveFrom: todayIstKey(), note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const percent = parsePercent(f.percent);
    if (percent == null) return setErr('Enter a percent between 0 and 100 (up to 2 decimals).');
    if (!f.effectiveFrom) return setErr('Enter the date the rate applies from.');
    setErr(null);
    setBusy(true);
    const r = await fundApi.post('rates/discount', {
      brandKey: brand.brandKey, brandLabel: brand.brandLabel, percent, effectiveFrom: f.effectiveFrom,
      ...(f.note.trim() ? { note: f.note.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <p className="text-xs text-gray-600">
        Every {brand.brandLabel} voucher committed on or after the effective date is charged at face value less this discount.
        Rates are never edited — a change is a new rate from a date.
      </p>
      <Field id="disc-percent" label="Discount (%)">
        <input id="disc-percent" inputMode="decimal" value={f.percent} onChange={(e) => setF((p) => ({ ...p, percent: e.target.value }))} className={inputCls} />
      </Field>
      <Field id="disc-from" label="Effective from">
        <input id="disc-from" type="date" value={f.effectiveFrom} onChange={(e) => setF((p) => ({ ...p, effectiveFrom: e.target.value }))} className={inputCls} />
      </Field>
      <Field id="disc-note" label="Note (optional)">
        <input id="disc-note" value={f.note} onChange={(e) => setF((p) => ({ ...p, note: e.target.value }))} className={inputCls} />
      </Field>
      <FormError message={err} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{busy ? 'Saving…' : 'Save rate'}</Button>
      </div>
    </form>
  );
}

function AlertsForm({ settings, canManage, onSaved }: { settings: FundSettings; canManage: boolean; onSaved: () => void }) {
  const [threshold, setThreshold] = useState(settings.thresholdPaise == null ? '' : String(settings.thresholdPaise / 100));
  const [recipients, setRecipients] = useState(settings.alertRecipients.join('\n'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    let thresholdRupees: number | null = null;
    if (threshold.trim()) {
      thresholdRupees = parseRupees(threshold);
      if (thresholdRupees == null || thresholdRupees < 0) return setErr('Enter the threshold in rupees (or leave it blank for no alert).');
    }
    const list = recipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((s) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (bad.length) return setErr(`Not a valid email: ${bad.join(', ')}`);
    setErr(null);
    setOk(false);
    setBusy(true);
    const r = await fundApi.post('settings/alerts', { thresholdRupees, alertRecipients: list }, 'PUT');
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    setOk(true);
    onSaved();
  }

  return (
    <form onSubmit={save} className="space-y-3" noValidate>
      <Field id="al-threshold" label="Low-balance threshold (₹)" hint="When the balance falls below this, a red banner shows and an email goes out once a day. Blank = no alert.">
        <input id="al-threshold" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} className={inputCls} disabled={!canManage} />
      </Field>
      <Field id="al-recipients" label="Alert recipients (emails, one per line or comma separated)">
        <textarea id="al-recipients" rows={3} value={recipients} onChange={(e) => setRecipients(e.target.value)} className={inputCls} disabled={!canManage} />
      </Field>
      {settings.lastAlertSentOn && <p className="text-xs text-gray-500">Last alert email sent on {formatISTDate(settings.lastAlertSentOn)}.</p>}
      {settings.lastAlertError && <p role="alert" className="text-xs font-semibold text-red-700">The last alert email FAILED: {settings.lastAlertError}</p>}
      <FormError message={err} />
      {ok && <p role="status" className="text-sm text-green-700">Alert settings saved.</p>}
      {canManage && <Button type="submit" variant="primary" loading={busy}>{busy ? 'Saving…' : 'Save alert settings'}</Button>}
    </form>
  );
}

export function FundRatesTab({ canManage, refreshKey, onChanged }: { canManage: boolean; refreshKey: number; onChanged: () => void }) {
  const [settings, setSettings] = useState<FundSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feeOpen, setFeeOpen] = useState(false);
  const [brandOpen, setBrandOpen] = useState<{ brandKey: string; brandLabel: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fundApi.settings();
    if (r.ok) setSettings(r.data);
    else { setSettings(null); setError(r.message); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const manage = canManage && !!settings?.canManage;

  function changed() {
    setFeeOpen(false);
    setBrandOpen(null);
    onChanged();
  }

  if (error) return <ErrorBlock message={error} onRetry={() => void load()} />;
  if (loading && !settings) return <LoadingBlock label="Loading rates…" />;
  if (!settings) return null;

  return (
    <div className="space-y-5">
      {!manage && <p className="text-xs text-gray-500">Rates and alerts are set by Gifsy. This view is read-only.</p>}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Agency fee on payouts</CardTitle>
          {manage && <Button type="button" size="sm" variant="primary" onClick={() => setFeeOpen(true)}>Set agency fee</Button>}
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm" data-testid="fund-current-fee">
            {settings.currentFee
              ? <>Current: <strong>{feeLabel(settings.currentFee)}</strong> (from {formatISTDate(settings.currentFee.effectiveFrom)})</>
              : <span className="font-medium text-amber-800">No agency fee set — payouts are charged at face value with no fee.</span>}
          </p>
          {settings.feeRates.length > 0 && (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-500"><th className="pb-1 font-medium">Fee</th><th className="pb-1 font-medium">Effective from</th><th className="pb-1 font-medium">Note</th><th className="pb-1 font-medium">Set by</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {settings.feeRates.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5">{feeLabel(r)}</td>
                    <td className="py-1.5">{formatISTDate(r.effectiveFrom)}</td>
                    <td className="py-1.5 text-gray-600">{r.note ?? '—'}</td>
                    <td className="py-1.5 text-xs text-gray-500">{r.createdByName ?? 'Unknown'} · {formatISTDate(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Voucher discount by brand</CardTitle></CardHeader>
        <CardContent className="space-y-4 overflow-x-auto">
          {settings.brands.length === 0 ? (
            <EmptyBlock>No voucher brands found for this client yet.</EmptyBlock>
          ) : (
            <table className="w-full min-w-[560px] text-sm">
              <thead><tr className="text-left text-xs text-gray-500"><th className="pb-1 font-medium">Brand</th><th className="pb-1 font-medium">Current discount</th><th className="pb-1 font-medium">Since</th>{manage && <th className="pb-1" />}</tr></thead>
              <tbody className="divide-y divide-gray-100">
                {settings.brands.map((b) => (
                  <tr key={b.brandKey} data-testid="fund-brand-row">
                    <td className="py-1.5">
                      {b.brandLabel}
                      {b.items.length > 0 && <span className="block text-xs text-gray-500">{b.items.slice(0, 3).join(', ')}{b.items.length > 3 ? ` +${b.items.length - 3} more` : ''}</span>}
                    </td>
                    <td className="py-1.5">
                      {b.currentRateBps == null
                        ? <span className="font-medium text-amber-800">Not set — charged at face</span>
                        : bpsToPercentLabel(b.currentRateBps)}
                    </td>
                    <td className="py-1.5">{b.currentEffectiveFrom ? formatISTDate(b.currentEffectiveFrom) : '—'}</td>
                    {manage && (
                      <td className="py-1.5 text-right">
                        <Button type="button" size="sm" variant="outline" aria-label={`Set rate for ${b.brandLabel}`}
                          onClick={() => setBrandOpen({ brandKey: b.brandKey, brandLabel: b.brandLabel })}>
                          Set rate
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {settings.discountRates.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-medium text-gray-600">Discount history ({settings.discountRates.length})</summary>
              <table className="mt-2 w-full text-sm">
                <thead><tr className="text-left text-xs text-gray-500"><th className="pb-1 font-medium">Brand</th><th className="pb-1 font-medium">Discount</th><th className="pb-1 font-medium">Effective from</th><th className="pb-1 font-medium">Note</th><th className="pb-1 font-medium">Set by</th></tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {settings.discountRates.map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5">{r.brandLabel}</td>
                      <td className="py-1.5">{bpsToPercentLabel(r.rateBps)}</td>
                      <td className="py-1.5">{formatISTDate(r.effectiveFrom)}</td>
                      <td className="py-1.5 text-gray-600">{r.note ?? '—'}</td>
                      <td className="py-1.5 text-xs text-gray-500">{r.createdByName ?? 'Unknown'} · {formatISTDate(r.createdAt)}</td>
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
        <CardContent>
          <AlertsForm settings={settings} canManage={manage} onSaved={onChanged} />
        </CardContent>
      </Card>

      <Modal open={feeOpen} onOpenChange={setFeeOpen} title="Set the agency fee">
        <FeeForm onDone={changed} onCancel={() => setFeeOpen(false)} />
      </Modal>
      <Modal open={!!brandOpen} onOpenChange={(o) => !o && setBrandOpen(null)} title={brandOpen ? `Set discount — ${brandOpen.brandLabel}` : 'Set discount'}>
        {brandOpen && <DiscountForm brand={brandOpen} onDone={changed} onCancel={() => setBrandOpen(null)} />}
      </Modal>
    </div>
  );
}
