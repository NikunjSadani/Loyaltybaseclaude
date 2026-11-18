/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — "Add more people" (/gifsy/voucher-dispersal/[id]/add): upload → preview (duplicates
 * across batches named, budget LEFT shown) → Buy & send (confirm dialog → POST batches/:n/confirm) · over the
 * budget → blocked with the reason + "Raise the budget" (Edit dialog, then the preview is re-read) · resume an
 * unconfirmed batch · Discard · blocked campaign shows the server reason · refusals verbatim.
 * Run: npx vitest run "src/app/gifsy/voucher-dispersal/[id]/add/__tests__/add-people.test.tsx"
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'c1' }),
  useRouter: () => ({ push, replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));

import AddPeoplePage from '../page';

const BASE = '/api/admin/voucher-dispersal/campaigns/c1';
const ok = (data: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
const fail = (status: number, error: string) => ({ ok: false, status, json: () => Promise.resolve({ success: false, error }) });

const camp = (o: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Diwali', programLabel: 'Bajaj Loyalty', status: 'COMPLETED', budgetRupees: 5000, canEdit: true, addPeopleBlockedReason: null, ...o,
});
const detail = (o: { campaign?: Record<string, unknown>; batches?: unknown[] } = {}) => ({
  campaign: camp(o.campaign),
  hubbleConfigured: true,
  summary: { bought: 2, spentRupees: 1500, budgetFloorRupees: 1500 },
  batches: o.batches ?? [{ batchNumber: 1, status: 'CONFIRMED', sourceFileName: 'first.xlsx' }],
  edits: [],
});
const preview = (o: Record<string, unknown> = {}, s: Record<string, unknown> = {}) => ({
  batchNumber: 2, batchStatus: 'PREVIEWED', previewId: 'pv2', campaign: camp(),
  rows: [
    { rowNumber: 2, phone: '9876543210', name: 'Asha', amount: 500, brand: 'Amazon Pay', status: 'DUPLICATE', invalidReason: 'Already sent in batch 1 — one voucher per phone per campaign', warning: null },
    { rowNumber: 3, phone: '9876543212', name: 'Mina', amount: 500, brand: 'Amazon Pay', status: 'VALID', invalidReason: null, warning: null },
  ],
  summary: {
    total: 2, valid: 1, invalid: 0, duplicates: 1, totalRupees: 500, budgetRupees: 5000, overBudget: false, perBrand: [],
    warningCount: 0, skippedNote: null, hiddenNote: null, alreadyCommittedRupees: 1500, remainingBudgetRupees: 3500, crossBatchDuplicates: 1, ...s,
  },
  ...o,
});

let detailRes: unknown;
let uploadRes: unknown;
let batchRes: unknown;
let confirmRes: unknown;
let discardRes: unknown;
let patchRes: unknown;
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (pred: (u: string, init?: RequestInit) => boolean) => fetchMock.mock.calls.filter((c) => pred(String(c[0]), c[1] as RequestInit));

beforeEach(() => {
  detailRes = ok(detail());
  uploadRes = ok(preview());
  batchRes = ok(preview());
  confirmRes = ok(camp({ status: 'PROCESSING' }));
  discardRes = ok({ campaign: camp(), batchNumber: 2, discardedRows: 2 });
  patchRes = ok(camp({ budgetRupees: 9000 }));
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === BASE && init?.method === 'PATCH') return Promise.resolve(patchRes);
    if (url === BASE) return Promise.resolve(detailRes);
    if (url === `${BASE}/batches` && init?.method === 'POST') return Promise.resolve(uploadRes);
    if (/\/batches\/\d+\/confirm$/.test(url)) return Promise.resolve(confirmRes);
    if (/\/batches\/\d+\/discard$/.test(url)) return Promise.resolve(discardRes);
    if (/\/batches\/\d+$/.test(url)) return Promise.resolve(batchRes);
    if (url.endsWith('/process')) return Promise.resolve(ok(detail()));
    return Promise.resolve(fail(404, 'unexpected'));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const xlsx = () => new File(['x'], 'more.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

async function uploadFile() {
  const input = await screen.findByLabelText('Choose file');
  fireEvent.change(input, { target: { files: [xlsx()] } });
  fireEvent.click(screen.getByTestId('vd-upload'));
  return screen.findByTestId('vd-summary');
}

describe('Add more people', () => {
  it('upload → preview names the earlier-batch duplicate and the budget LEFT → Buy & send confirms THIS batch and opens the campaign', async () => {
    render(<AddPeoplePage />);
    expect(await screen.findByTestId('vd-add-nothing-spent')).toHaveTextContent('Nothing in this new file is bought until you confirm it.');
    const sum = await uploadFile();
    expect(calls((u, i) => u === `${BASE}/batches` && i?.method === 'POST')).toHaveLength(1);
    expect(sum).toHaveTextContent('Batch 2');
    expect(screen.getByTestId('vd-sum-cross-batch')).toHaveTextContent('1 row is a phone that already got (or is getting) a voucher in an earlier batch of this campaign — marked Duplicate, not bought again.');
    expect(screen.getByTestId('vd-sum-budget-left')).toHaveTextContent('This batch ₹500 · already spent or committed ₹1,500 · left ₹3,500 of the ₹5,000 budget');
    expect(screen.getByTestId('vd-prow-2')).toHaveTextContent('Already sent in batch 1');
    fireEvent.click(screen.getByTestId('vd-buy-send'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Buy and send 1 voucher · ₹500 total?');
    expect(dialog).toHaveTextContent('Only the 1 valid row of batch 2 is bought.');
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/gifsy/voucher-dispersal/c1'));
    const body = JSON.parse(String(calls((u) => u === `${BASE}/batches/2/confirm`)[0][1].body));
    expect(body).toEqual({ previewId: 'pv2', expectedValidCount: 1, expectedTotalRupees: 500 });
    expect(calls((u) => u === `${BASE}/process`)).toHaveLength(1);
  });

  it('over what is left of the budget → Buy blocked; "Raise the budget" states + prefills the amount needed, then re-checks the preview', async () => {
    uploadRes = ok(preview({}, { totalRupees: 4000, overBudget: true, remainingBudgetRupees: 3500 }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    batchRes = gate.then(() => ok(preview({}, { totalRupees: 4000, overBudget: false, remainingBudgetRupees: 7500, budgetRupees: 9000 })));
    render(<AddPeoplePage />);
    await uploadFile();
    expect(screen.getByTestId('vd-block-reason')).toHaveTextContent("This batch's valid rows total ₹4,000, but only ₹3,500 of the ₹5,000 budget is left");
    expect(screen.getByTestId('vd-buy-send')).toBeDisabled();
    fireEvent.click(screen.getByTestId('vd-raise-budget'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('vd-edit-hint')).toHaveTextContent('To buy batch 2 the budget must be at least ₹5,500 (already committed ₹1,500 + this batch ₹4,000).');
    expect((within(dialog).getByLabelText('Budget (₹)') as HTMLInputElement).value).toBe('5500');
    fireEvent.change(within(dialog).getByLabelText('Budget (₹)'), { target: { value: '9000' } });
    fireEvent.click(within(dialog).getByTestId('vd-edit-save'));
    // While the preview is re-read: "Re-checking…", and no claim it was re-checked yet.
    expect(await screen.findByTestId('vd-rechecking')).toHaveTextContent('Re-checking');
    expect(screen.getByTestId('vd-notice')).not.toHaveTextContent('re-checked against the new budget');
    release();
    await waitFor(() => expect(screen.getByTestId('vd-notice')).toHaveTextContent('re-checked against the new budget'));
    expect(screen.getByTestId('vd-notice')).toHaveTextContent('Budget ₹5,000 → ₹9,000');
    expect(screen.queryByTestId('vd-rechecking')).not.toBeInTheDocument();
    expect(screen.getByTestId('vd-buy-send')).not.toBeDisabled();
  });

  it('a 409 refusal on confirm (e.g. stale preview) closes the dialog, says why and reloads the current state', async () => {
    confirmRes = fail(409, 'This preview is out of date (the file was re-uploaded, maybe in another tab). Review the current preview and confirm again.');
    render(<AddPeoplePage />);
    await uploadFile();
    const before = calls((u) => u === BASE).length;
    fireEvent.click(screen.getByTestId('vd-buy-send'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    expect(await screen.findByTestId('vd-notice')).toHaveTextContent('This preview is out of date');
    await waitFor(() => expect(calls((u) => u === BASE).length).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('a 409 because the batch is ALREADY confirmed (other tab) opens the campaign page', async () => {
    confirmRes = fail(409, 'Batch 2 is already confirmed.');
    render(<AddPeoplePage />);
    await uploadFile();
    detailRes = ok(detail({ batches: [{ batchNumber: 1, status: 'CONFIRMED' }, { batchNumber: 2, status: 'CONFIRMED' }] }));
    fireEvent.click(screen.getByTestId('vd-buy-send'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('vd-dialog-confirm'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/gifsy/voucher-dispersal/c1'));
  });

  it('a 400 refusal on confirm (over budget) stays in the dialog word for word', async () => {
    confirmRes = fail(400, "This batch's valid rows total ₹500; with ₹4,800 already spent or committed that makes ₹5,300, over the ₹5,000 budget. Raise the budget (Edit campaign) or remove rows, then confirm again.");
    render(<AddPeoplePage />);
    await uploadFile();
    fireEvent.click(screen.getByTestId('vd-buy-send'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    expect(await within(dialog).findByTestId('vd-dialog-error')).toHaveTextContent('Raise the budget');
    expect(push).not.toHaveBeenCalled();
  });

  it('a 409 refusal on discard (already confirmed elsewhere) reloads and opens the campaign', async () => {
    discardRes = fail(409, 'Batch 2 is already confirmed — its vouchers are being or have been bought, so it cannot be discarded. Use Cancel campaign to stop rows not bought yet.');
    render(<AddPeoplePage />);
    await uploadFile();
    detailRes = ok(detail({ batches: [{ batchNumber: 1, status: 'CONFIRMED' }, { batchNumber: 2, status: 'CONFIRMED' }] }));
    fireEvent.click(screen.getByTestId('vd-discard'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('vd-dialog-confirm'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/gifsy/voucher-dispersal/c1'));
  });

  it('Refresh re-reads the campaign and the waiting batch', async () => {
    render(<AddPeoplePage />);
    await screen.findByLabelText('Choose file');
    const before = calls((u) => u === BASE).length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls((u) => u === BASE).length).toBe(before + 1));
  });

  it('a waiting batch that fails to load: error + Try again, and upload is offered only as "Replace batch 2" with an overwrite warning', async () => {
    detailRes = ok(detail({ batches: [{ batchNumber: 1, status: 'CONFIRMED' }, { batchNumber: 2, status: 'PREVIEWED', sourceFileName: 'more.xlsx' }] }));
    batchRes = fail(500, 'Internal error');
    render(<AddPeoplePage />);
    expect(await screen.findByTestId('vd-preview-error')).toHaveTextContent("Couldn't load the waiting batch 2: Internal error");
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Upload the new list' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Replace batch 2' })).toBeInTheDocument();
    expect(screen.getByTestId('vd-replace-warning')).toHaveTextContent('Uploading here replaces the file waiting in batch 2 (more.xlsx)');
  });

  it('the Choose file control is greyed out while a file is being checked', async () => {
    let release!: () => void;
    uploadRes = new Promise((r) => { release = () => r(ok(preview())); });
    render(<AddPeoplePage />);
    fireEvent.change(await screen.findByLabelText('Choose file'), { target: { files: [xlsx()] } });
    fireEvent.click(screen.getByTestId('vd-upload'));
    const label = await screen.findByTestId('vd-choose-file');
    await waitFor(() => expect(label).toHaveAttribute('aria-disabled', 'true'));
    expect(label.className).toMatch(/opacity-50/);
    release();
    await screen.findByTestId('vd-summary');
  });

  it('resumes an unconfirmed batch from the campaign, and Discard removes it (back to upload, says so)', async () => {
    detailRes = ok(detail({ batches: [{ batchNumber: 1, status: 'CONFIRMED' }, { batchNumber: 2, status: 'PREVIEWED', previewId: 'pv2', sourceFileName: 'more.xlsx' }] }));
    render(<AddPeoplePage />);
    expect(await screen.findByTestId('vd-summary')).toHaveTextContent('Batch 2');
    expect(calls((u) => u === `${BASE}/batches/2`)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('vd-discard'));
    const dialog = await screen.findByRole('dialog');
    // After the discard the server lists the batch as DISCARDED.
    detailRes = ok(detail({ batches: [{ batchNumber: 1, status: 'CONFIRMED' }, { batchNumber: 2, status: 'DISCARDED' }] }));
    fireEvent.click(within(dialog).getByTestId('vd-dialog-confirm'));
    await waitFor(() => expect(calls((u) => u === `${BASE}/batches/2/discard`)).toHaveLength(1));
    expect(await screen.findByTestId('vd-notice')).toHaveTextContent('Batch 2 discarded: 2 rows removed. Nothing was bought.');
    expect(screen.getByLabelText('Choose file')).toBeInTheDocument();
  });

  it('a campaign that cannot take people now shows the server reason and no upload', async () => {
    detailRes = ok(detail({ campaign: { status: 'PROCESSING', addPeopleBlockedReason: 'Vouchers in this campaign are still being bought — you can add more people once every purchase has finished (the campaign shows Completed).' } }));
    render(<AddPeoplePage />);
    expect(await screen.findByTestId('vd-add-blocked')).toHaveTextContent('still being bought');
    expect(screen.queryByLabelText('Choose file')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to the campaign/ })).toHaveAttribute('href', '/gifsy/voucher-dispersal/c1');
  });

  it('an upload refusal (bad file) is shown with the server text', async () => {
    uploadRes = fail(400, 'Missing columns: Phone, Name. Expected: Phone | Name | Amount (₹) | Brand | Note');
    render(<AddPeoplePage />);
    const input = await screen.findByLabelText('Choose file');
    fireEvent.change(input, { target: { files: [xlsx()] } });
    fireEvent.click(screen.getByTestId('vd-upload'));
    expect(await screen.findByTestId('vd-upload-error')).toHaveTextContent('Missing columns: Phone, Name.');
  });
});
