/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/payout — UTR preview/apply with a NON-JSON response.
 *
 * Money path. A proxied upload body over the proxy cap is truncated → ~30 s later the page gets
 * a plain-text "Internal Server Error". Before: `await res.json()` threw with no try/catch, so the
 * "Applying…" spinner never stopped. Now: the spinner stops and the operator gets an honest
 * "couldn't confirm" message (the apply may or may not have committed).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/credits-payouts/payout',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>();
  return { ...actual, useAdminSession: vi.fn() };
});

import { useAdminSession } from '@/lib/admin-session';
import PayoutDownloadPage from '../page';

const DOWNLOAD = {
  id: 'd1',
  downloadCode: 'PD-2026-06-001',
  period: '2026-06',
  groupType: 'STANDARD',
  status: 'PARTIALLY_PAID',
  downloadedAt: '2026-06-26T00:00:00.000Z',
  totalAmountPaise: 1000000,
  _count: { entries: 1 },
};

const PREVIEW = {
  headerError: null,
  problemRows: [] as unknown[],
  problemRowCount: 0,
  problemRowsTruncated: false,
  hasErrors: false,
  canProceed: true,
  summary: { total: 1, ok: 1, skipped: 0, errors: 0, paidCount: 1, failedCount: 0 },
};

const json = (payload: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => payload, blob: async () => new Blob() });

/** What the proxy hands back after a truncated body: plain text, not JSON. */
const plainText = (status: number) =>
  Promise.resolve({
    ok: false,
    status,
    statusText: 'Internal Server Error',
    json: async () => {
      throw new SyntaxError(`Unexpected token 'I', "Internal S"... is not valid JSON`);
    },
  });

function mockFetch(opts: { preview?: () => Promise<unknown>; apply?: () => Promise<unknown> }) {
  global.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/reversals')) return json({ success: true, data: { reversals: [], pagination: null } });
    if (url.includes('/fields')) return json({ success: true, data: [] });
    if (url.includes('/utr?apply=true')) return (opts.apply ?? (() => json({ success: true, data: {} })))();
    if (url.includes('/utr')) return (opts.preview ?? (() => json({ success: true, data: { parseResult: PREVIEW } })))();
    if (url.includes('/payout-downloads')) return json({ success: true, data: [DOWNLOAD] });
    return json({ success: true, data: [] });
  }) as unknown as typeof fetch;
}

async function selectAndUpload(container: HTMLElement) {
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'd1' } });
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([1])], 'utr.xlsx')] } });
}

describe('Payout UTR — non-JSON responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'GIFSY_ADMIN',
      clientId: 'gifsy',
      name: 'Test Admin',
      userId: '',
      canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('APPLY: plain-text 500 → spinner stops and an honest "couldn\'t confirm" message shows', async () => {
    mockFetch({ apply: () => plainText(500) });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText('Apply UTR Results'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn't confirm whether the UTRs were applied/i);
    expect(alert.textContent).toMatch(/check this payout file's status before trying again/i);
    expect(alert.textContent).toMatch(/Re-applying the same UTR file is safe/);
    expect(alert.textContent).not.toMatch(/SyntaxError|Unexpected token/);
    // Spinner ended: the button is back to its idle label and enabled.
    const btn = screen.getByText('Apply UTR Results').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.queryByText('Applying…')).toBeNull();
    // Never claims success.
    expect(screen.queryByText('UTR results applied')).toBeNull();
  });

  it('APPLY: network failure → spinner stops with the same honest message', async () => {
    mockFetch({ apply: () => Promise.reject(new TypeError('Failed to fetch')) });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText('Apply UTR Results'));

    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn't confirm/i);
    expect(screen.queryByText('Applying…')).toBeNull();
  });

  it('APPLY: a JSON 400 error is now visible (was hidden behind the preview)', async () => {
    mockFetch({
      apply: () =>
        Promise.resolve({ ok: false, status: 400, json: async () => ({ success: false, error: 'Cannot apply — parse result has errors' }) }),
    });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText('Apply UTR Results'));
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot apply — parse result has errors');
  });

  it('PREVIEW: plain-text 500 → "Parsing file…" stops and a readable message shows', async () => {
    mockFetch({ preview: () => plainText(500) });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);

    expect(await screen.findByText(/didn't respond properly \(HTTP 500\)/)).toBeTruthy();
    expect(screen.getByText(/Nothing was saved/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Parsing file…')).toBeNull());
  });

  it('PREVIEW: non-JSON 413 → says the file is too large', async () => {
    mockFetch({ preview: () => plainText(413) });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    expect(await screen.findByText(/file is too large/i)).toBeTruthy();
  });
});
