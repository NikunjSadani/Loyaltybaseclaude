/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — campaign detail / live delivery report.
 * Tiles + rows (reasons, masked codes, "—" for missing numbers) · resend gated by canResend ·
 * retry refusal verbatim · unknown outcome (5xx / network) locks the action until a refresh lands ·
 * only the latest response is applied · unknown status keeps polling · 30-min post-completion
 * polling window · paused while the tab is hidden · refresh errors are shown.
 * Run: npx vitest run "src/app/gifsy/voucher-dispersal/[id]/__tests__/detail-page.test.tsx"
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'c1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));

import DetailPage from '../page';

const BASE = '/api/admin/voucher-dispersal/campaigns/c1';
const ok = (data: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
const fail = (status: number, error: string) => ({ ok: false, status, json: () => Promise.resolve({ success: false, error }) });

const campaign = (status: string, extra: Record<string, unknown> = {}) => ({
  campaign: { id: 'c1', name: 'Diwali', programLabel: 'Bajaj Loyalty', billedToClientName: 'Bajaj', status, budgetRupees: 5000, note: 'Q3 thank-you', ...extra },
  summary: { bought: 2, pending: 1, buyFailed: 1, messageSent: 2, delivered: 1, read: 0, messageFailed: 1, spentRupees: 1000 },
});
const ROWS = {
  total: 4, page: 1, pageSize: 50,
  rows: [
    { id: 'r1', rowNumber: 2, phone: '9876543210', name: 'Asha', amount: 500, brand: 'AMAZON', status: 'BOUGHT', hubbleRef: 'HB-001', voucherCode: 'ABCD-EFGH-1234', messageStatus: 'delivered', messageSentAt: '2026-11-16T10:00:00Z', messageDeliveredAt: '2026-11-16T10:01:00Z', canResend: true },
    { id: 'r2', rowNumber: 3, phone: '9876543211', name: 'Ravi', amount: 500, brand: 'AMAZON', status: 'BUY_FAILED', invalidReason: null, buyError: 'Hubble: product out of stock' },
    { id: 'r3', rowNumber: 4, phone: '9876543212', name: 'Meera', amount: 500, brand: 'AMAZON', status: 'PENDING_RECONCILE' },
    { id: 'r4', rowNumber: 5, phone: '9876543213', name: 'Kiran', amount: 500, brand: 'AMAZON', status: 'BOUGHT', hubbleRef: 'HB-004', voucherCode: '****9999', messageStatus: 'failed', messageFailedAt: '2026-11-16T10:02:00Z', messageError: 'Number not on WhatsApp', canResend: true },
    { id: 'r5', rowNumber: 6, phone: '9876543214', name: 'Dev', amount: 500, brand: 'AMAZON', status: 'BOUGHT', voucherCode: 'SHORT1', canResend: false },
  ],
};

let campaignQueue: unknown[];
let rowsHandler: (url: string) => Promise<unknown>;
let actionResponse: unknown | (() => Promise<unknown>);
let fetchMock: ReturnType<typeof vi.fn>;
const callsTo = (pred: (u: string) => boolean) => fetchMock.mock.calls.filter((c) => pred(String(c[0])));
const campaignCalls = () => callsTo((u) => u === BASE).length;

function installFetch() {
  fetchMock = vi.fn((url: string) => {
    if (url === BASE) {
      const next = campaignQueue.length > 1 ? campaignQueue.shift() : campaignQueue[0];
      return Promise.resolve(next);
    }
    if (url.startsWith(`${BASE}/rows?`)) return rowsHandler(url);
    if (url.endsWith('/resend') || url.endsWith('/retry-buy') || url.endsWith('/cancel')) {
      return typeof actionResponse === 'function' ? (actionResponse as () => Promise<unknown>)() : Promise.resolve(actionResponse);
    }
    return Promise.resolve(fail(404, 'unexpected'));
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  campaignQueue = [ok(campaign('COMPLETED_WITH_ERRORS'))];
  rowsHandler = () => Promise.resolve(ok(ROWS));
  actionResponse = ok({});
  installFetch();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Voucher campaign detail', () => {
  it('shows tiles, every failure / pending with its reason, masked codes, timestamps', { timeout: 20000 }, async () => {
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-row-r1')).toBeInTheDocument();
    expect(screen.getByTestId('vd-campaign-status')).toHaveTextContent('Completed with errors');
    expect(screen.getByText(/Programme: Bajaj Loyalty · Billed to: Bajaj/)).toBeInTheDocument();
    expect(screen.getByTestId('vd-tile-buyfailed')).toHaveTextContent('1');
    expect(screen.getByTestId('vd-tile-msgfailed')).toHaveTextContent('1');
    const spent = screen.getByTestId('vd-tile-spent');
    expect(spent).toHaveTextContent('₹1,000 / ₹5,000');
    expect(spent.className).toMatch(/col-span-2/);
    expect(spent).toHaveAttribute('title', 'Spent / budget: ₹1,000 / ₹5,000');
    expect(spent.innerHTML).not.toMatch(/truncate/);

    const r1 = screen.getByTestId('vd-row-r1');
    expect(r1).toHaveTextContent('HB-001');
    expect(r1).toHaveTextContent('••••1234');
    expect(r1).not.toHaveTextContent('ABCD-EFGH-1234');
    expect(screen.getByTestId('vd-row-r5')).toHaveTextContent('••••••••');
    expect(screen.getByTestId('vd-row-r5')).not.toHaveTextContent('SHORT1');
    expect(within(r1).getByTestId('vd-msg-r1')).toHaveTextContent('Delivered');
    expect(r1).toHaveTextContent(/Delivered \d/);
    expect(screen.getByTestId('vd-row-r2')).toHaveTextContent('Hubble: product out of stock');
    expect(screen.getByTestId('vd-row-r3')).toHaveTextContent('Hubble has not confirmed whether this purchase went through');
    expect(screen.getByTestId('vd-row-r4')).toHaveTextContent('Number not on WhatsApp');

    // Resend follows the server's canResend; retry only on BUY_FAILED.
    expect(screen.getByTestId('vd-resend-r1')).toBeInTheDocument();
    expect(screen.getByTestId('vd-resend-r4')).toBeInTheDocument();
    expect(screen.queryByTestId('vd-resend-r5')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vd-resend-r2')).not.toBeInTheDocument();
    expect(screen.getByTestId('vd-retry-r2')).toBeInTheDocument();
    expect(screen.queryByTestId('vd-retry-r3')).not.toBeInTheDocument();
    // Completed (no completedAt, never seen live here) → no cancel, not refreshing.
    expect(screen.queryByTestId('vd-cancel')).not.toBeInTheDocument();
    expect(screen.getByTestId('vd-live')).toHaveTextContent('Not refreshing automatically');
  });

  it('missing numbers show "—", never 0', { timeout: 20000 }, async () => {
    campaignQueue = [ok({ campaign: { id: 'c1', name: 'X', status: 'COMPLETED' }, summary: { bought: 3 } })];
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-tile-bought')).toHaveTextContent('3');
    expect(screen.getByTestId('vd-tile-delivered')).toHaveTextContent('—');
    expect(screen.getByTestId('vd-tile-spent')).toHaveTextContent('— / —');
  });

  it('resend without canResend: hidden while PROCESSING with no message yet', { timeout: 20000 }, async () => {
    campaignQueue = [ok(campaign('PROCESSING'))];
    rowsHandler = () => Promise.resolve(ok({ rows: [{ id: 'r9', rowNumber: 9, status: 'BOUGHT', voucherCode: null }], total: 1, pageSize: 50 }));
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-row-r9')).toHaveTextContent('Not sent yet');
    expect(screen.queryByTestId('vd-resend-r9')).not.toBeInTheDocument();
  });

  it('resend: dialog says no new voucher is bought; posts once; honest, dismissible notice', { timeout: 20000 }, async () => {
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-resend-r1'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('No new voucher is bought.');
    const btn = within(dialog).getByTestId('vd-dialog-confirm');
    fireEvent.click(btn);
    fireEvent.click(btn);
    const notice = await screen.findByTestId('vd-notice');
    expect(notice).toHaveTextContent('Resend requested for row 2');
    expect(notice).not.toHaveTextContent(/\bsent\b/i);
    expect(callsTo((u) => u.endsWith('/rows/r1/resend'))).toHaveLength(1);
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByTestId('vd-notice')).not.toBeInTheDocument();
  });

  it('retry purchase: a 4xx refusal is shown verbatim and the dialog stays open', { timeout: 20000 }, async () => {
    actionResponse = fail(409, 'Retry refused: Hubble shows this order as fulfilled (HB-002). Run reconcile instead.');
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-retry-r2'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    expect(await within(dialog).findByTestId('vd-dialog-error'))
      .toHaveTextContent('Retry refused: Hubble shows this order as fulfilled (HB-002). Run reconcile instead.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(callsTo((u) => u.endsWith('/rows/r2/retry-buy'))).toHaveLength(1);
  });

  it('retry purchase: 5xx → dialog closes, outcome UNKNOWN notice, button locked until the refresh lands', { timeout: 20000 }, async () => {
    actionResponse = fail(502, 'Bad gateway');
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-retry-r2'));
    const dialog = await screen.findByRole('dialog');
    // Hold the follow-up refresh so the locked state is observable.
    let releaseRows: () => void = () => {};
    rowsHandler = () => new Promise((res) => { releaseRows = () => res(ok(ROWS)); });
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('vd-notice')).toHaveTextContent("We couldn't tell whether the purchase retry started (Bad gateway)");
    expect(screen.getByTestId('vd-retry-r2')).toBeDisabled();
    fireEvent.click(screen.getByTestId('vd-retry-r2'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { releaseRows(); });
    await waitFor(() => expect(screen.getByTestId('vd-retry-r2')).toBeEnabled());
    expect(callsTo((u) => u.endsWith('/rows/r2/retry-buy'))).toHaveLength(1);
  });

  it('retry purchase: network error is also an unknown outcome', { timeout: 20000 }, async () => {
    actionResponse = () => Promise.reject(new TypeError('Failed to fetch'));
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-retry-r2'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('vd-dialog-confirm'));
    expect(await screen.findByTestId('vd-notice')).toHaveTextContent("We couldn't tell whether the purchase retry started");
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape closes a dialog', { timeout: 20000 }, async () => {
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-resend-r1'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(callsTo((u) => u.endsWith('/resend'))).toHaveLength(0);
  });

  it('cancel is offered while processing, warns in-progress purchases may complete, and posts after confirmation', { timeout: 20000 }, async () => {
    campaignQueue = [ok(campaign('PROCESSING')), ok(campaign('CANCELLED'))];
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-cancel'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('purchases already in progress may still complete');
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    await waitFor(() => expect(callsTo((u) => u.endsWith('/c1/cancel'))).toHaveLength(1));
    expect(await screen.findByTestId('vd-campaign-status')).toHaveTextContent('Cancelled');
  });

  it('unknown campaign / row status: raw value shown, never "Invalid" or setup wording, keeps refreshing', { timeout: 20000 }, async () => {
    campaignQueue = [ok(campaign('PAUSED'))];
    rowsHandler = () => Promise.resolve(ok({ rows: [{ id: 'rx', rowNumber: 7, status: 'REFUNDED' }], total: 1, pageSize: 50 }));
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-campaign-status')).toHaveTextContent('Unknown status: PAUSED');
    expect(screen.getByTestId('vd-row-status-rx')).toHaveTextContent('Unknown status: REFUNDED');
    expect(screen.getByTestId('vd-row-rx')).not.toHaveTextContent('Invalid');
    expect(screen.getByTestId('vd-live')).toHaveTextContent('does not recognise (PAUSED). Still refreshing automatically');
    expect(screen.getByTestId('vd-live')).not.toHaveTextContent('nothing has been bought');
    expect(screen.queryByText('Continue setup')).not.toBeInTheDocument();
  });

  it('load error shows the server text and retries', { timeout: 20000 }, async () => {
    campaignQueue = [fail(500, 'Database unavailable'), ok(campaign('COMPLETED'))];
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-error')).toHaveTextContent('Database unavailable');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByTestId('vd-row-r1')).toBeInTheDocument();
  });

  it('a failed manual refresh is shown (data stays)', { timeout: 20000 }, async () => {
    campaignQueue = [ok(campaign('COMPLETED')), fail(503, 'Service unavailable')];
    render(<DetailPage />);
    await screen.findByTestId('vd-row-r1');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByTestId('vd-refresh-error')).toHaveTextContent('Service unavailable');
    expect(screen.getByTestId('vd-row-r1')).toBeInTheDocument();
  });

  it('only the latest response is applied when a filter change overlaps a slower earlier request', { timeout: 20000 }, async () => {
    render(<DetailPage />);
    await screen.findByTestId('vd-row-r1');
    // A slow "Refresh" (all rows) is overtaken by a fast filter change (BUY_FAILED only).
    let releaseSlow: () => void = () => {};
    rowsHandler = (url) => url.includes('status=BUY_FAILED')
      ? Promise.resolve(ok({ rows: [ROWS.rows[1]], total: 1, pageSize: 50 }))
      : new Promise((res) => { releaseSlow = () => res(ok(ROWS)); });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.change(screen.getByLabelText('Voucher status'), { target: { value: 'BUY_FAILED' } });
    await waitFor(() => expect(screen.queryByTestId('vd-row-r1')).not.toBeInTheDocument());
    expect(screen.getByTestId('vd-row-r2')).toBeInTheDocument();
    await act(async () => { releaseSlow(); });
    // The stale all-rows reply must NOT overwrite the filtered table.
    expect(screen.queryByTestId('vd-row-r1')).not.toBeInTheDocument();
  });
});

describe('Voucher campaign detail — polling', () => {
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const MIN = 60_000;
  /** Advance in 1s act() steps so React can commit + re-arm the next poll timer between ticks. */
  const advanceInSteps = async (ms: number) => {
    for (let t = 0; t < ms; t += 1000) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    }
  };

  it('polls while PROCESSING with backoff, keeps going 30 min after COMPLETED, then stops', { timeout: 20000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
    // No server completedAt → the window starts when this page sees it finish.
    campaignQueue = [ok(campaign('PROCESSING')), ok(campaign('PROCESSING')), ok(campaign('COMPLETED'))];
    render(<DetailPage />);
    await flush();
    expect(campaignCalls()).toBe(1);
    expect(screen.getByTestId('vd-live')).toHaveTextContent('Live');

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(campaignCalls()).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(campaignCalls()).toBe(2); // backed off to 4.5s
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(campaignCalls()).toBe(3);
    expect(screen.getByTestId('vd-campaign-status')).toHaveTextContent('Completed');
    expect(screen.getByTestId('vd-live')).toHaveTextContent('still refreshing automatically for 30 minutes');

    const before = campaignCalls();
    await advanceInSteps(5 * MIN);
    expect(campaignCalls()).toBeGreaterThan(before + 5);

    await advanceInSteps(26 * MIN);
    const atStop = campaignCalls();
    expect(screen.getByTestId('vd-live')).toHaveTextContent('Not refreshing automatically');
    await advanceInSteps(60 * MIN);
    expect(campaignCalls()).toBe(atStop);
  });

  it('server completedAt drives the window: completed 40 min ago → no polling; 10 min ago → polls', { timeout: 20000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:40:00Z'));
    campaignQueue = [ok(campaign('COMPLETED', { completedAt: '2026-11-16T10:00:00Z' }))];
    const { unmount } = render(<DetailPage />);
    await flush();
    expect(screen.getByTestId('vd-live')).toHaveTextContent('Not refreshing automatically');
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * MIN); });
    expect(campaignCalls()).toBe(1);
    unmount();

    vi.setSystemTime(new Date('2026-11-16T10:10:00Z'));
    fetchMock.mockClear();
    render(<DetailPage />);
    await flush();
    expect(screen.getByTestId('vd-live')).toHaveTextContent('still refreshing automatically');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(campaignCalls()).toBe(2);
  });

  it('a failed poll is shown and polling continues', { timeout: 20000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    campaignQueue = [ok(campaign('PROCESSING')), fail(502, 'Bad gateway'), ok(campaign('PROCESSING'))];
    render(<DetailPage />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByTestId('vd-poll-error')).toHaveTextContent('Bad gateway');
    expect(screen.getByTestId('vd-row-r1')).toBeInTheDocument(); // data stays on screen
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(campaignCalls()).toBe(3);
    expect(screen.queryByTestId('vd-poll-error')).not.toBeInTheDocument();
  });

  it('pauses while the tab is hidden and resumes when visible', { timeout: 20000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let state: DocumentVisibilityState = 'visible';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    campaignQueue = [ok(campaign('PROCESSING'))];
    render(<DetailPage />);
    await flush();
    expect(campaignCalls()).toBe(1);
    state = 'hidden';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.getByTestId('vd-live')).toHaveTextContent('paused while this tab is hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(campaignCalls()).toBe(1);
    state = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(campaignCalls()).toBe(2);
    spy.mockRestore();
  });
});
