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
    expect(alert.textContent).toBe(
      "We couldn't confirm whether the UTRs were applied. Refresh and check this payout file's status first — " +
        'if it shows Paid, it went through. If you still need to apply, upload the file again to re-check it; ' +
        're-applying the same file is safe (rows already applied are skipped and no one is notified twice).',
    );
    expect(alert.textContent).not.toMatch(/SyntaxError|Unexpected token/);
    // Spinner ended, but Apply is PAUSED until the file is previewed again.
    const btn = screen.getByText('Apply UTR Results').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId('utr-apply-paused-hint').textContent).toMatch(/upload the file again/i);
    expect(screen.queryByText('Applying…')).toBeNull();
    // Never claims success.
    expect(screen.queryByText('UTR results applied')).toBeNull();
  });

  it('APPLY: network failure → same honest message; Apply stays disabled until a fresh preview re-enables it', async () => {
    let applyCalls = 0;
    mockFetch({
      apply: () => {
        applyCalls += 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      },
    });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText('Apply UTR Results'));

    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn't confirm/i);
    expect(screen.queryByText('Applying…')).toBeNull();
    const btn = () => screen.getByText('Apply UTR Results').closest('button') as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    // A click on the disabled button does nothing.
    fireEvent.click(btn());
    expect(applyCalls).toBe(1);
    // The file input was cleared so re-picking the SAME file fires onChange.
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.value).toBe('');

    // Re-preview the file → Apply is enabled again and the paused hint is gone.
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([1])], 'utr.xlsx')] } });
    await waitFor(() => expect(btn().disabled).toBe(false));
    expect(screen.queryByTestId('utr-apply-paused-hint')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('APPLY: a non-JSON 413 never reached the API → too-large message and Apply is NOT paused', async () => {
    mockFetch({ apply: () => plainText(413) });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText('Apply UTR Results'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/file is too large/i);
    const btn = screen.getByText('Apply UTR Results').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
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

  it('PREVIEW noop (every row already applied) → neutral "already applied" note', async () => {
    mockFetch({ preview: () => json({ success: true, data: { parseResult: { ...PREVIEW, noop: true } } }) });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    expect((await screen.findByTestId('utr-noop-preview')).textContent).toBe(
      'This file has already been applied — nothing will change.',
    );
  });

  it('PREVIEW without noop → no "already applied" note', async () => {
    mockFetch({});
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    await screen.findByText('Apply UTR Results');
    expect(screen.queryByTestId('utr-noop-preview')).toBeNull();
  });

  it('APPLY noop → shows the server message, never the green "UTR results applied" banner', async () => {
    mockFetch({
      apply: () =>
        json({
          success: true,
          data: { applied: true, noop: true, paidCount: 0, failedCount: 0, skippedCount: 3, message: 'Already applied — nothing to change' },
        }),
    });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText('Apply UTR Results'));
    const note = await screen.findByTestId('utr-apply-noop');
    expect(note.textContent).toMatch('Already applied — nothing to change');
    expect(screen.queryByText('UTR results applied')).toBeNull();
    expect(screen.queryByText(/0 paid · 0 failed/)).toBeNull();
  });

  it('PREVIEW: a SKIP row shows the server `notice`; without one it falls back to the old text', async () => {
    const skip = (rowNum: number, outletId: string, notice?: string) => ({
      rowNum, outletId, batchId: 'b', utr: '', paymentDate: null, status: 'SKIP', errors: [], ...(notice ? { notice } : {}),
    });
    mockFetch({
      preview: () =>
        json({
          success: true,
          data: {
            parseResult: {
              ...PREVIEW,
              rows: [skip(2, 'O-1', 'Already marked failed — no change.'), skip(3, 'O-2')],
              rowCount: 2,
              rowsTruncated: false,
            },
          },
        }),
    });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText(/Show row details/));
    expect(screen.getByTestId('utr-row-2').textContent).toMatch('Already marked failed — no change.');
    expect(screen.getByTestId('utr-row-2').textContent).not.toMatch('Already paid — no change');
    expect(screen.getByTestId('utr-row-3').textContent).toMatch('Already paid — no change');
  });

  it('APPLY with notApplied rows → amber "These rows were not applied" list, never the green banner', async () => {
    mockFetch({
      apply: () =>
        json({
          success: true,
          data: {
            applied: true, paidCount: 1, failedCount: 0, skippedCount: 0,
            notApplied: [{ outletId: 'O-9', rowNum: 4, reason: 'Payout already recorded' }],
          },
        }),
    });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText('Apply UTR Results'));
    const list = await screen.findByTestId('utr-not-applied');
    expect(list.textContent).toMatch('These rows were not applied:');
    expect(list.textContent).toMatch(/Row 4 · O-9 — Payout already recorded/);
    expect(screen.queryByText('UTR results applied')).toBeNull();
    expect(screen.getByText('Applied with issues')).toBeTruthy();
  });

  it('APPLY noop with notApplied → server message + amber list, no green banner', async () => {
    const message = 'Nothing changed — 2 rows were not applied because the payout was already recorded. Check the payout status.';
    mockFetch({
      apply: () =>
        json({
          success: true,
          data: {
            applied: true, noop: true, paidCount: 0, failedCount: 0, skippedCount: 0, message,
            notApplied: [
              { outletId: 'O-1', rowNum: 2, reason: 'Payout already recorded' },
              { outletId: 'O-2', rowNum: 3, reason: 'Payout already recorded' },
            ],
          },
        }),
    });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText('Apply UTR Results'));
    expect((await screen.findByTestId('utr-apply-noop')).textContent).toMatch(message);
    expect(screen.getByTestId('utr-not-applied').querySelectorAll('li')).toHaveLength(2);
    expect(screen.queryByText('UTR results applied')).toBeNull();
  });

  it('APPLY without notApplied (older API) → normal green banner, no amber list', async () => {
    mockFetch({ apply: () => json({ success: true, data: { paidCount: 1, failedCount: 0, skippedCount: 0 } }) });
    const { container } = render(<PayoutDownloadPage />);
    await selectAndUpload(container);
    fireEvent.click(await screen.findByText('Apply UTR Results'));
    expect(await screen.findByText('UTR results applied')).toBeTruthy();
    expect(screen.queryByTestId('utr-not-applied')).toBeNull();
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
