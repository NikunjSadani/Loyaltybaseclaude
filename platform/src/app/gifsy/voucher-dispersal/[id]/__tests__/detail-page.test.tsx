/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — campaign detail / live delivery report.
 * Polling stops when done · resend (BOUGHT only, "No new voucher is bought") · retry with the API's
 * refusal text verbatim · masked codes · failed / pending rows visible with reasons · error states.
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

const campaign = (status: string) => ({
  campaign: { id: 'c1', name: 'Diwali', programLabel: 'Bajaj Loyalty', billedToClientName: 'Bajaj', status, budgetRupees: 5000, note: 'Q3 thank-you' },
  summary: { bought: 2, pending: 1, buyFailed: 1, messageSent: 2, delivered: 1, read: 0, messageFailed: 1, spentRupees: 1000 },
});
const ROWS = {
  total: 4, page: 1, pageSize: 50,
  rows: [
    { id: 'r1', rowNumber: 2, phone: '9876543210', name: 'Asha', amount: 500, brand: 'AMAZON', status: 'BOUGHT', hubbleRef: 'HB-001', voucherCode: 'ABCD-EFGH-1234', messageStatus: 'delivered', messageSentAt: '2026-11-16T10:00:00Z', messageDeliveredAt: '2026-11-16T10:01:00Z' },
    { id: 'r2', rowNumber: 3, phone: '9876543211', name: 'Ravi', amount: 500, brand: 'AMAZON', status: 'BUY_FAILED', invalidReason: null, buyError: 'Hubble: product out of stock' },
    { id: 'r3', rowNumber: 4, phone: '9876543212', name: 'Meera', amount: 500, brand: 'AMAZON', status: 'PENDING_RECONCILE' },
    { id: 'r4', rowNumber: 5, phone: '9876543213', name: 'Kiran', amount: 500, brand: 'AMAZON', status: 'BOUGHT', hubbleRef: 'HB-004', voucherCode: '****9999', messageStatus: 'failed', messageFailedAt: '2026-11-16T10:02:00Z', messageError: 'Number not on WhatsApp' },
  ],
};

let campaignQueue: unknown[];
let actionResponse: unknown;
let fetchMock: ReturnType<typeof vi.fn>;
const callsTo = (pred: (u: string) => boolean) => fetchMock.mock.calls.filter((c) => pred(String(c[0])));
const campaignCalls = () => callsTo((u) => u === BASE).length;

function installFetch() {
  fetchMock = vi.fn((url: string) => {
    if (url === BASE) {
      const next = campaignQueue.length > 1 ? campaignQueue.shift() : campaignQueue[0];
      return Promise.resolve(next);
    }
    if (url.startsWith(`${BASE}/rows?`)) return Promise.resolve(ok(ROWS));
    if (url.endsWith('/resend') || url.endsWith('/retry-buy') || url.endsWith('/cancel')) return Promise.resolve(actionResponse);
    return Promise.resolve(fail(404, 'unexpected'));
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  campaignQueue = [ok(campaign('COMPLETED_WITH_ERRORS'))];
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
    expect(screen.getByTestId('vd-tile-spent')).toHaveTextContent('₹1,000 / ₹5,000');

    const r1 = screen.getByTestId('vd-row-r1');
    expect(r1).toHaveTextContent('HB-001');
    expect(r1).toHaveTextContent('••••1234');
    expect(r1).not.toHaveTextContent('ABCD-EFGH-1234');
    expect(within(r1).getByTestId('vd-msg-r1')).toHaveTextContent('Delivered');
    expect(r1).toHaveTextContent(/Delivered \d/);
    expect(screen.getByTestId('vd-row-r2')).toHaveTextContent('Hubble: product out of stock');
    expect(screen.getByTestId('vd-row-r3')).toHaveTextContent('Hubble has not confirmed whether this purchase went through');
    expect(screen.getByTestId('vd-row-r4')).toHaveTextContent('Number not on WhatsApp');

    // Actions: resend only on BOUGHT; retry only on BUY_FAILED.
    expect(screen.getByTestId('vd-resend-r1')).toBeInTheDocument();
    expect(screen.getByTestId('vd-resend-r4')).toBeInTheDocument();
    expect(screen.queryByTestId('vd-resend-r2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vd-resend-r3')).not.toBeInTheDocument();
    expect(screen.getByTestId('vd-retry-r2')).toBeInTheDocument();
    expect(screen.queryByTestId('vd-retry-r3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vd-retry-r1')).not.toBeInTheDocument();
    // Completed → no cancel, not live.
    expect(screen.queryByTestId('vd-cancel')).not.toBeInTheDocument();
    expect(screen.getByTestId('vd-live')).toHaveTextContent('Not refreshing automatically');
  });

  it('resend: confirm dialog says no new voucher is bought; posts once; honest notice', { timeout: 20000 }, async () => {
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-resend-r1'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('No new voucher is bought.');
    const btn = within(dialog).getByTestId('vd-dialog-confirm');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(await screen.findByTestId('vd-notice')).toHaveTextContent('Resend requested for row 2');
    expect(screen.getByTestId('vd-notice')).not.toHaveTextContent(/\bsent\b/i);
    expect(callsTo((u) => u.endsWith('/rows/r1/resend'))).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('retry purchase: the API refusal text is shown verbatim and the dialog stays open', { timeout: 20000 }, async () => {
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

  it('Escape closes a dialog', { timeout: 20000 }, async () => {
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-resend-r1'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(callsTo((u) => u.endsWith('/resend'))).toHaveLength(0);
  });

  it('cancel is offered while processing and posts after confirmation', { timeout: 20000 }, async () => {
    campaignQueue = [ok(campaign('PROCESSING')), ok(campaign('CANCELLED'))];
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-cancel'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Vouchers already bought stay bought');
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    await waitFor(() => expect(callsTo((u) => u.endsWith('/c1/cancel'))).toHaveLength(1));
    expect(await screen.findByTestId('vd-campaign-status')).toHaveTextContent('Cancelled');
  });

  it('load error shows the server text and retries', { timeout: 20000 }, async () => {
    campaignQueue = [fail(500, 'Database unavailable'), ok(campaign('COMPLETED'))];
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-error')).toHaveTextContent('Database unavailable');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByTestId('vd-row-r1')).toBeInTheDocument();
  });
});

describe('Voucher campaign detail — polling', () => {
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

  it('polls while PROCESSING with backoff and stops once COMPLETED', { timeout: 20000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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

    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(campaignCalls()).toBe(3); // stopped
    expect(screen.getByTestId('vd-live')).toHaveTextContent('Not refreshing automatically');
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
});
