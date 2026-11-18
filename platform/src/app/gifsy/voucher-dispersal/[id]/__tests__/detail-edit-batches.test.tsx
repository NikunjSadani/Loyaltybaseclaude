/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — campaign detail: Edit campaign (name / budget, floor stated, refusal verbatim,
 * history), batch list + batch filter, "Add more people" (link or the server's reason), an unconfirmed
 * batch (Review & confirm / Discard), cancel copy with a discarded batch. Owner-approved 2026-11-18.
 * Run: npx vitest run "src/app/gifsy/voucher-dispersal/[id]/__tests__/detail-edit-batches.test.tsx"
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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

const BATCH1 = {
  batchNumber: 1, status: 'CONFIRMED', sourceFileName: 'first.xlsx', uploadedById: 'u1', uploadedByName: 'Admin One', uploadedAt: '2026-11-16T10:00:00Z',
  confirmedById: 'u1', confirmedByName: 'Admin One', confirmedAt: '2026-11-16T10:05:00Z', discardedById: null, discardedByName: null, discardedAt: null,
  discardReason: null, previewId: null, total: 3, valid: 2, invalid: 1, duplicates: 0, bought: 2, buyFailed: 0, pending: 0, cancelled: 0, totalRupees: 1500, spentRupees: 1500,
};
const BATCH2 = { ...BATCH1, batchNumber: 2, sourceFileName: 'more.xlsx', uploadedByName: 'Admin Two', total: 2, valid: 2, invalid: 0, bought: 1, buyFailed: 1, totalRupees: 800, spentRupees: 500 };
const PENDING3 = { ...BATCH1, batchNumber: 3, status: 'PREVIEWED', sourceFileName: 'third.xlsx', previewId: 'pv3', confirmedAt: null, confirmedByName: null, bought: 0, total: 4, valid: 3 };

const detail = (o: { status?: string; batches?: unknown[]; edits?: unknown[]; campaign?: Record<string, unknown>; summary?: Record<string, unknown> } = {}) => ({
  campaign: {
    id: 'c1', name: 'Diwali', programLabel: 'Bajaj Loyalty', billedToClient: null, status: o.status ?? 'COMPLETED_WITH_ERRORS', budgetRupees: 5000,
    canCancel: false, canEdit: true, addPeopleBlockedReason: null, ...o.campaign,
  },
  hubbleConfigured: true,
  summary: { bought: 3, pending: 0, buyFailed: 1, messageSent: 3, delivered: 3, read: 0, messageFailed: 0, spentRupees: 2000, budgetFloorRupees: 2300, ...o.summary },
  batches: o.batches ?? [BATCH1, BATCH2],
  edits: o.edits ?? [
    { at: '2026-11-17T09:00:00Z', byId: 'u2', byName: 'Admin Two', changes: [{ field: 'budgetRupees', from: 3000, to: 5000 }, { field: 'name', from: 'Diwali v1', to: 'Diwali' }] },
  ],
});
const ROWS = {
  total: 2, page: 1, pageSize: 100,
  rows: [
    { id: 'r1', batchNumber: 1, rowNumber: 2, phone: '9876543210', name: 'Asha', amount: 500, brand: 'Amazon Pay', status: 'BOUGHT', canResend: false },
    { id: 'r2', batchNumber: 2, rowNumber: 2, phone: '9876543211', name: 'Ravi', amount: 300, brand: 'Flipkart', status: 'BUY_FAILED', buyFailureReason: 'out of stock', canRetryBuy: false },
  ],
};

let detailQueue: unknown[];
let patchResponse: unknown;
let discardResponse: unknown;
let cancelResponse: unknown;
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (pred: (u: string, init?: RequestInit) => boolean) => fetchMock.mock.calls.filter((c) => pred(String(c[0]), c[1] as RequestInit));

beforeEach(() => {
  detailQueue = [ok(detail())];
  patchResponse = ok({ id: 'c1', name: 'Diwali', budgetRupees: 7000, status: 'COMPLETED_WITH_ERRORS' });
  discardResponse = ok({ campaign: {}, batchNumber: 3, discardedRows: 4 });
  cancelResponse = ok({ campaign: {}, cancelledRows: 2, stillWithHubble: 0, alreadyBought: 3, discardedPendingBatchRows: 4 });
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === BASE && init?.method === 'PATCH') return Promise.resolve(patchResponse);
    if (url === BASE) return Promise.resolve(detailQueue.length > 1 ? detailQueue.shift() : detailQueue[0]);
    if (url.startsWith(`${BASE}/rows?`)) return Promise.resolve(ok(ROWS));
    if (url.endsWith('/discard')) return Promise.resolve(discardResponse);
    if (url.endsWith('/retry-buy')) return Promise.resolve(ok({ message: 'Queued for purchase again.', row: {} }));
    if (url.endsWith('/mark-not-bought')) return Promise.resolve(ok({ id: 'r2', status: 'BUY_FAILED', buyFailureSource: 'MARKED_NOT_BOUGHT' }));
    if (url.endsWith('/cancel')) return Promise.resolve(cancelResponse);
    if (url.endsWith('/process')) return Promise.resolve(ok(detail()));
    return Promise.resolve(fail(404, 'unexpected'));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Edit campaign', () => {
  it('opens prefilled, states the budget floor, blocks a budget below it, and sends ONLY the changed fields', async () => {
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-edit'));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Campaign name') as HTMLInputElement;
    const budget = within(dialog).getByLabelText('Budget (₹)') as HTMLInputElement;
    expect(name.value).toBe('Diwali');
    expect(budget.value).toBe('5000');
    expect(within(dialog).getByTestId('vd-edit-floor')).toHaveTextContent('The budget can go down to ₹2,300 at the lowest — that much is already spent or committed.');
    fireEvent.change(budget, { target: { value: '2000' } });
    fireEvent.click(within(dialog).getByTestId('vd-edit-save'));
    expect(within(dialog).getByTestId('vd-edit-budget-error')).toHaveTextContent("The budget can't go below ₹2,300");
    expect(calls((u, i) => u === BASE && i?.method === 'PATCH')).toHaveLength(0);
    fireEvent.change(budget, { target: { value: '7000' } });
    fireEvent.click(within(dialog).getByTestId('vd-edit-save'));
    await waitFor(() => expect(calls((u, i) => u === BASE && i?.method === 'PATCH')).toHaveLength(1));
    expect(JSON.parse(String(calls((u, i) => u === BASE && i?.method === 'PATCH')[0][1].body))).toEqual({ budgetRupees: 7000 });
    expect(await screen.findByTestId('vd-notice')).toHaveTextContent('Campaign updated: Budget ₹5,000 → ₹7,000.');
  });

  it('a server refusal is shown word for word inside the dialog; nothing changed is refused locally', async () => {
    patchResponse = fail(400, "The budget can't go below ₹2,400 — that much is already spent (₹2,000) or committed to purchases still in progress (₹400).");
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-edit'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('vd-edit-save'));
    expect(within(dialog).getByTestId('vd-edit-form-error')).toHaveTextContent('Nothing has changed.');
    fireEvent.change(within(dialog).getByLabelText('Budget (₹)'), { target: { value: '2350' } });
    fireEvent.click(within(dialog).getByTestId('vd-edit-save'));
    expect(await within(dialog).findByTestId('vd-dialog-error')).toHaveTextContent("The budget can't go below ₹2,400 — that much is already spent (₹2,000) or committed to purchases still in progress (₹400).");
  });

  it('budget box keeps the decimal point: "2500.00" is refused, nothing saved; "2,500" saves ₹2,500 (echoed)', async () => {
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-edit'));
    const dialog = await screen.findByRole('dialog');
    const budget = within(dialog).getByLabelText('Budget (₹)') as HTMLInputElement;
    fireEvent.change(budget, { target: { value: '2500.00' } });
    expect(budget.value).toBe('2500.00');
    fireEvent.click(within(dialog).getByTestId('vd-edit-save'));
    expect(within(dialog).getByTestId('vd-edit-budget-error')).toHaveTextContent('Enter the budget in whole rupees (no paise).');
    expect(calls((u, i) => u === BASE && i?.method === 'PATCH')).toHaveLength(0);
    fireEvent.change(budget, { target: { value: '25,00' } });
    fireEvent.click(within(dialog).getByTestId('vd-edit-save'));
    expect(within(dialog).getByTestId('vd-edit-budget-error')).toHaveTextContent('Use commas only between thousands');
    expect(calls((u, i) => u === BASE && i?.method === 'PATCH')).toHaveLength(0);
    fireEvent.change(budget, { target: { value: '₹2,500' } });
    expect(within(dialog).getByTestId('vd-edit-budget-echo')).toHaveTextContent('= ₹2,500');
    fireEvent.click(within(dialog).getByTestId('vd-edit-save'));
    await waitFor(() => expect(calls((u, i) => u === BASE && i?.method === 'PATCH')).toHaveLength(1));
    expect(JSON.parse(String(calls((u, i) => u === BASE && i?.method === 'PATCH')[0][1].body))).toEqual({ budgetRupees: 2500 });
  });

  it('a zero floor is stated as "at least ₹1" (the smallest budget allowed)', async () => {
    detailQueue = [ok(detail({ summary: { budgetFloorRupees: 0 } }))];
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-edit'));
    expect(within(await screen.findByRole('dialog')).getByTestId('vd-edit-floor')).toHaveTextContent('The budget can go down to ₹1 at the lowest');
  });

  it('a cancelled campaign shows Edit DISABLED with the reason (server canEdit=false) — never silently missing', async () => {
    detailQueue = [ok(detail({ status: 'CANCELLED', campaign: { canEdit: false, addPeopleBlockedReason: 'This campaign was cancelled — people cannot be added to it.' } }))];
    render(<DetailPage />);
    await screen.findByTestId('vd-detail');
    expect(screen.getByTestId('vd-edit')).toBeDisabled();
    expect(screen.getByTestId('vd-edit')).toHaveAccessibleDescription("A cancelled campaign can't be edited.");
    expect(screen.getByTestId('vd-edit-blocked')).toHaveTextContent("A cancelled campaign can't be edited.");
    expect(screen.getByTestId('vd-add-people-blocked')).toHaveTextContent('This campaign was cancelled — people cannot be added to it.');
  });

  it('shows the SAME budget breakdown the floor uses (failed rows never called "in progress")', async () => {
    detailQueue = [ok(detail({ summary: { budgetFloorRupees: 2000, budgetUsage: { spentRupees: 1000, withHubbleRupees: 500, failedMayCompleteRupees: 300, queuedRupees: 200, floorRupees: 2000 } } }))];
    render(<DetailPage />);
    const line = await screen.findByTestId('vd-budget-usage');
    expect(line).toHaveTextContent('Budget used: ₹2,000 of ₹5,000 — spent ₹1,000 · with Hubble (not yet confirmed) ₹500 · failed purchases Hubble may still complete ₹300 · queued ₹200');
    expect(line).not.toHaveTextContent('in progress');
  });

  it('over budget: the banner states the ACTUAL causes (bought later / back with Hubble), or a neutral reason', async () => {
    detailQueue = [ok(detail({ summary: { overBudgetRupees: 1000, lateCompletedRows: 1, failedBackWithHubbleRows: 0 } }))];
    const { unmount } = render(<DetailPage />);
    const b = await screen.findByTestId('vd-over-budget');
    expect(b).toHaveAttribute('role', 'alert');
    expect(b).toHaveTextContent('Over budget by ₹1,000 — 1 purchase was bought later by Hubble after it had failed/refused.');
    unmount();

    detailQueue = [ok(detail({ summary: { overBudgetRupees: 500, lateCompletedRows: 0, failedBackWithHubbleRows: 2 } }))];
    const r2 = render(<DetailPage />);
    const b2 = await screen.findByTestId('vd-over-budget');
    expect(b2).toHaveTextContent('Over budget by ₹500 — 2 failed purchases are back with Hubble and count again (they may still be bought).');
    expect(b2).not.toHaveTextContent('bought later');
    r2.unmount();

    detailQueue = [ok(detail({ summary: { overBudgetRupees: 300, lateCompletedRows: 0, failedBackWithHubbleRows: 0 } }))];
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-over-budget')).toHaveTextContent('Over budget by ₹300 — spending is above the budget; see "Budget used" below.');
  });

  it('Hubble activity on EARLIER orders: a loud alert with the TOTAL count, wording per status, never in "Budget used" / over-budget causes', async () => {
    detailQueue = [ok(detail({ summary: {
      overBudgetRupees: 0,
      budgetUsage: { spentRupees: 1000, withHubbleRupees: 0, failedMayCompleteRupees: 0, queuedRupees: 0, floorRupees: 1000 },
      earlierOrderAlerts: {
        total: 23,
        items: [
          { at: '2026-11-18T10:00:00Z', kind: 'SUPERSEDED', batchNumber: 1, rowNumber: 3, referenceId: 'vdA', hubbleStatus: 'SUCCESS' },
          { at: '2026-11-18T09:00:00Z', kind: 'SUPERSEDED', batchNumber: 2, rowNumber: 5, referenceId: 'vdB', hubbleStatus: 'PROCESSING' },
          { at: '2026-11-18T08:00:00Z', kind: 'MARKED_NOT_BOUGHT', batchNumber: 1, rowNumber: 4, referenceId: 'vdC', hubbleStatus: 'SUCCESS' },
          { at: '2026-11-18T07:00:00Z', kind: 'SUPERSEDED', batchNumber: 1, rowNumber: 6, referenceId: 'vdD', hubbleStatus: 'LOOKUP_FAILED' },
          { at: '2026-11-18T06:00:00Z', kind: 'NOT_APPLIED', batchNumber: 1, rowNumber: 7, referenceId: 'vdE', hubbleStatus: 'SUCCESS', statusHistory: ['PROCESSING', 'SUCCESS'] },
        ],
      },
    } }))];
    render(<DetailPage />);
    const box = await screen.findByTestId('vd-earlier-orders');
    expect(box).toHaveAttribute('role', 'alert');
    expect(box).toHaveTextContent('Hubble reported activity on 23 earlier orders (the latest 5 are listed).');
    expect(box).toHaveTextContent("Batch 1, row 6: couldn't check an earlier order with Hubble — check with Hubble (a voucher may have been issued twice, or a paid voucher may not have reached the person).");
    expect(box).toHaveTextContent('Batch 1, row 7: a completed order from Hubble could not be applied to this row (earlier: PROCESSING) — check with Hubble');
    expect(box).toHaveTextContent('Batch 1, row 3: an earlier order was reported completed by Hubble after a retry — check with Hubble (a voucher may have been issued twice, or a paid voucher may not have reached the person).');
    expect(box).toHaveTextContent('Batch 2, row 5: an earlier order was reported PROCESSING by Hubble after a retry — check with Hubble');
    expect(box).toHaveTextContent('Batch 1, row 4: the order of a row marked not bought was reported completed by Hubble — check with Hubble');
    expect(screen.getByTestId('vd-budget-usage')).not.toHaveTextContent('earlier order');
    expect(screen.queryByTestId('vd-over-budget')).not.toBeInTheDocument();
  });

  it('a row marked "not bought" shows the closed note and no Retry / Mark buttons', async () => {
    const closed = 'Marked as not bought by Admin One — closed. Arrange any replacement with Hubble outside this campaign.';
    const rows = { ...ROWS, rows: [ROWS.rows[0], { ...ROWS.rows[1], buyFailureReason: 'Marked as not bought by Admin One: ticket 7', canRetryBuy: false, canMarkNotBought: false, closedNote: closed }] };
    fetchMock.mockImplementation((url: string) => (url.startsWith(`${BASE}/rows?`) ? Promise.resolve(ok(rows)) : Promise.resolve(ok(detail()))));
    render(<DetailPage />);
    const row = await screen.findByTestId('vd-row-r2');
    expect(within(row).getByTestId('vd-closed-r2')).toHaveTextContent(closed);
    expect(within(row).queryByTestId('vd-retry-r2')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('vd-mark-r2')).not.toBeInTheDocument();
  });

  it('Retry is hidden where it would always be refused (unrecognised Hubble answer) — the reason is shown instead', async () => {
    const rows = { ...ROWS, rows: [ROWS.rows[0], { ...ROWS.rows[1], canRetryBuy: false, canMarkNotBought: true }] };
    fetchMock.mockImplementation((url: string) => (url.startsWith(`${BASE}/rows?`) ? Promise.resolve(ok(rows)) : Promise.resolve(ok(detail()))));
    render(<DetailPage />);
    const row = await screen.findByTestId('vd-row-r2');
    expect(within(row).queryByTestId('vd-retry-r2')).not.toBeInTheDocument();
    expect(within(row).getByTestId('vd-retry-unavailable-r2')).toHaveTextContent("Retry is unavailable: Hubble's answer was not recognised — check with Hubble; if it was not bought, Mark as not bought closes the row.");
    expect(row).not.toHaveTextContent(/then use Mark|new reference/);
  });

  it('"Mark as not bought": reason required, sent to the server, the result said in plain words', async () => {
    const rows = { ...ROWS, rows: [ROWS.rows[0], { ...ROWS.rows[1], canMarkNotBought: true }] };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith(`${BASE}/rows?`)) return Promise.resolve(ok(rows));
      if (url.endsWith('/mark-not-bought')) return Promise.resolve(ok({ id: 'r2', status: 'BUY_FAILED' }));
      if (url === BASE && !init?.method) return Promise.resolve(ok(detail()));
      return Promise.resolve(ok(detail()));
    });
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-mark-r2'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Mark as not bought?');
    expect(dialog).toHaveTextContent('This closes the row for good: its ₹300 is released and no voucher will be bought for this person in this campaign. Arrange any replacement with Hubble outside this campaign.');
    expect(dialog).not.toHaveTextContent(/Retry|new .*reference/i);
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    expect(within(dialog).getByTestId('vd-dialog-error')).toHaveTextContent('Give the reason (at least 5 characters)');
    expect(calls((u) => u.endsWith('/mark-not-bought'))).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Hubble support: ticket 42' } });
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    await waitFor(() => expect(calls((u) => u.endsWith('/rows/r2/mark-not-bought'))).toHaveLength(1));
    expect(JSON.parse(String(calls((u) => u.endsWith('/mark-not-bought'))[0][1].body))).toEqual({ reason: 'Hubble support: ticket 42' });
    const notice = await screen.findByTestId('vd-notice');
    expect(notice).toHaveTextContent('Batch 2, row 2 marked as not bought — the row is closed: its ₹300 is released and no voucher will be bought for this person in this campaign. Arrange any replacement with Hubble outside this campaign.');
    expect(notice).not.toHaveTextContent(/Retry|new reference/);
  });

  it('queued vouchers that no longer fit are called out apart from "over budget"', async () => {
    detailQueue = [ok(detail({ summary: { overBudgetRupees: 0, queuedAtRiskRupees: 500 } }))];
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-queued-at-risk')).toHaveTextContent("₹500 of queued vouchers can't be bought within the budget");
    expect(screen.queryByTestId('vd-over-budget')).not.toBeInTheDocument();
  });

  it('no banner when not over budget', async () => {
    render(<DetailPage />);
    await screen.findByTestId('vd-detail');
    expect(screen.queryByTestId('vd-over-budget')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vd-settle-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vd-queued-at-risk')).not.toBeInTheDocument();
  });

  it('a status update that keeps failing → banner "contact Gifsy tech"; add-people reason from the server', async () => {
    detailQueue = [ok(detail({ status: 'PROCESSING', campaign: { canCancel: true, settleError: 'P2028 Transaction API error', addPeopleBlockedReason: "This campaign's status update keeps failing — contact Gifsy tech." } }))];
    render(<DetailPage />);
    const b = await screen.findByTestId('vd-settle-error');
    expect(b).toHaveTextContent('Status update keeps failing — contact Gifsy tech.');
    expect(b).toHaveTextContent('P2028 Transaction API error');
    expect(screen.getByTestId('vd-add-people-blocked')).toHaveTextContent('keeps failing — contact Gifsy tech');
    expect(screen.getByTestId('vd-add-people-blocked')).not.toHaveTextContent('still being bought');
  });

  it('shows the edit history (who, when, old → new)', async () => {
    render(<DetailPage />);
    const h = await screen.findByTestId('vd-edit-history');
    expect(h).toHaveTextContent('Admin Two');
    expect(h).toHaveTextContent('Budget ₹3,000 → ₹5,000');
    expect(h).toHaveTextContent('Name "Diwali v1" → "Diwali"');
  });
});

describe('Batches on the campaign page', () => {
  it('row action notices name the batch ("Batch 2, row 2") — row numbers repeat across batches', async () => {
    const rows = { ...ROWS, rows: [ROWS.rows[0], { ...ROWS.rows[1], canRetryBuy: true }] };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith(`${BASE}/rows?`)) return Promise.resolve(ok(rows));
      if (url.endsWith('/retry-buy')) return Promise.resolve(ok({ message: 'Queued for purchase again.', row: {} }));
      if (url === BASE && !init?.method) return Promise.resolve(ok(detail()));
      return Promise.resolve(ok(detail()));
    });
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-retry-r2'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('(batch 2, row 2)');
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    expect(await screen.findByTestId('vd-notice')).toHaveTextContent('Batch 2, row 2: Queued for purchase again.');
  });

  it('an UNKNOWN campaign status with no server reason says why Add more people is unavailable', async () => {
    detailQueue = [ok(detail({ status: 'PAUSED', campaign: { addPeopleBlockedReason: null } }))];
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-add-people-blocked')).toHaveTextContent('Add more people is unavailable while the status is not recognised.');
    expect(screen.queryByRole('link', { name: 'Add more people' })).not.toBeInTheDocument();
  });

  it('the batch table adds up: Rows = Valid + Not issued (invalid + duplicate) + Cancelled', async () => {
    detailQueue = [ok(detail({ batches: [{ ...BATCH1, total: 5, valid: 2, invalid: 1, duplicates: 1, cancelled: 1 }] }))];
    render(<DetailPage />);
    const row = await screen.findByTestId('vd-batch-1');
    expect(within(row).getByTestId('vd-batch-1-valid')).toHaveTextContent('2');
    expect(within(row).getByTestId('vd-batch-1-not-issued')).toHaveTextContent('2');
    expect(within(row).getByTestId('vd-batch-1-cancelled')).toHaveTextContent('1');
    const heads = within(screen.getByTestId('vd-batches')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(expect.arrayContaining(['Valid', 'Not issued', 'Cancelled']));
  });

  it('discard of a waiting batch with no row count never prints "—" in the sentence', async () => {
    detailQueue = [ok(detail({ batches: [BATCH1, { ...PENDING3, total: null }] }))];
    render(<DetailPage />);
    fireEvent.click(within(await screen.findByTestId('vd-pending-batch')).getByTestId('vd-discard-batch'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('The uploaded rows from third.xlsx will be removed.');
    expect(dialog).not.toHaveTextContent('—');
  });

  it('lists every batch with file, uploader, rows, bought, failed; the rows table filters by batch', async () => {
    render(<DetailPage />);
    const t = await screen.findByTestId('vd-batches');
    expect(within(t).getByTestId('vd-batch-1')).toHaveTextContent('first.xlsx');
    expect(within(t).getByTestId('vd-batch-2')).toHaveTextContent('more.xlsx');
    expect(within(t).getByTestId('vd-batch-2')).toHaveTextContent('Admin Two');
    expect(within(t).getByTestId('vd-batch-2-bought')).toHaveTextContent('1');
    expect(within(t).getByTestId('vd-batch-2-failed')).toHaveTextContent('1');
    // Rows show their batch when there is more than one.
    expect(screen.getByTestId('vd-row-r2')).toHaveTextContent('Batch 2');
    fireEvent.change(screen.getByLabelText('Batch'), { target: { value: '2' } });
    await waitFor(() => expect(calls((u) => u.startsWith(`${BASE}/rows?`) && u.includes('batch=2')).length).toBeGreaterThan(0));
  });

  it('"Add more people" links to the add page when the server allows it; otherwise its reason is shown', async () => {
    render(<DetailPage />);
    expect(await screen.findByRole('link', { name: 'Add more people' })).toHaveAttribute('href', '/gifsy/voucher-dispersal/c1/add');
  });

  it('while processing: no Add link — the server reason instead', async () => {
    detailQueue = [ok(detail({ status: 'PROCESSING', campaign: { canCancel: true, addPeopleBlockedReason: 'Vouchers in this campaign are still being bought — you can add more people once every purchase has finished (the campaign shows Completed).' } }))];
    render(<DetailPage />);
    expect(await screen.findByTestId('vd-add-people-blocked')).toHaveTextContent('still being bought');
    expect(screen.queryByRole('link', { name: 'Add more people' })).not.toBeInTheDocument();
  });

  it('an unconfirmed batch is called out with Review & confirm and Discard (dialog → POST discard → notice)', async () => {
    detailQueue = [ok(detail({ batches: [BATCH1, PENDING3] }))];
    render(<DetailPage />);
    const p = await screen.findByTestId('vd-pending-batch');
    expect(p).toHaveTextContent('Batch 3 (third.xlsx) is waiting for confirmation — nothing in it has been bought, and it is not in the totals or the report.');
    expect(within(p).getByRole('link', { name: 'Review & confirm' })).toHaveAttribute('href', '/gifsy/voucher-dispersal/c1/add');
    // "Add more people" itself becomes the same review (one batch at a time).
    expect(screen.queryByRole('link', { name: 'Add more people' })).not.toBeInTheDocument();
    fireEvent.click(within(p).getByTestId('vd-discard-batch'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Discard batch 3?');
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    await waitFor(() => expect(calls((u) => u === `${BASE}/batches/3/discard`)).toHaveLength(1));
    expect(await screen.findByTestId('vd-notice')).toHaveTextContent('Batch 3 discarded: 4 rows removed. Nothing was bought.');
  });

  it('cancel reports the discarded unconfirmed batch too', async () => {
    detailQueue = [ok(detail({ status: 'PROCESSING', batches: [BATCH1, PENDING3], campaign: { canCancel: true, addPeopleBlockedReason: 'still being bought' } }))];
    render(<DetailPage />);
    fireEvent.click(await screen.findByTestId('vd-cancel'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Batch 3, waiting for confirmation, is discarded too.');
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    expect(await screen.findByTestId('vd-notice')).toHaveTextContent('4 rows of the unconfirmed batch were discarded');
  });
});
