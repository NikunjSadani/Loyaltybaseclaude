/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — new campaign flow: details → create → upload → preview → typed-phrase confirm.
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

const CAMPAIGN = { id: 'c1', name: 'Diwali', programLabel: 'Bajaj Loyalty', billedToClientId: 'bajaj', budgetRupees: 5000, status: 'DRAFT' };
const ROWS = [
  { rowNumber: 2, phone: '9876543210', name: 'Asha', amount: 500, brand: 'AMAZON', status: 'VALID', invalidReason: null },
  { rowNumber: 3, phone: '9876543211', name: 'Ravi', amount: 1000, brand: 'FLIPKART', status: 'VALID', invalidReason: null },
  { rowNumber: 4, phone: '12345', name: 'Bad', amount: 500, brand: 'AMAZON', status: 'INVALID', invalidReason: 'Phone must be a 10-digit Indian mobile' },
  { rowNumber: 5, phone: '9876543210', name: 'Asha again', amount: 500, brand: 'AMAZON', status: 'DUPLICATE', invalidReason: 'Duplicate of row 2' },
];
const SUMMARY = { total: 4, valid: 2, invalid: 1, duplicates: 1, totalRupees: 1500, budgetRupees: 5000, overBudget: false, perBrand: { AMAZON: { count: 1, totalRupees: 500 }, FLIPKART: { count: 1, totalRupees: 1000 } } };

type Handler = (url: string, init?: RequestInit) => unknown;
let uploadResponse: unknown;
let confirmResponse: unknown;
let createResponse: unknown;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(extra?: Handler) {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const hit = extra?.(url, init);
    if (hit) return Promise.resolve(hit);
    if (url === `${BASE}/brands`) return Promise.resolve(ok([{ key: 'AMAZON', label: 'Amazon Pay', productId: 'p1', minAmount: 100, maxAmount: 10000, denominations: null }]));
    if (url === '/api/gifsy/clients') return Promise.resolve(ok({ clients: [{ slug: 'bajaj', internalName: 'Bajaj Consumer Care', displayName: 'Bajaj', status: 'ACTIVE' }] }));
    if (url === `${BASE}/campaigns` && init?.method === 'POST') return Promise.resolve(createResponse);
    if (url === `${BASE}/campaigns/c1/upload`) return Promise.resolve(uploadResponse);
    if (url === `${BASE}/campaigns/c1/confirm`) return Promise.resolve(confirmResponse);
    return Promise.resolve(fail(404, `unexpected ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
}

const callsTo = (suffix: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix));

beforeEach(() => {
  searchRef.current = new URLSearchParams();
  createResponse = ok(CAMPAIGN);
  uploadResponse = ok({ campaign: { ...CAMPAIGN, status: 'PREVIEWED' }, rows: ROWS, summary: SUMMARY });
  confirmResponse = ok({ ...CAMPAIGN, status: 'CONFIRMED' });
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
}

describe('New voucher campaign', () => {
  it('validates required fields before creating (no request sent)', { timeout: 20000 }, async () => {
    render(<NewCampaignPage />);
    fireEvent.click(await screen.findByTestId('vd-create'));
    expect(await screen.findByText('Enter a campaign name.')).toBeInTheDocument();
    expect(screen.getByText('Enter the programme name shown in the WhatsApp message.')).toBeInTheDocument();
    expect(screen.getByText('Enter a budget in rupees greater than 0.')).toBeInTheDocument();
    expect(callsTo('/campaigns')).toHaveLength(0);
    expect(screen.getByTestId('vd-nothing-spent')).toHaveTextContent('Nothing has been bought or sent yet');
  });

  it('create → upload → preview (reasons, filter) → phrase-gated confirm → detail', { timeout: 20000 }, async () => {
    await fillAndCreate();
    const createBody = JSON.parse(String(callsTo('/campaigns')[0][1]!.body));
    expect(createBody).toEqual({ name: 'Diwali', programLabel: 'Bajaj Loyalty', billedToClientId: 'bajaj', budgetRupees: 5000 });

    await uploadFile();
    await screen.findByRole('heading', { name: '3. Check the preview' });
    expect(callsTo('/campaigns/c1/upload')[0][1]!.body).toBeInstanceOf(FormData);

    // Summary bar
    expect(screen.getByTestId('vd-sum-valid')).toHaveTextContent('2');
    expect(screen.getByTestId('vd-sum-invalid')).toHaveTextContent('1');
    expect(screen.getByTestId('vd-sum-dupes')).toHaveTextContent('1');
    expect(screen.getByTestId('vd-sum-total')).toHaveTextContent('₹1,500 / ₹5,000');
    expect(screen.getByTestId('vd-summary')).toHaveTextContent('1 invalid and 1 duplicate rows will NOT get a voucher');
    // Every invalid / duplicate row visible with its reason
    expect(within(screen.getByTestId('vd-prow-4')).getByText('Phone must be a 10-digit Indian mobile')).toBeInTheDocument();
    expect(within(screen.getByTestId('vd-prow-5')).getByText('Duplicate of row 2')).toBeInTheDocument();
    // Filter to invalid only
    fireEvent.change(screen.getByLabelText('Show rows'), { target: { value: 'INVALID' } });
    expect(screen.queryByTestId('vd-prow-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('vd-prow-4')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('vd-to-confirm'));
    await screen.findByRole('heading', { name: '4. Confirm and issue' });
    const phrase = 'Issue 2 vouchers · ₹1,500';
    expect(screen.getByTestId('vd-phrase')).toHaveTextContent(phrase);
    const btn = screen.getByTestId('vd-confirm');
    expect(btn).toBeDisabled();
    const input = screen.getByLabelText('Confirmation phrase');
    fireEvent.change(input, { target: { value: 'Issue 2 vouchers' } });
    expect(btn).toBeDisabled();
    fireEvent.change(input, { target: { value: phrase } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    fireEvent.click(btn); // double-click must not double-confirm
    await waitFor(() => expect(push).toHaveBeenCalledWith('/gifsy/voucher-dispersal/c1'));
    expect(callsTo('/campaigns/c1/confirm')).toHaveLength(1);
    expect(JSON.parse(String(callsTo('/campaigns/c1/confirm')[0][1]!.body))).toEqual({ confirmText: phrase });
  });

  it('over budget → red reason and confirm is blocked', { timeout: 20000 }, async () => {
    uploadResponse = ok({ campaign: CAMPAIGN, rows: ROWS, summary: { ...SUMMARY, totalRupees: 6000, overBudget: true } });
    await fillAndCreate();
    await uploadFile();
    expect(await screen.findByTestId('vd-block-reason')).toHaveTextContent('over the ₹5,000 budget');
    expect(screen.getByTestId('vd-to-confirm')).toBeDisabled();
    expect(screen.getByTestId('vd-sum-total').className).toMatch(/text-red/);
  });

  it('upload refusal is shown with the server text and no preview appears', { timeout: 20000 }, async () => {
    uploadResponse = fail(400, 'Missing column: brand');
    await fillAndCreate();
    await uploadFile();
    expect(await screen.findByTestId('vd-upload-error')).toHaveTextContent('Missing column: brand');
    expect(screen.queryByRole('heading', { name: '3. Check the preview' })).not.toBeInTheDocument();
  });

  it('confirm refusal is shown verbatim and the user stays on the step', { timeout: 20000 }, async () => {
    confirmResponse = fail(400, 'Confirmation text does not match.');
    await fillAndCreate();
    await uploadFile();
    fireEvent.click(await screen.findByTestId('vd-to-confirm'));
    fireEvent.change(await screen.findByLabelText('Confirmation phrase'), { target: { value: 'Issue 2 vouchers · ₹1,500' } });
    fireEvent.click(screen.getByTestId('vd-confirm'));
    expect(await screen.findByTestId('vd-confirm-error')).toHaveTextContent('Confirmation text does not match.');
    expect(push).not.toHaveBeenCalled();
  });

  it('create failure shows the server text', { timeout: 20000 }, async () => {
    createResponse = fail(400, 'budgetRupees must be a positive number');
    render(<NewCampaignPage />);
    fireEvent.change(await screen.findByLabelText('Campaign name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Programme name shown in the WhatsApp message'), { target: { value: 'Gifsy' } });
    fireEvent.change(screen.getByLabelText('Budget (₹)'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('vd-create'));
    expect(await screen.findByTestId('vd-create-error')).toHaveTextContent('budgetRupees must be a positive number');
    // No client chosen → billedToClientId is omitted
    expect(JSON.parse(String(callsTo('/campaigns')[0][1]!.body))).not.toHaveProperty('billedToClientId');
  });

  it('resumes a PREVIEWED campaign at the upload step', { timeout: 20000 }, async () => {
    searchRef.current = new URLSearchParams('campaign=c1');
    installFetch((url) => (url === `${BASE}/campaigns/c1` ? ok({ campaign: { ...CAMPAIGN, status: 'PREVIEWED' }, summary: {} }) : null));
    render(<NewCampaignPage />);
    expect(await screen.findByRole('heading', { name: '2. Upload the list' })).toBeInTheDocument();
    expect(screen.getByText(/previewed earlier but not confirmed/)).toBeInTheDocument();
  });

  it('a confirmed campaign opened via ?campaign= goes to its report', { timeout: 20000 }, async () => {
    searchRef.current = new URLSearchParams('campaign=c1');
    installFetch((url) => (url === `${BASE}/campaigns/c1` ? ok({ campaign: { ...CAMPAIGN, status: 'PROCESSING' }, summary: {} }) : null));
    render(<NewCampaignPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/gifsy/voucher-dispersal/c1'));
  });
});
