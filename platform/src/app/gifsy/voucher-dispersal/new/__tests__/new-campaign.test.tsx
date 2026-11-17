/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — new campaign flow: details → create → upload → preview → "Buy & send" dialog.
 * Covers the preview version on confirm, verbatim refusals, and the UNKNOWN-outcome path
 * (network error / 5xx on confirm → re-fetch the campaign; never keep claiming "nothing bought").
 * Run: npx vitest run src/app/gifsy/voucher-dispersal/new/__tests__/new-campaign.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const push = vi.fn();
const replace = vi.fn();
const searchRef: { current: URLSearchParams } = { current: new URLSearchParams() };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => searchRef.current,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));

import NewCampaignPage from '../page';

const BASE = '/api/admin/voucher-dispersal';
const ok = (data: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
const fail = (status: number, error: string) => ({ ok: false, status, json: () => Promise.resolve({ success: false, error }) });

// Server field names (campaignView / upload reply).
const CAMPAIGN = { id: 'c1', name: 'Diwali', programLabel: 'Bajaj Loyalty', billedToClient: { id: 'bajaj', name: 'Bajaj' }, budgetRupees: 5000, status: 'DRAFT' };
const ROWS = [
  { rowNumber: 2, phone: '9876543210', name: 'Asha', amount: 500, brand: 'AMAZON', status: 'VALID', invalidReason: null, warning: 'Already got a ₹1,000 Amazon Pay voucher on 01 Nov 2026 in campaign "Earlier"' },
  { rowNumber: 3, phone: '9876543211', name: 'Ravi', amount: 1000, brand: 'FLIPKART', status: 'VALID', invalidReason: null },
  { rowNumber: 4, phone: '12345', name: 'Bad', amount: 500, brand: 'AMAZON', status: 'INVALID', invalidReason: 'Phone must be a 10-digit Indian mobile' },
  { rowNumber: 5, phone: '9876543210', name: 'Asha again', amount: 500, brand: 'AMAZON', status: 'DUPLICATE', invalidReason: 'Duplicate of row 2' },
];
const SUMMARY = {
  total: 4, valid: 2, invalid: 1, duplicates: 1, totalRupees: 1500, budgetRupees: 5000, overBudget: false,
  perBrand: [{ brandKey: 'AMAZON', brand: 'AMAZON', count: 1, totalRupees: 500 }, { brandKey: 'FLIPKART', brand: 'FLIPKART', count: 1, totalRupees: 1000 }],
  warningCount: 1, skippedBlankRows: 2, skippedFormulaRows: 0, skippedNote: '2 rows skipped: 2 blank', hiddenRowsIncluded: 1,
  hiddenNote: '1 hidden row included (they are hidden in Excel but will be sent)',
};

type Handler = (url: string, init?: RequestInit) => unknown;
let uploadResponse: unknown;
let confirmResponse: unknown | (() => Promise<unknown>);
let createResponse: unknown;
let campaignGet: unknown[];
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(extra?: Handler) {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const hit = extra?.(url, init);
    if (hit) return Promise.resolve(hit);
    if (url === `${BASE}/brands`) return Promise.resolve(ok([
      { key: 'AMAZON', label: 'Amazon Pay', productId: 'p1', minAmount: 100, maxAmount: 10000, denominations: null, denominationType: 'FLEXIBLE', available: true, unavailableReason: null },
      { key: 'FLIPKART', label: 'Flipkart', productId: 'p2', minAmount: null, maxAmount: null, denominations: null, denominationType: null, available: false, unavailableReason: 'Hubble timeout' },
    ]));
    if (url === '/api/gifsy/clients') return Promise.resolve(ok({ clients: [{ id: 'bajaj', slug: 'bajaj', internalName: 'Bajaj Consumer Care', displayName: 'Bajaj', status: 'ACTIVE' }] }));
    if (url === `${BASE}/campaigns/c1/process`) return Promise.resolve(ok({ pass: {}, campaign: { ...CAMPAIGN, status: 'PROCESSING' }, hubbleConfigured: true, summary: {} }));
    if (url === `${BASE}/campaigns` && init?.method === 'POST') return Promise.resolve(createResponse);
    if (url === `${BASE}/campaigns/c1/upload`) return Promise.resolve(uploadResponse);
    if (url === `${BASE}/campaigns/c1/confirm`) {
      return typeof confirmResponse === 'function' ? (confirmResponse as () => Promise<unknown>)() : Promise.resolve(confirmResponse);
    }
    if (url === `${BASE}/campaigns/c1`) {
      const next = campaignGet.length > 1 ? campaignGet.shift() : campaignGet[0];
      return Promise.resolve(next);
    }
    return Promise.resolve(fail(404, `unexpected ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
}

const callsTo = (suffix: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix));

beforeEach(() => {
  searchRef.current = new URLSearchParams();
  createResponse = ok(CAMPAIGN);
  uploadResponse = ok({ campaign: { ...CAMPAIGN, status: 'PREVIEWED' }, rows: ROWS, summary: SUMMARY, previewId: 'pv-42' });
  confirmResponse = ok({ ...CAMPAIGN, status: 'CONFIRMED' });
  campaignGet = [ok({ campaign: { ...CAMPAIGN, status: 'PREVIEWED' }, summary: {} })];
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function fillAndCreate() {
  render(<NewCampaignPage />);
  fireEvent.change(await screen.findByLabelText('Campaign name'), { target: { value: 'Diwali' } });
  // Bill-to client is optional; picking one prefills the programme label (still editable).
  await screen.findByRole('option', { name: 'Bajaj' });
  fireEvent.change(screen.getByLabelText('Bill to client (optional)'), { target: { value: 'bajaj' } });
  expect(screen.getByLabelText('Programme name shown in the WhatsApp message')).toHaveValue('Bajaj Loyalty');
  fireEvent.change(screen.getByLabelText('Budget (₹)'), { target: { value: '5000' } });
  fireEvent.click(screen.getByTestId('vd-create'));
  await screen.findByRole('heading', { name: '2. Upload the list' });
}

async function uploadFile() {
  const file = new File(['x'], 'list.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [file] } });
  expect(screen.getByTestId('vd-file-name')).toHaveTextContent('Selected: list.xlsx');
  fireEvent.click(screen.getByTestId('vd-upload'));
  await screen.findByRole('heading', { name: '3. Check the preview, then buy' });
}

async function openBuyDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Buy & send vouchers' }));
  return screen.findByRole('dialog');
}

describe('New voucher campaign', () => {
  it('validates required fields before creating (no request sent)', { timeout: 20000 }, async () => {
    render(<NewCampaignPage />);
    fireEvent.click(await screen.findByTestId('vd-create'));
    expect(await screen.findByText('Enter a campaign name.')).toBeInTheDocument();
    expect(screen.getByText('Enter the programme name shown in the WhatsApp message.')).toBeInTheDocument();
    expect(screen.getByText('Enter a budget in rupees greater than 0.')).toBeInTheDocument();
    expect(screen.getByText('Whole rupees. The purchase is blocked if the valid rows add up to more than this.')).toBeInTheDocument();
    expect(callsTo('/campaigns')).toHaveLength(0);
    expect(screen.getByTestId('vd-nothing-spent')).toHaveTextContent('Nothing has been bought or sent yet');
  });

  it('create → URL becomes ?campaign=<id> → upload → preview (reasons, filter) → Buy & send dialog → report', { timeout: 20000 }, async () => {
    await fillAndCreate();
    expect(JSON.parse(String(callsTo('/campaigns')[0][1]!.body)))
      .toEqual({ name: 'Diwali', programLabel: 'Bajaj Loyalty', billedToClientId: 'bajaj', budgetRupees: 5000 });
    expect(replace).toHaveBeenCalledWith('/gifsy/voucher-dispersal/new?campaign=c1');

    // Brand help reflects the LIVE limits, including a brand Hubble could not answer for.
    expect(screen.getByTestId('vd-brand-AMAZON')).toHaveTextContent('₹100 to ₹10,000');
    expect(screen.getByTestId('vd-brand-FLIPKART')).toHaveTextContent('not available right now (Hubble timeout)');
    await uploadFile();
    expect(callsTo('/campaigns/c1/upload')[0][1]!.body).toBeInstanceOf(FormData);

    // Summary bar
    expect(screen.getByTestId('vd-sum-valid')).toHaveTextContent('2');
    expect(screen.getByTestId('vd-sum-invalid')).toHaveTextContent('1');
    expect(screen.getByTestId('vd-sum-dupes')).toHaveTextContent('1');
    expect(screen.getByTestId('vd-sum-total')).toHaveTextContent('₹1,500 / ₹5,000');
    expect(screen.getByTestId('vd-summary')).toHaveTextContent('1 invalid row and 1 duplicate row will NOT get a voucher');
    // New server data: warning count (does not block), skipped / hidden notes, per-row amber warning.
    expect(screen.getByTestId('vd-sum-warncount')).toHaveTextContent('1');
    expect(screen.getByTestId('vd-sum-warnings')).toHaveTextContent('This does not block buying');
    expect(screen.getByTestId('vd-sum-skipped')).toHaveTextContent('2 rows skipped: 2 blank');
    expect(screen.getByTestId('vd-sum-hidden')).toHaveTextContent('1 hidden row included');
    expect(screen.getByTestId('vd-prow-warning-2')).toHaveTextContent('Already got a ₹1,000 Amazon Pay voucher on 01 Nov 2026 in campaign "Earlier"');
    expect(screen.getByTestId('vd-buy-send')).toBeEnabled();
    // Every invalid / duplicate row visible with its reason
    expect(within(screen.getByTestId('vd-prow-4')).getByText('Phone must be a 10-digit Indian mobile')).toBeInTheDocument();
    expect(within(screen.getByTestId('vd-prow-5')).getByText('Duplicate of row 2')).toBeInTheDocument();
    // Filter to invalid only
    fireEvent.change(screen.getByLabelText('Show rows'), { target: { value: 'INVALID' } });
    expect(screen.queryByTestId('vd-prow-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('vd-prow-4')).toBeInTheDocument();

    // Buy is on the preview step itself; the nothing-bought note is shown before it.
    expect(screen.getByTestId('vd-nothing-spent')).toBeInTheDocument();
    const dialog = await openBuyDialog();
    expect(dialog).toHaveTextContent('Buy and send 2 vouchers · ₹1,500 total?');
    expect(dialog).toHaveTextContent('Nothing can be undone once vouchers are bought.');
    expect(callsTo('/campaigns/c1/confirm')).toHaveLength(0);
    const btn = within(dialog).getByRole('button', { name: 'Buy & send' });
    fireEvent.click(btn);
    fireEvent.click(btn); // double-click must not double-confirm
    await waitFor(() => expect(push).toHaveBeenCalledWith('/gifsy/voucher-dispersal/c1'));
    expect(callsTo('/campaigns/c1/confirm')).toHaveLength(1);
    expect(JSON.parse(String(callsTo('/campaigns/c1/confirm')[0][1]!.body)))
      .toEqual({ previewId: 'pv-42', expectedValidCount: 2, expectedTotalRupees: 1500 });
    // One processing nudge right after a successful confirm.
    expect(callsTo('/campaigns/c1/process')).toHaveLength(1);
    expect(callsTo('/campaigns/c1/process')[0][1]).toMatchObject({ method: 'POST' });
  });

  it('Cancel in the confirm dialog buys nothing', { timeout: 20000 }, async () => {
    await fillAndCreate();
    await uploadFile();
    const dialog = await openBuyDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(callsTo('/campaigns/c1/confirm')).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });

  it('over budget → red total + reason and Buy is blocked (same condition)', { timeout: 20000 }, async () => {
    uploadResponse = ok({ campaign: CAMPAIGN, rows: ROWS, summary: { ...SUMMARY, totalRupees: 6000, overBudget: false }, previewId: 'pv-1' });
    await fillAndCreate();
    await uploadFile();
    expect(screen.getByTestId('vd-block-reason')).toHaveTextContent('over the ₹5,000 budget');
    expect(screen.getByTestId('vd-buy-send')).toBeDisabled();
    expect(screen.getByTestId('vd-sum-total').className).toMatch(/text-red/);
  });

  it('a preview without a previewId cannot be bought', { timeout: 20000 }, async () => {
    uploadResponse = ok({ campaign: CAMPAIGN, rows: ROWS, summary: SUMMARY });
    await fillAndCreate();
    await uploadFile();
    expect(screen.getByTestId('vd-block-reason')).toHaveTextContent('preview id');
    expect(screen.getByTestId('vd-buy-send')).toBeDisabled();
  });

  it('confirm refusal (4xx, preview changed) is shown verbatim; re-upload offered; nothing-bought stays true', { timeout: 20000 }, async () => {
    const refusal = 'The preview changed since you checked it (3 valid rows, ₹2,000). Upload the file again.';
    confirmResponse = fail(409, refusal);
    await fillAndCreate();
    await uploadFile();
    const dialog = await openBuyDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buy & send' }));
    expect(await within(dialog).findByTestId('vd-dialog-error')).toHaveTextContent(refusal);
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('vd-confirm-error')).toHaveTextContent(refusal);
    expect(screen.getByTestId('vd-nothing-spent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upload the file again' }));
    expect(await screen.findByRole('heading', { name: '2. Upload the list' })).toBeInTheDocument();
  });

  it('5xx on confirm, re-fetch shows it STARTED → goes to the campaign report', { timeout: 20000 }, async () => {
    confirmResponse = fail(504, 'Gateway timeout');
    await fillAndCreate();
    await uploadFile();
    campaignGet = [ok({ campaign: { ...CAMPAIGN, status: 'PROCESSING' }, summary: {} })];
    const dialog = await openBuyDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buy & send' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/gifsy/voucher-dispersal/c1'));
  });

  it('network error on confirm + re-fetch fails → "couldn\'t tell", nothing-bought hidden, Buy disabled; Check again proves setup → re-enabled', { timeout: 20000 }, async () => {
    confirmResponse = () => Promise.reject(new TypeError('Failed to fetch'));
    await fillAndCreate();
    await uploadFile();
    campaignGet = [fail(503, 'Service unavailable'), ok({ campaign: { ...CAMPAIGN, status: 'PREVIEWED' }, summary: {} })];
    const dialog = await openBuyDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buy & send' }));

    const unknown = await screen.findByTestId('vd-outcome-unknown');
    expect(unknown).toHaveTextContent("We couldn't tell whether this started — check the campaign before trying again.");
    await screen.findByRole('button', { name: 'Check again' });
    expect(screen.queryByTestId('vd-nothing-spent')).not.toBeInTheDocument();
    expect(screen.getByTestId('vd-buy-send')).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByTestId('vd-outcome-clear')).toHaveTextContent('still not confirmed, so nothing was bought');
    expect(screen.getByTestId('vd-buy-send')).toBeEnabled();
    expect(callsTo('/campaigns/c1/confirm')).toHaveLength(1);
  });

  it('upload refusal is shown with the server text and no preview appears', { timeout: 20000 }, async () => {
    uploadResponse = fail(400, 'Missing column: brand');
    await fillAndCreate();
    fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [new File(['x'], 'list.xlsx')] } });
    fireEvent.click(screen.getByTestId('vd-upload'));
    expect(await screen.findByTestId('vd-upload-error')).toHaveTextContent('Missing column: brand');
    expect(screen.queryByRole('heading', { name: '3. Check the preview, then buy' })).not.toBeInTheDocument();
  });

  it('client-side file checks: empty file and wrong type are refused before upload', { timeout: 20000 }, async () => {
    await fillAndCreate();
    fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [new File([], 'empty.xlsx')] } });
    expect(screen.getByTestId('vd-file-error')).toHaveTextContent('That file is empty.');
    expect(screen.getByTestId('vd-upload')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [new File(['x'], 'photo.png')] } });
    expect(screen.getByTestId('vd-file-error')).toHaveTextContent('Choose an Excel');
    expect(callsTo('/upload')).toHaveLength(0);
  });

  it('create failure shows the server text; no client chosen → billedToClientId omitted', { timeout: 20000 }, async () => {
    createResponse = fail(400, 'budgetRupees must be a positive number');
    render(<NewCampaignPage />);
    fireEvent.change(await screen.findByLabelText('Campaign name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Programme name shown in the WhatsApp message'), { target: { value: 'Gifsy' } });
    fireEvent.change(screen.getByLabelText('Budget (₹)'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('vd-create'));
    expect(await screen.findByTestId('vd-create-error')).toHaveTextContent('budgetRupees must be a positive number');
    expect(JSON.parse(String(callsTo('/campaigns')[0][1]!.body))).not.toHaveProperty('billedToClientId');
    expect(replace).not.toHaveBeenCalled();
  });

  it('resumes a PREVIEWED campaign at the upload step', { timeout: 20000 }, async () => {
    searchRef.current = new URLSearchParams('campaign=c1');
    render(<NewCampaignPage />);
    expect(await screen.findByRole('heading', { name: '2. Upload the list' })).toBeInTheDocument();
    expect(screen.getByText(/previewed earlier but not confirmed/)).toBeInTheDocument();
  });

  it('a confirmed campaign opened via ?campaign= goes to its report', { timeout: 20000 }, async () => {
    searchRef.current = new URLSearchParams('campaign=c1');
    campaignGet = [ok({ campaign: { ...CAMPAIGN, status: 'PROCESSING' }, summary: {} })];
    render(<NewCampaignPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/gifsy/voucher-dispersal/c1'));
  });
});
