/// <reference types="vitest/globals" />
/**
 * Gifsy console → client page → Fund section (owner D6) — FundConsoleSection.
 *  FC1: lists voucher items (badges, current %, scheduled) + current / scheduled fee (C3)
 *  FC2: back-dated fee → preview text → Confirm re-posts the SAME body + confirmToken (D1)
 *  FC3: 409 on confirm → the message is shown and a fresh preview is fetched
 *  FC4: future-dated item discount → saved at once, "Scheduled from …" success message (C3)
 *  FC5: canManage=false → read-only (no save controls); 403 load → clear access message
 *  FC6: alerts — Monday–Saturday copy, test environment shown loudly, PUT body
 * Run: npx vitest run src/components/operator/__tests__/fund-console-section.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { FundConsoleSection } from '../fund-console-section';

function settings(over: Record<string, unknown> = {}) {
  return {
    clientId: 'bajaj', canManage: true, managedInConsole: true, consoleHref: '/gifsy/clients/bajaj#fund',
    thresholdPaise: null, alertRecipients: [], lastAlertSentOn: '2026-11-20', lastAlertRecipients: 2, lastAlertError: null,
    alertEnvironment: 'live',
    currentFee: { feeType: 'PERCENT', rateBps: 300, flatPaise: null, effectiveFrom: '2026-11-01T00:00:00.000Z' },
    scheduledFee: null,
    feeRates: [
      { id: 'f1', feeType: 'PERCENT', rewardId: null, rewardLabel: null, rateBps: 300, flatPaise: null, effectiveFrom: '2026-11-01T00:00:00.000Z', note: null, repricedLines: 4, repriceDeltaPaise: -12_000, createdAt: '2026-11-02T00:00:00.000Z', createdByName: 'Ops' },
    ],
    discountRates: [],
    items: [
      { rewardId: 'rw1', name: 'Amazon Pay ₹500', code: 'AMZ500', brandText: 'Amazon', deleted: false, active: true, currentRateBps: 250, currentEffectiveFrom: '2026-11-01T00:00:00.000Z', scheduledRateBps: 300, scheduledFrom: '2026-12-01T00:00:00.000Z' },
      { rewardId: 'rw2', name: 'Old Flipkart', code: 'FK', brandText: null, deleted: true, active: false, currentRateBps: null, currentEffectiveFrom: null, scheduledRateBps: null, scheduledFrom: null },
      { rewardId: 'rw3', name: 'Swiggy ₹200', code: 'SW200', brandText: 'Swiggy', deleted: false, active: false, currentRateBps: null, currentEffectiveFrom: null, scheduledRateBps: null, scheduledFrom: null },
    ],
    ...over,
  };
}

type Reply = { status?: number; body: unknown };
function stub(handler: (url: string, init?: RequestInit) => Reply | undefined, s = settings()) {
  const fn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const r = handler(u, init) ?? (u.endsWith('/api/gifsy/clients/bajaj/fund') && !init?.method ? { body: { success: true, data: s } } : { body: { success: true, data: {} } });
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: () => Promise.resolve(r.body) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const writes = (fn: ReturnType<typeof vi.fn>, path: string) =>
  fn.mock.calls.filter((c) => String(c[0]).endsWith(path) && ['POST', 'PUT'].includes(String((c[1] as RequestInit | undefined)?.method)));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

afterEach(() => { vi.unstubAllGlobals(); });

const PREVIEW = { saved: false, requiresConfirmation: true, preview: { linesRepriced: 7, deltaPaise: -45_000, effectiveFrom: '2026-11-01T00:00:00.000Z', from: '2026-11-03T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z' }, confirmToken: 'tok-1' };

describe('FundConsoleSection', () => {
  it('FC1: lists the voucher items with badges, current and scheduled discount; the fee history shows a back-dated re-pricing', async () => {
    stub(() => undefined);
    render(<FundConsoleSection slug="bajaj" />);
    const rows = await screen.findAllByTestId('fund-console-item-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Amazon Pay ₹500');
    expect(rows[0]).toHaveTextContent('AMZ500 · Amazon');
    expect(rows[0]).toHaveTextContent('2.5%');
    expect(rows[0]).toHaveTextContent('Scheduled from 01 Dec 2026: 3%');
    expect(rows[1]).toHaveTextContent('Deleted');
    expect(rows[2]).toHaveTextContent('Inactive');
    expect(rows[2]).toHaveTextContent('Not set — face value');
    expect(screen.getByTestId('fund-console-current-fee')).toHaveTextContent('3% of each payout');
    expect(screen.getByTestId('fund-console-fee')).toHaveTextContent('re-priced 4 lines, balance -₹120.00');
  });

  it('FC2 (D1): a back-dated fee shows the preview; Confirm re-posts the same body + confirmToken', async () => {
    let n = 0;
    const fn = stub((u, init) => {
      if (u.endsWith('/fund/rates/fee') && init?.method === 'POST') {
        n += 1;
        return n === 1 ? { body: { success: true, data: PREVIEW } }
          : { body: { success: true, data: { saved: true, id: 'f2', scheduled: false, effectiveFrom: '2026-11-01T00:00:00.000Z', linesRepriced: 7, deltaPaise: -45_000 } } };
      }
      return undefined;
    });
    render(<FundConsoleSection slug="bajaj" />);
    fireEvent.change(await screen.findByLabelText('Percent (%)'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Agreed rate' } });
    expect(screen.getByLabelText('Note (optional)')).toHaveAttribute('maxLength', '300');
    fireEvent.click(screen.getByTestId('fund-console-fee-save'));
    const preview = await screen.findByTestId('fund-rate-preview');
    expect(preview).toHaveTextContent('This re-prices 7 lines committed from 03 Nov 2026; the balance changes by -₹450.00. Confirm?');
    expect(writes(fn, '/fund/rates/fee')).toHaveLength(1);
    const first = bodyOf(writes(fn, '/fund/rates/fee')[0]);
    expect(first).toEqual({ feeType: 'PERCENT', percent: 4, effectiveFrom: '2026-11-01', note: 'Agreed rate' });
    fireEvent.click(within(preview).getByTestId('fund-rate-confirm'));
    await waitFor(() => expect(writes(fn, '/fund/rates/fee')).toHaveLength(2));
    expect(bodyOf(writes(fn, '/fund/rates/fee')[1])).toEqual({ ...first, confirmToken: 'tok-1' });
    expect(await screen.findByTestId('fund-console-saved')).toHaveTextContent('7 lines re-priced, balance -₹450.00');
  });

  it('FC2b (round 6): when spend arrived after the preview, the saved message says so plainly', async () => {
    let n = 0;
    stub((u, init) => {
      if (u.endsWith('/fund/rates/fee') && init?.method === 'POST') {
        n += 1;
        return n === 1 ? { body: { success: true, data: PREVIEW } }
          : { body: { success: true, data: { saved: true, id: 'f2', scheduled: false, effectiveFrom: '2026-11-01T00:00:00.000Z', linesRepriced: 8, deltaPaise: -48_000, previewLinesRepriced: 7, previewDeltaPaise: -45_000, includesSpendAfterPreview: true } } };
      }
      return undefined;
    });
    render(<FundConsoleSection slug="bajaj" />);
    fireEvent.change(await screen.findByLabelText('Percent (%)'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByTestId('fund-console-fee-save'));
    const preview = await screen.findByTestId('fund-rate-preview');
    fireEvent.click(within(preview).getByTestId('fund-rate-confirm'));
    expect(await screen.findByTestId('fund-console-saved')).toHaveTextContent('Saved — 8 lines / -₹480.00 re-priced (includes spend made after the preview).');
  });

  it('FC3: a 409 on confirm shows the message and fetches a fresh preview (no token)', async () => {
    let n = 0;
    const fn = stub((u, init) => {
      if (u.endsWith('/fund/rates/fee') && init?.method === 'POST') {
        n += 1;
        if (n === 1) return { body: { success: true, data: PREVIEW } };
        if (n === 2) return { status: 409, body: { success: false, error: 'The figures changed since the preview (new spend or another rate change). Review the new preview and confirm again.' } };
        return { body: { success: true, data: { ...PREVIEW, preview: { ...PREVIEW.preview, linesRepriced: 8 }, confirmToken: 'tok-2' } } };
      }
      return undefined;
    });
    render(<FundConsoleSection slug="bajaj" />);
    fireEvent.change(await screen.findByLabelText('Percent (%)'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByTestId('fund-console-fee-save'));
    fireEvent.click(await screen.findByTestId('fund-rate-confirm'));
    expect(await screen.findByTestId('fund-rate-preview-notice')).toHaveTextContent('The figures changed since the preview');
    expect(screen.getByTestId('fund-rate-preview')).toHaveTextContent('This re-prices 8 lines');
    const calls = writes(fn, '/fund/rates/fee');
    expect(calls).toHaveLength(3);
    expect(bodyOf(calls[2]).confirmToken).toBeUndefined();
    fireEvent.click(screen.getByTestId('fund-rate-confirm'));
    await waitFor(() => expect(writes(fn, '/fund/rates/fee')).toHaveLength(4));
    expect(bodyOf(writes(fn, '/fund/rates/fee')[3]).confirmToken).toBe('tok-2');
  });

  it('FC4 (C3): a future-dated item discount saves at once and says "Scheduled from"', async () => {
    const fn = stub((u, init) => (u.endsWith('/fund/rates/discount') && init?.method === 'POST'
      ? { body: { success: true, data: { saved: true, id: 'd9', scheduled: true, effectiveFrom: '2027-01-01T00:00:00.000Z' } } } : undefined));
    render(<FundConsoleSection slug="bajaj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set discount for Swiggy ₹200' }));
    const form = await screen.findByTestId('fund-console-item-form');
    fireEvent.change(within(form).getByLabelText('Discount for Swiggy ₹200 (%)'), { target: { value: '2.5' } });
    fireEvent.change(within(form).getByLabelText('Effective from'), { target: { value: '2027-01-01' } });
    fireEvent.click(within(form).getByTestId('fund-console-item-save'));
    expect(await screen.findByTestId('fund-console-saved')).toHaveTextContent('Swiggy ₹200: Saved. Scheduled from 01 Jan 2027');
    expect(bodyOf(writes(fn, '/fund/rates/discount')[0])).toEqual({ rewardId: 'rw3', percent: 2.5, effectiveFrom: '2027-01-01' });
    expect(screen.queryByTestId('fund-rate-preview')).not.toBeInTheDocument();
  });

  it('FC4b: an invalid % is not posted and the field is marked invalid', async () => {
    const fn = stub(() => undefined);
    render(<FundConsoleSection slug="bajaj" />);
    fireEvent.change(await screen.findByLabelText('Percent (%)'), { target: { value: '150' } });
    fireEvent.click(screen.getByTestId('fund-console-fee-save'));
    expect(await screen.findByText(/between 0 and 100/)).toBeInTheDocument();
    expect(screen.getByLabelText('Percent (%)')).toHaveAttribute('aria-invalid', 'true');
    expect(writes(fn, '/fund/rates/fee')).toHaveLength(0);
  });

  it('FC5: canManage=false is read-only; a 403 load shows a clear access message', async () => {
    stub(() => undefined, settings({ canManage: false }));
    const { unmount } = render(<FundConsoleSection slug="bajaj" />);
    await screen.findAllByTestId('fund-console-item-row');
    expect(screen.queryByTestId('fund-console-fee-save')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set discount for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save alert settings' })).not.toBeInTheDocument();
    expect(screen.getByText(/needs the "manage fund" permission/)).toBeInTheDocument();
    unmount();

    stub((u) => (u.endsWith('/api/gifsy/clients/bajaj/fund') ? { status: 403, body: { message: 'You do not have access to this client.' } } : undefined));
    render(<FundConsoleSection slug="bajaj" />);
    expect(await screen.findByTestId('fund-console-load-error')).toHaveTextContent("You don't have access to this client's fund settings: You do not have access to this client.");
  });

  it('FC6: alerts — Monday–Saturday copy, test environment loud, PUT the threshold + recipients', async () => {
    const fn = stub((u, init) => (u.endsWith('/fund/alerts') && init?.method === 'PUT'
      ? { body: { success: true, data: { thresholdPaise: 5_000_000, alertRecipients: ['a@x.in'] } } } : undefined), settings({ alertEnvironment: 'test' }));
    render(<FundConsoleSection slug="bajaj" />);
    const block = await screen.findByTestId('fund-console-alerts');
    expect(block).toHaveTextContent('e-mails go Monday to Saturday, once an opening balance is recorded');
    expect(screen.getByTestId('fund-console-alert-env')).toHaveTextContent(/TEST ENVIRONMENT/);
    expect(screen.getByTestId('fund-console-last-alert')).toHaveTextContent('to 2 recipients');
    fireEvent.change(screen.getByLabelText('Low-balance threshold (₹, blank = no alert)'), { target: { value: '50000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save alert settings' }));
    expect(await screen.findByTestId('fund-console-alerts-error')).toHaveTextContent('Add at least one recipient');
    fireEvent.change(screen.getByLabelText('Recipients (e-mails, one per line or comma separated)'), { target: { value: 'a@x.in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save alert settings' }));
    await waitFor(() => expect(writes(fn, '/fund/alerts')).toHaveLength(1));
    expect(bodyOf(writes(fn, '/fund/alerts')[0])).toEqual({ thresholdRupees: 50000, alertRecipients: ['a@x.in'] });
    expect(await screen.findByTestId('fund-console-saved')).toHaveTextContent('Low-balance alert saved.');
  });
});
