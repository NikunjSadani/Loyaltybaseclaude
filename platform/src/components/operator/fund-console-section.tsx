'use client';

/* ─── Gifsy console → client page → "Fund" section (owner D6, 2026-11-23) ─────────────────────────────
   The client's fund settings, managed by Gifsy here (the /admin/fund "Rates & alerts" tab is read-only):
     · agency fee on payouts + history
     · voucher discount per VOUCHER ITEM (catalogue reward, owner D4) + history
     · low-balance threshold + recipients
   API: GET /api/gifsy/clients/:slug/fund · PUT …/fund/alerts · POST …/fund/rates/fee · POST …/fund/rates/discount.
   A BACK-DATED rate (effective today or earlier) answers with a preview; it is saved only after an explicit confirm
   that re-sends the same body + confirmToken (owner D1). 409 = the figures moved → message + a fresh preview.
   Writes show only when the API says canManage (payouts:manage_fund; staff also need a grant — server-enforced).
──────────────────────────────────────────────────────────────────────────────────────────────────────── */

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Loader2, Save } from 'lucide-react';
import { formatISTDate } from '@/lib/ist-date';
import { formatInrPaise } from '@/lib/money-format';
import {
  bpsToPercentLabel, feeLabelOf, fundConsoleApi, parseRupees, todayIstKey,
  type FundRateRow, type FundRateSaveResult, type FundSettings, type FundVoucherItem,
} from '@/lib/fund';

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30 disabled:opacity-50';
const BTN_PRIMARY =
  'flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50';
const BTN_GHOST =
  'flex items-center gap-1.5 px-3 py-2 bg-white/5 border border-white/10 text-white/70 text-xs font-medium rounded-lg hover:text-white transition-colors disabled:opacity-50';
const RATE_NOTE_MAX = 300;

const feeLabel = (f: Parameters<typeof feeLabelOf>[0]) => feeLabelOf(f, formatInrPaise);
const signedRs = (paise: number) => (paise > 0 ? `+${formatInrPaise(paise)}` : formatInrPaise(paise));

/** 0–100 with at most 2 decimals. */
export function parsePercent(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : null;
}

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-xs text-white/50 mb-1.5">{children}</label>;
}

function ErrorText({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <p role="alert" data-testid={testId} className="text-xs text-red-400">{children}</p>;
}

// ── Rate save with the back-dated preview → confirm step (owner D1) ───────────────────────────────

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'preview'; body: Record<string, unknown>; preview: Extract<FundRateSaveResult, { saved: false }>['preview']; token: string; notice?: string }
  | { kind: 'error'; message: string };

function useRateSave(save: (body: Record<string, unknown>) => ReturnType<ReturnType<typeof fundConsoleApi>['saveFee']>, onSaved: (msg: string) => void) {
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  const run = useCallback(async (body: Record<string, unknown>, notice?: string) => {
    setState({ kind: 'saving' });
    const r = await save(body);
    if (!r.ok) {
      // 409 on a confirm: the figures moved since the preview → say so, then fetch a fresh preview.
      if (r.status === 409 && body.confirmToken) {
        const { confirmToken: _drop, ...rest } = body;
        void _drop;
        return run(rest, r.message);
      }
      setState({ kind: 'error', message: r.message });
      return;
    }
    const d = r.data;
    if (d.saved === false && d.requiresConfirmation) {
      setState({ kind: 'preview', body, preview: d.preview, token: d.confirmToken, notice });
      return;
    }
    if (d.saved) {
      setState({ kind: 'idle' });
      onSaved(
        d.scheduled
          ? `Saved. Scheduled from ${formatISTDate(d.effectiveFrom)} — nothing already committed changes.`
          : `Saved, in force from ${formatISTDate(d.effectiveFrom)}${d.linesRepriced != null ? ` — ${d.linesRepriced} line${d.linesRepriced === 1 ? '' : 's'} re-priced, balance ${signedRs(d.deltaPaise ?? 0)}` : ''}.`,
      );
    }
  }, [save, onSaved]);

  const confirm = useCallback(() => {
    if (state.kind !== 'preview') return;
    void run({ ...state.body, confirmToken: state.token });
  }, [state, run]);

  const cancel = useCallback(() => setState({ kind: 'idle' }), []);
  return { state, run, confirm, cancel, busy: state.kind === 'saving' };
}

function PreviewBox({ state, onConfirm, onCancel, busy }: {
  state: Extract<SaveState, { kind: 'preview' }>; onConfirm: () => void; onCancel: () => void; busy: boolean;
}) {
  const p = state.preview;
  return (
    <div role="alertdialog" aria-label="Confirm back-dated rate" data-testid="fund-rate-preview"
      className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      {state.notice && <p data-testid="fund-rate-preview-notice" className="font-semibold text-red-300">{state.notice}</p>}
      <p className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
        <span>
          This rate is back-dated to {formatISTDate(p.effectiveFrom)}. This re-prices {p.linesRepriced} line{p.linesRepriced === 1 ? '' : 's'} committed
          from {formatISTDate(p.from)}; the balance changes by {signedRs(p.deltaPaise)}. Confirm?
        </span>
      </p>
      <div className="flex gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={onConfirm} disabled={busy} data-testid="fund-rate-confirm">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}Confirm and save
        </button>
        <button type="button" className={BTN_GHOST} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

function RepricedNote({ r }: { r: Pick<FundRateRow, 'repricedLines' | 'repriceDeltaPaise'> }) {
  if (r.repricedLines == null) return null;
  return (
    <span className="block text-[11px] text-white/40">
      Back-dated: re-priced {r.repricedLines} line{r.repricedLines === 1 ? '' : 's'}, balance {signedRs(r.repriceDeltaPaise ?? 0)}
    </span>
  );
}

// ── Agency fee ────────────────────────────────────────────────────────────────────────────────────

function FeeBlock({ slug, settings, onChanged }: { slug: string; settings: FundSettings; onChanged: (msg: string) => void }) {
  const api = fundConsoleApi(slug);
  const [f, setF] = useState({ feeType: 'PERCENT' as 'PERCENT' | 'FLAT', value: '', effectiveFrom: todayIstKey(), note: '' });
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const { state, run, confirm, cancel, busy } = useRateSave(api.saveFee, onChanged);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    let body: Record<string, unknown>;
    if (f.feeType === 'PERCENT') {
      const percent = parsePercent(f.value);
      if (percent == null) { setFieldErr('Enter a percent between 0 and 100 (up to 2 decimals).'); document.getElementById('fc-fee-value')?.focus(); return; }
      body = { feeType: 'PERCENT', percent };
    } else {
      const flatRupees = parseRupees(f.value);
      if (flatRupees == null || flatRupees < 0) { setFieldErr('Enter the flat fee per payout in rupees (up to 2 decimals).'); document.getElementById('fc-fee-value')?.focus(); return; }
      body = { feeType: 'FLAT', flatRupees };
    }
    if (!f.effectiveFrom) { setFieldErr('Enter the date the fee applies from.'); document.getElementById('fc-fee-from')?.focus(); return; }
    setFieldErr(null);
    void run({ ...body, effectiveFrom: f.effectiveFrom, ...(f.note.trim() ? { note: f.note.trim() } : {}) });
  }

  return (
    <div className="space-y-3" data-testid="fund-console-fee">
      <h3 className="text-sm font-semibold text-white">Agency fee on payouts</h3>
      <p className="text-xs text-white/70" data-testid="fund-console-current-fee">
        {settings.currentFee
          ? <>Current: <strong className="text-white">{feeLabel(settings.currentFee)}</strong> (from {formatISTDate(settings.currentFee.effectiveFrom)})</>
          : <span className="text-amber-300">No agency fee set — payouts are charged at face value with no fee.</span>}
      </p>
      {settings.scheduledFee && (
        <p className="text-xs text-sky-300" data-testid="fund-console-scheduled-fee">
          Scheduled from {formatISTDate(settings.scheduledFee.effectiveFrom)}: <strong>{feeLabel(settings.scheduledFee)}</strong>
        </p>
      )}
      {settings.canManage && (
        <form onSubmit={submit} noValidate className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <Label htmlFor="fc-fee-type">Fee type</Label>
            <select id="fc-fee-type" value={f.feeType} disabled={busy} className={INPUT_CLS}
              onChange={(e) => setF((p) => ({ ...p, feeType: e.target.value as 'PERCENT' | 'FLAT' }))}>
              <option value="PERCENT">% of each payout</option>
              <option value="FLAT">Flat ₹ per payout</option>
            </select>
          </div>
          <div>
            <Label htmlFor="fc-fee-value">{f.feeType === 'PERCENT' ? 'Percent (%)' : 'Flat fee per payout (₹)'}</Label>
            <input id="fc-fee-value" inputMode="decimal" value={f.value} disabled={busy} className={INPUT_CLS}
              aria-invalid={fieldErr ? true : undefined} aria-describedby={fieldErr ? 'fc-fee-error' : undefined}
              onChange={(e) => setF((p) => ({ ...p, value: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="fc-fee-from">Effective from</Label>
            <input id="fc-fee-from" type="date" value={f.effectiveFrom} disabled={busy} className={INPUT_CLS}
              onChange={(e) => setF((p) => ({ ...p, effectiveFrom: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="fc-fee-note">Note (optional)</Label>
            <input id="fc-fee-note" value={f.note} maxLength={RATE_NOTE_MAX} disabled={busy} className={INPUT_CLS}
              onChange={(e) => setF((p) => ({ ...p, note: e.target.value }))} />
          </div>
          <div className="col-span-2 md:col-span-4 space-y-2">
            <p className="text-[11px] text-white/40">
              A future date schedules the fee (nothing already committed changes). Today or an earlier date re-prices the
              payouts committed from that date — you will see how many and the balance change before anything is saved.
            </p>
            {fieldErr && <p id="fc-fee-error"><ErrorText>{fieldErr}</ErrorText></p>}
            {state.kind === 'error' && <ErrorText testId="fund-console-fee-error">{state.message}</ErrorText>}
            {state.kind === 'preview'
              ? <PreviewBox state={state} onConfirm={confirm} onCancel={cancel} busy={busy} />
              : (
                <button type="submit" className={BTN_PRIMARY} disabled={busy} data-testid="fund-console-fee-save">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save agency fee
                </button>
              )}
          </div>
        </form>
      )}
      {settings.feeRates.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-white/50">Fee history ({settings.feeRates.length})</summary>
          <table className="mt-2 w-full text-xs text-white/80">
            <thead><tr className="text-left text-white/40"><th className="pb-1 font-medium">Fee</th><th className="pb-1 font-medium">Effective from</th><th className="pb-1 font-medium">Note</th><th className="pb-1 font-medium">Set by</th></tr></thead>
            <tbody className="divide-y divide-white/5">
              {settings.feeRates.map((r) => (
                <tr key={r.id}>
                  <td className="py-1.5">{feeLabel(r)}<RepricedNote r={r} /></td>
                  <td className="py-1.5">{formatISTDate(r.effectiveFrom)}</td>
                  <td className="py-1.5 text-white/50">{r.note ?? '—'}</td>
                  <td className="py-1.5 text-white/40">{r.createdByName ?? 'Unknown'} · {formatISTDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// ── Voucher item discounts (owner D4) ─────────────────────────────────────────────────────────────

function ItemDiscountForm({ slug, item, onChanged, onClose }: {
  slug: string; item: FundVoucherItem; onChanged: (msg: string) => void; onClose: () => void;
}) {
  const api = fundConsoleApi(slug);
  const [f, setF] = useState({ percent: '', effectiveFrom: todayIstKey(), note: '' });
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const done = useCallback((msg: string) => { onChanged(`${item.name}: ${msg}`); onClose(); }, [item.name, onChanged, onClose]);
  const { state, run, confirm, cancel, busy } = useRateSave(api.saveDiscount, done);
  const pid = `fc-disc-${item.rewardId}`;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const percent = parsePercent(f.percent);
    if (percent == null) { setFieldErr('Enter a discount between 0 and 100 (up to 2 decimals).'); document.getElementById(`${pid}-percent`)?.focus(); return; }
    if (!f.effectiveFrom) { setFieldErr('Enter the date the discount applies from.'); document.getElementById(`${pid}-from`)?.focus(); return; }
    setFieldErr(null);
    void run({ rewardId: item.rewardId, percent, effectiveFrom: f.effectiveFrom, ...(f.note.trim() ? { note: f.note.trim() } : {}) });
  }

  return (
    <form onSubmit={submit} noValidate data-testid="fund-console-item-form" className="grid grid-cols-2 gap-3 rounded-lg border border-white/10 bg-white/5 p-3 md:grid-cols-4">
      <div>
        <Label htmlFor={`${pid}-percent`}>Discount for {item.name} (%)</Label>
        <input id={`${pid}-percent`} inputMode="decimal" value={f.percent} disabled={busy} className={INPUT_CLS}
          aria-invalid={fieldErr ? true : undefined} aria-describedby={fieldErr ? `${pid}-error` : undefined}
          onChange={(e) => setF((p) => ({ ...p, percent: e.target.value }))} />
      </div>
      <div>
        <Label htmlFor={`${pid}-from`}>Effective from</Label>
        <input id={`${pid}-from`} type="date" value={f.effectiveFrom} disabled={busy} className={INPUT_CLS}
          onChange={(e) => setF((p) => ({ ...p, effectiveFrom: e.target.value }))} />
      </div>
      <div className="col-span-2">
        <Label htmlFor={`${pid}-note`}>Note (optional)</Label>
        <input id={`${pid}-note`} value={f.note} maxLength={RATE_NOTE_MAX} disabled={busy} className={INPUT_CLS}
          onChange={(e) => setF((p) => ({ ...p, note: e.target.value }))} />
      </div>
      <div className="col-span-2 md:col-span-4 space-y-2">
        {fieldErr && <p id={`${pid}-error`}><ErrorText>{fieldErr}</ErrorText></p>}
        {state.kind === 'error' && <ErrorText testId="fund-console-item-error">{state.message}</ErrorText>}
        {state.kind === 'preview'
          ? <PreviewBox state={state} onConfirm={confirm} onCancel={cancel} busy={busy} />
          : (
            <div className="flex gap-2">
              <button type="submit" className={BTN_PRIMARY} disabled={busy} data-testid="fund-console-item-save">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save discount
              </button>
              <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>Close</button>
            </div>
          )}
      </div>
    </form>
  );
}

function ItemsBlock({ slug, settings, onChanged }: { slug: string; settings: FundSettings; onChanged: (msg: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const items = settings.items ?? [];
  const close = useCallback(() => setOpenId(null), []);
  return (
    <div className="space-y-3" data-testid="fund-console-items">
      <h3 className="text-sm font-semibold text-white">Voucher discount by item</h3>
      <p className="text-[11px] text-white/40">
        Each voucher item is charged at face value less its discount. An item with no discount is charged at face value.
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-white/40">No voucher items in this client&apos;s catalogue yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs text-white/80">
            <thead><tr className="text-left text-white/40"><th className="pb-1 font-medium">Voucher item</th><th className="pb-1 font-medium">Current</th><th className="pb-1 font-medium">Since</th><th className="pb-1 font-medium">Scheduled</th>{settings.canManage && <th className="pb-1" />}</tr></thead>
            <tbody className="divide-y divide-white/5">
              {items.map((it) => (
                <React.Fragment key={it.rewardId}>
                  <tr data-testid="fund-console-item-row">
                    <td className="py-1.5">
                      <span className="text-white">{it.name}</span>
                      {it.deleted ? <span className="ml-1.5 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-300">Deleted</span>
                        : !it.active ? <span className="ml-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/50">Inactive</span> : null}
                      <span className="block text-[11px] text-white/40">{[it.code, it.brandText].filter(Boolean).join(' · ') || '—'}</span>
                    </td>
                    <td className="py-1.5">{it.currentRateBps == null ? <span className="text-amber-300">Not set — face value</span> : bpsToPercentLabel(it.currentRateBps)}</td>
                    <td className="py-1.5">{it.currentEffectiveFrom ? formatISTDate(it.currentEffectiveFrom) : '—'}</td>
                    <td className="py-1.5 text-sky-300">{it.scheduledFrom ? `Scheduled from ${formatISTDate(it.scheduledFrom)}: ${bpsToPercentLabel(it.scheduledRateBps)}` : '—'}</td>
                    {settings.canManage && (
                      <td className="py-1.5 text-right">
                        <button type="button" className={BTN_GHOST} aria-label={`Set discount for ${it.name}`}
                          onClick={() => setOpenId((o) => (o === it.rewardId ? null : it.rewardId))}>Set %</button>
                      </td>
                    )}
                  </tr>
                  {openId === it.rewardId && (
                    <tr><td colSpan={5} className="py-2"><ItemDiscountForm slug={slug} item={it} onChanged={onChanged} onClose={close} /></td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {settings.discountRates.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-white/50">Discount history ({settings.discountRates.length})</summary>
          <table className="mt-2 w-full text-xs text-white/80">
            <thead><tr className="text-left text-white/40"><th className="pb-1 font-medium">Voucher item</th><th className="pb-1 font-medium">Discount</th><th className="pb-1 font-medium">Effective from</th><th className="pb-1 font-medium">Note</th><th className="pb-1 font-medium">Set by</th></tr></thead>
            <tbody className="divide-y divide-white/5">
              {settings.discountRates.map((r) => (
                <tr key={r.id}>
                  <td className="py-1.5">{r.rewardLabel ?? r.rewardId ?? '—'}</td>
                  <td className="py-1.5">{bpsToPercentLabel(r.rateBps)}<RepricedNote r={r} /></td>
                  <td className="py-1.5">{formatISTDate(r.effectiveFrom)}</td>
                  <td className="py-1.5 text-white/50">{r.note ?? '—'}</td>
                  <td className="py-1.5 text-white/40">{r.createdByName ?? 'Unknown'} · {formatISTDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// ── Low-balance alert ─────────────────────────────────────────────────────────────────────────────

function AlertsBlock({ slug, settings, onChanged }: { slug: string; settings: FundSettings; onChanged: (msg: string) => void }) {
  const [threshold, setThreshold] = useState(settings.thresholdPaise == null ? '' : String(settings.thresholdPaise / 100));
  const [recipients, setRecipients] = useState(settings.alertRecipients.join('\n'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const env = settings.alertEnvironment;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    let thresholdRupees: number | null = null;
    if (threshold.trim()) {
      thresholdRupees = parseRupees(threshold);
      if (thresholdRupees == null || thresholdRupees < 0) { setErr('Enter the threshold in rupees (or leave it blank for no alert).'); document.getElementById('fc-al-threshold')?.focus(); return; }
    }
    const list = recipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((s) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (bad.length) { setErr(`Not a valid e-mail: ${bad.join(', ')}`); document.getElementById('fc-al-recipients')?.focus(); return; }
    if (thresholdRupees != null && list.length === 0) { setErr('Add at least one recipient for the low-balance threshold (or clear the threshold).'); document.getElementById('fc-al-recipients')?.focus(); return; }
    setErr(null);
    setBusy(true);
    const r = await fundConsoleApi(slug).saveAlerts({ thresholdRupees, alertRecipients: list });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    onChanged('Low-balance alert saved.');
  }

  return (
    <form onSubmit={save} noValidate className="space-y-3" data-testid="fund-console-alerts">
      <h3 className="text-sm font-semibold text-white">Low-balance alert</h3>
      {env && env !== 'live' && (
        <p data-testid="fund-console-alert-env" role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-200">
          {env === 'test'
            ? 'TEST ENVIRONMENT — low-balance e-mails go to ONE test address only, never to the recipients below.'
            : 'LOW-BALANCE E-MAILS ARE OFF in this environment — nothing is sent to anyone.'}
        </p>
      )}
      <p className="text-[11px] text-white/40">
        When the balance is below the threshold, e-mails go Monday to Saturday, once an opening balance is recorded. Spend is never blocked.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="fc-al-threshold">Low-balance threshold (₹, blank = no alert)</Label>
          <input id="fc-al-threshold" inputMode="decimal" value={threshold} disabled={!settings.canManage || busy} className={INPUT_CLS}
            onChange={(e) => setThreshold(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="fc-al-recipients">Recipients (e-mails, one per line or comma separated)</Label>
          <textarea id="fc-al-recipients" rows={3} value={recipients} disabled={!settings.canManage || busy} className={INPUT_CLS}
            onChange={(e) => setRecipients(e.target.value)} />
        </div>
      </div>
      {settings.lastAlertSentOn && (
        <p className="text-xs text-white/50" data-testid="fund-console-last-alert">
          Last e-mail sent on {formatISTDate(settings.lastAlertSentOn)}
          {settings.lastAlertRecipients != null ? ` to ${settings.lastAlertRecipients} recipient${settings.lastAlertRecipients === 1 ? '' : 's'}` : ''}.
        </p>
      )}
      {settings.lastAlertError && <ErrorText>The last alert e-mail FAILED: {settings.lastAlertError}</ErrorText>}
      {err && <ErrorText testId="fund-console-alerts-error">{err}</ErrorText>}
      {settings.canManage && (
        <button type="submit" className={BTN_PRIMARY} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save alert settings
        </button>
      )}
    </form>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────────────────────────

export function FundConsoleSection({ slug }: { slug: string }) {
  const [settings, setSettings] = useState<FundSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fundConsoleApi(slug).get().then((r) => {
      if (cancelled) return;
      if (r.ok) setSettings(r.data);
      else { setSettings(null); setError(r.status === 403 ? `You don't have access to this client's fund settings: ${r.message}` : r.message); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [slug, reloadKey]);

  const changed = useCallback((msg: string) => { setSaved(msg); setReloadKey((k) => k + 1); }, []);

  if (loading && !settings) {
    return <div className="flex items-center gap-2 py-6 text-white/40 text-sm"><Loader2 className="w-4 h-4 animate-spin" />Loading fund settings…</div>;
  }
  if (error || !settings) return <div className="py-4"><ErrorText testId="fund-console-load-error">{error ?? 'Could not load the fund settings.'}</ErrorText></div>;

  return (
    <div className="pt-2 space-y-6" data-testid="fund-console">
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-blue-300">
        The client&apos;s fund settings. The client sees them read-only on its Fund reconciliation page.
        {!settings.canManage && ' You can view these settings; changing them needs the "manage fund" permission.'}
      </div>
      {saved && (
        <p role="status" data-testid="fund-console-saved" className="flex items-center gap-1.5 text-xs text-green-400">
          <CheckCircle className="w-3.5 h-3.5" />{saved}
        </p>
      )}
      {/* key=reloadKey: forms re-initialise from the fresh server values after a save. */}
      <FeeBlock key={`fee-${reloadKey}`} slug={slug} settings={settings} onChanged={changed} />
      <ItemsBlock key={`items-${reloadKey}`} slug={slug} settings={settings} onChanged={changed} />
      <AlertsBlock key={`alerts-${reloadKey}`} slug={slug} settings={settings} onChanged={changed} />
    </div>
  );
}

export default FundConsoleSection;
