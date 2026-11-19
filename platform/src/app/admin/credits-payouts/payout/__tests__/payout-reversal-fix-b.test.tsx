/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/payout — Wallet Reversal Engine fix round B:
 *  - #1 bank-file notices come from the summary JSON endpoint (no headers needed): held entries, TDS credit applied
 *    (incl. "another programme"), TDS adjustments; #18 cleared when the period changes.
 *  - D5 approve/reject send the typed remarks; requestRemarks + decision remarks are shown.
 *  - #8 Approve disabled while a held entry is PROCESSING, with the reason visible.
 *  - #16 a stale outcome is cleared when a new decision starts; #20 focus moves to the outcome.
 *  - L1/L3/L5 processed entries: owed back net of TDS + TDS credit; fully withheld → "₹0.00 owed back".
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

vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));

import { useAdminSession } from '@/lib/admin-session';
import PayoutDownloadPage from '../page';

const base = {
  outletId: 'O1', outletName: 'Outlet One', fieldName: 'Volume', period: '2026-10', awardType: 'PAYOUT',
  originalPaise: 80000, requestedAt: '2026-11-15T00:00:00.000Z', status: 'PENDING_GIFSY',
};

const SUMMARY = {
  downloadId: 'd1', downloadCode: 'PD-1', period: '2026-10', createdAt: '2026-11-16T00:00:00.000Z',
  reversalHeld: {
    count: 1, paise: 50000,
    entries: [{ entryId: 'pe-h', outletId: 'O9', outletName: 'Held Shop', fieldName: 'Volume', amountPaise: 50000, status: 'PENDING', creditReversalId: 'r1' }],
  },
  tdsCreditApplied: {
    count: 1, paise: 20000,
    lines: [{
      entryId: 'pe-c', outletId: 'O2', outletName: 'Credit Shop', duePaise: 20000, creditPaise: 20000, withheldPaise: 0,
      otherProgrammePaise: 5000, panMasked: 'XXXXX1234F', note: '₹200.00 TDS covered by credit — ₹50.00 from another programme on this PAN',
    }],
  },
  tdsAdjustments: {
    count: 1, paise: 4500,
    lines: [{ entryId: 'pe-d', outletId: 'O3', outletName: 'Below Shop', panMasked: 'XXXXX9999Z', handBackPaise: 4500, note: '₹45.00 less TDS: adjusted after a reversal brought PAN below the limit' }],
  },
};

let pending: unknown[] = [];
let processed: unknown[] = [];
let summaryResponse: unknown = { success: true, data: SUMMARY };
let patchResolvers: Array<(v: unknown) => void> = [];
let patchData: unknown = null;
let deferPatch = false;
const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
const summaryCalls: string[] = [];

function install() {
  const json = (payload: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => payload, blob: async () => new Blob() });
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/admin/credits/payout-downloads' && init?.method === 'POST') {
      // No custom headers at all — as when the proxy strips them.
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), blob: async () => new Blob(), json: async () => ({}) });
    }
    if (url.includes('/latest-summary') || url.endsWith('/summary')) {
      summaryCalls.push(url);
      return json(summaryResponse);
    }
    if (url.includes('/reversals/') && init?.method === 'PATCH') {
      patches.push({ url, body: JSON.parse(String(init.body)) });
      if (deferPatch) return new Promise((resolve) => patchResolvers.push(resolve)).then(() => json({ success: true, data: patchData }));
      return json({ success: true, data: patchData });
    }
    if (url.includes('/reversals') && url.includes('PENDING_GIFSY')) {
      return json({ success: true, data: { reversals: pending, pagination: { page: 1, limit: 50, total: pending.length, pages: 1 } } });
    }
    if (url.includes('/reversals') && url.includes('APPROVED')) {
      return json({ success: true, data: { reversals: processed, pagination: { page: 1, limit: 50, total: processed.length, pages: 1 } } });
    }
    return json({ success: true, data: [] });
  }) as unknown as typeof fetch;
}

describe('Payout page — reversal fix round B', () => {
  beforeEach(() => {
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
    pending = [];
    processed = [];
    summaryResponse = { success: true, data: SUMMARY };
    patchResolvers = [];
    patchData = null;
    deferPatch = false;
    patches.length = 0;
    summaryCalls.length = 0;
    install();
  });

  it('#1: notices come from the summary JSON endpoint when the headers are stripped', async () => {
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Generate & Download/ }));
    const held = await screen.findByTestId('reversal-held-notice');
    expect(summaryCalls[0]).toMatch(/\/latest-summary\?period=\d{4}-\d{2}&groupType=STANDARD$/);
    expect(held.textContent).toContain('1 payout entry (₹500.00) was held out of this bank file');
    expect(held.textContent).toContain('Held Shop (O9) · Volume · ₹500.00');

    const credit = screen.getByTestId('tds-credit-applied-notice');
    expect(credit.textContent).toContain('₹200.00 of TDS on 1 payout entry was adjusted from earlier TDS credit');
    expect(credit.textContent).toContain('Credit Shop · PAN XXXXX1234F · ₹200.00 credit used');
    expect(credit.textContent).toContain('another programme · ₹50.00');
    expect(credit.textContent).toContain('₹200.00 TDS covered by credit — ₹50.00 from another programme on this PAN');
    expect(credit.querySelector('[role="img"]')!.getAttribute('aria-label')).toMatch(/TDS credit/);

    const adj = screen.getByTestId('tds-adjustment-notice');
    expect(adj.textContent).toContain('₹45.00 less TDS on 1 payout entry');
    expect(adj.textContent).toContain('₹45.00 less TDS: adjusted after a reversal brought PAN below the limit');
  });

  it('#18: changing the period clears the notices', async () => {
    const { container } = render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Generate & Download/ }));
    await screen.findByTestId('reversal-held-notice');
    fireEvent.change(container.querySelector('input[type="month"]')!, { target: { value: '2026-01' } });
    await waitFor(() => expect(screen.queryByTestId('reversal-held-notice')).toBeNull());
    expect(screen.queryByTestId('tds-credit-applied-notice')).toBeNull();
    expect(screen.queryByTestId('tds-adjustment-notice')).toBeNull();
  });

  it('#1: a summary with nothing held/adjusted shows no notices', async () => {
    summaryResponse = {
      success: true,
      data: { ...SUMMARY, reversalHeld: { count: 0, paise: 0, entries: [] }, tdsCreditApplied: { count: 0, paise: 0, lines: [] }, tdsAdjustments: { count: 0, paise: 0, lines: [] } },
    };
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Generate & Download/ }));
    await waitFor(() => expect(summaryCalls).toHaveLength(1));
    expect(screen.queryByTestId('reversal-held-notice')).toBeNull();
    expect(screen.queryByTestId('tds-credit-applied-notice')).toBeNull();
  });

  it('D5: approve and reject send the typed remarks; the requester note is shown on the card', async () => {
    pending = [
      { ...base, id: 'r1', requestedPaise: 20000, requestRemarks: 'Duplicate credit for October' },
      { ...base, id: 'r2', requestedPaise: 30000 },
    ];
    patchData = { id: 'r1', status: 'APPROVED' };
    render(<PayoutDownloadPage />);
    expect((await screen.findByTestId('request-remarks-r1')).textContent).toBe("Requester's note: Duplicate credit for October");
    fireEvent.click(screen.getAllByRole('button', { name: /^Approve$/ })[0]);
    fireEvent.change(screen.getByLabelText('Remarks (optional)'), { target: { value: '  checked with ASM ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ url: '/api/admin/credits/reversals/r1', body: { action: 'approve', remarks: 'checked with ASM' } });

    fireEvent.click(await screen.findAllByRole('button', { name: /^Reject$/ }).then((b) => b[1]));
    fireEvent.change(screen.getByLabelText('Remarks (optional)'), { target: { value: 'not a duplicate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Reject' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ url: '/api/admin/credits/reversals/r2', body: { action: 'reject', remarks: 'not a duplicate' } });
  });

  it('#8: Approve is disabled while a held entry is PROCESSING, with the reason shown; Reject still works', async () => {
    pending = [{
      ...base, id: 'r-proc', requestedPaise: 40000,
      payoutEntries: [{ payoutEntryId: 'pe-p', amountPaise: 40000, allocationState: 'RESERVED', entryStatus: 'PROCESSING' }],
    }];
    render(<PayoutDownloadPage />);
    expect((await screen.findByTestId('processing-block-r-proc')).textContent)
      .toContain('Waiting for the bank result on an entry — record the UTR or the failure first');
    const approve = screen.getByRole('button', { name: /^Approve$/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.getAttribute('aria-describedby')).toBe('processing-block-r-proc');
    expect((screen.getByRole('button', { name: /^Reject$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('#16/#20: a stale outcome is cleared when the next decision starts; focus moves to the new outcome', async () => {
    pending = [{ ...base, id: 'r1', requestedPaise: 20000 }, { ...base, id: 'r2', requestedPaise: 30000 }];
    patchData = {
      payoutOutcome: {
        headline: 'Approved · 1 entry cancelled (₹200.00)', lines: [{ kind: 'CANCELLED', entryId: 'x', text: 'Entry cancelled · ₹200.00' }],
        cancelled: [], receivable: [], receivablePaise: 0, released: [],
      },
    };
    render(<PayoutDownloadPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^Approve$/ }))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));
    const out = await screen.findByTestId('reversal-outcome');
    await waitFor(() => expect(document.activeElement).toBe(out));

    deferPatch = true;
    fireEvent.click(screen.getAllByRole('button', { name: /^Reject$/ })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Reject' }));
    await waitFor(() => expect(screen.queryByTestId('reversal-outcome')).toBeNull());
    expect(screen.getByRole('button', { name: 'Processing…' })).toBeTruthy();
    patchResolvers.forEach((r) => r(null));
    expect(await screen.findByTestId('reversal-outcome')).toBeTruthy();
  });

  it('#17: a network failure on approve never leaves "Processing…" stuck', async () => {
    pending = [{ ...base, id: 'r1', requestedPaise: 20000 }];
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/ }));
    const f = vi.mocked(global.fetch);
    const prev = f.getMockImplementation()!;
    f.mockImplementation(((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PATCH' ? Promise.reject(new TypeError('Failed to fetch')) : prev(input, init)) as typeof fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't reach the server/);
    expect((screen.getByRole('button', { name: 'Confirm Approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('L1/L3/L5: processed reversals show both notes and what happened to each entry (honest when fully withheld)', async () => {
    processed = [{
      ...base, id: 'p1', status: 'APPROVED', requestedPaise: 1500000, approvedPaise: 1500000, shortfallPaise: 0,
      approvedAt: '2026-11-16T00:00:00.000Z', requestRemarks: 'Wrong outlet', remarks: 'Approved after call',
      payoutEntries: [
        { payoutEntryId: 'e1', amountPaise: 1000000, allocationState: 'APPLIED_RECEIVABLE', entryStatus: 'PAID', receivablePaise: 980000, tdsCreditPaise: 20000 },
        { payoutEntryId: 'e2', amountPaise: 300000, allocationState: 'APPLIED_RECEIVABLE', entryStatus: 'PAID', receivablePaise: 0, tdsCreditPaise: 300000 },
        { payoutEntryId: 'e3', amountPaise: 200000, allocationState: 'APPLIED_CANCELLED', entryStatus: 'CANCELLED', tdsOffsetPaise: 0 },
      ],
    }];
    render(<PayoutDownloadPage />);
    const d = await screen.findByTestId('processed-details-p1');
    expect(d.textContent).toContain("Requester's note: Wrong outlet");
    expect(d.textContent).toContain('Decision note: Approved after call');
    expect(d.textContent).toContain('₹10,000.00 entry (was paid) — Owed back · ₹9,800.00 (net of ₹200.00 TDS withheld) · ₹200.00 TDS credit');
    expect(d.textContent).toContain('₹3,000.00 entry (was paid) — ₹0.00 owed back — the whole amount was withheld as TDS; ₹3,000.00 TDS credit');
    expect(d.textContent).toContain('₹2,000.00 entry — cancelled · will not be paid');
  });

  it('B4 / owner D2: a fully withheld PAID payout reversed is "reversed · nothing owed" (+ its TDS credit), never "cancelled"', async () => {
    processed = [{
      ...base, id: 'p2', status: 'APPROVED', requestedPaise: 150000, approvedPaise: 150000, shortfallPaise: 0,
      approvedAt: '2026-11-19T00:00:00.000Z',
      payoutEntries: [
        { payoutEntryId: 'w1', amountPaise: 150000, allocationState: 'APPLIED_CANCELLED', entryStatus: 'REVERSED', tdsOffsetPaise: 0, tdsCreditPaise: 150000, fullyWithheld: true },
      ],
    }];
    render(<PayoutDownloadPage />);
    const d = await screen.findByTestId('processed-details-p2');
    expect(d.textContent).toContain(
      '₹1,500.00 entry (was paid — fully withheld as TDS) — reversed · nothing reached the retailer, nothing owed · ₹1,500.00 TDS credit carried forward',
    );
    expect(d.textContent).not.toContain('cancelled');
  });
});
