/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/status — upload DEDUCTION rows (negative POINTS; tenant setting
 * creditUploadNegativeDeductions):
 *  - a deduction row shows "−320" + a "Deduction" badge and an "Undo deduction" button (not "Reverse")
 *  - the modal is the undo variant, prefilled with the MAGNITUDE; the POST keeps the POINTS shape
 *  - the expanded batch shows "Credited X pts · Deducted Y pts (N rows)" only when it has deductions
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/credits-payouts/status',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>();
  return { ...actual, useAdminSession: vi.fn() };
});

import { useAdminSession } from '@/lib/admin-session';
import PayoutStatusPage from '../page';

const batch = {
  id: 'b1', batchCode: 'CB-2026-10-001', period: '2026-10', status: 'CONFIRMED', uploadedBy: 'ops',
  uploadedAt: '2026-10-01T00:00:00.000Z', totalOutlets: 2, totalPoints: 500, totalPayoutPaise: 0,
};
const base = { narration: '', status: 'OK', errors: [], awardType: 'POINTS' };
const creditRow    = { ...base, rowNum: 1, outletId: 'O1', outletName: 'Outlet One', fieldId: 'f1', fieldName: 'Volume', amount: 500 };
const deductionRow = { ...base, rowNum: 2, outletId: 'O2', outletName: 'Outlet Two', fieldId: 'f2', fieldName: 'Target', amount: -320 };

const LINE = { outletId: 'O2', fieldId: 'f2', points: 320, givenBack: 0, undoBlockedReason: null as string | null };
const ok = (payload: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => payload });

function mockApi(rows: unknown[], extra: Record<string, unknown> = { deductionLines: [LINE] }) {
  const posts: Array<Record<string, unknown>> = [];
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/reversal-engine/wallets-in-debt')) {
      return ok({ success: true, data: { total: 0, totalOwedPoints: 0, limit: 1000, anyNegative: false, program: null, wallets: [] } });
    }
    if (url.includes('/reversal-engine/attention')) {
      return ok({ success: true, data: {
        readiness: { unsequencedWithHistory: 0, blocked: 0, ready: true, message: null },
        pause: { paused: false, since: null, by: null, reason: null },
        wallets: [], walletsTotal: 0, unmappedCredits: [], unmappedTotal: 0, owedClawbacks: [], owedTotal: 0,
      } });
    }
    if (url.includes('/attachments')) return ok({ success: true, data: { attachments: [] } });
    if (url.startsWith('/api/admin/credits/batches?')) {
      return ok({ success: true, data: { batches: [batch], pagination: { page: 1, limit: 50, total: 1, pages: 1 } } });
    }
    if (url.endsWith('/reversals') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return ok({ success: true, data: { id: 'r1' } });
    }
    if (/\/api\/admin\/credits\/batches\/b1$/.test(url)) return ok({ success: true, data: { ...batch, rows, ...extra } });
    return ok({ success: true, data: null });
  }) as unknown as typeof fetch;
  return { posts };
}

describe('Payout status — upload deduction rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'CLIENT_ADMIN', clientId: 'bajaj', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('a deduction row reads "−320" + Deduction badge + "Undo deduction"; the credit row keeps "Reverse"', async () => {
    mockApi([creditRow, deductionRow]);
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));

    expect(await screen.findByRole('button', { name: /Undo deduction/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Reverse$/ })).toHaveLength(1);
    expect(screen.getByText('−320')).toBeInTheDocument();
    expect(screen.getByText('Deduction')).toBeInTheDocument();
    expect(screen.getByTestId('batch-credit-deduct-totals'))
      .toHaveTextContent('Credited 500 pts · Deducted 320 pts (1 row)');
  });

  it('Undo deduction opens the undo modal with the magnitude and posts the POINTS shape', async () => {
    const api = mockApi([creditRow, deductionRow]);
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    fireEvent.click(await screen.findByRole('button', { name: /Undo deduction/ }));

    const dialog = await screen.findByRole('dialog');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Request undo of deduction');
    expect(screen.getByText('Deducted')).toBeInTheDocument();
    expect(screen.queryByText('Original Amount')).toBeNull();
    expect(screen.getByText('Points to give back (pts)')).toBeInTheDocument();
    expect(screen.getByText(/Gives the deducted points back to the wallet that was charged/)).toBeInTheDocument();
    expect(screen.queryByText(/taken back from the wallet/)).toBeNull();
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('320');

    fireEvent.click(screen.getByRole('button', { name: 'Submit Undo Request' }));
    expect(await screen.findByText('Undo request submitted — awaiting Gifsy approval.')).toBeInTheDocument();
    expect(api.posts[0]).toMatchObject({
      outletId: 'O2', fieldId: 'f2', awardType: 'POINTS', originalPaise: 320, requestedPaise: 320,
    });
  });

  it('an undo above the deducted magnitude is refused client-side', async () => {
    const api = mockApi([deductionRow]);
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    fireEvent.click(await screen.findByRole('button', { name: /Undo deduction/ }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Undo Request' }));
    expect(await screen.findByText('Amount cannot exceed 320 pts.')).toBeInTheDocument();
    expect(api.posts).toHaveLength(0);
  });

  it('a credit-only batch has no totals line and no deduction copy', async () => {
    mockApi([creditRow]);
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    await screen.findByRole('button', { name: /^Reverse$/ });
    expect(screen.queryByTestId('batch-credit-deduct-totals')).toBeNull();
    expect(screen.queryByText('Deduction')).toBeNull();
    expect(screen.queryByRole('button', { name: /Undo deduction/ })).toBeNull();
  });
});

describe('Payout status — undo only on ACTUAL deductions (deductionLines) + not-applied list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'CLIENT_ADMIN', clientId: 'bajaj', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('a negative row with no deductionLine reads "Not deducted" and has no button', async () => {
    mockApi([creditRow, deductionRow], {});
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    expect(await screen.findByTestId('row-not-deducted')).toHaveTextContent('Not deducted');
    expect(screen.queryByRole('button', { name: /Undo deduction/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Reverse$/ })).toHaveLength(1); // the credit row only
    expect(screen.getByTestId('batch-credit-deduct-totals')).toHaveTextContent('Credited 500 pts · Deducted 0 pts (0 rows)');
  });

  it('undoBlockedReason → the button is disabled with the reason as visible text', async () => {
    const reason = 'This deduction has already been repaid by later points — correct it with a manual wallet adjustment.';
    mockApi([deductionRow], { deductionLines: [{ ...LINE, undoBlockedReason: reason }] });
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    const btn = await screen.findByRole('button', { name: /Undo deduction/ });
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('undo-blocked-reason')).toHaveTextContent(reason);
    expect(btn).toHaveAttribute('aria-describedby', screen.getByTestId('undo-blocked-reason').id);
  });

  it('prefill = points − givenBack; the cap is what is still deducted', async () => {
    const api = mockApi([deductionRow], { deductionLines: [{ ...LINE, givenBack: 120 }] });
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    fireEvent.click(await screen.findByRole('button', { name: /Undo deduction/ }));
    await screen.findByRole('dialog');
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('200');
    expect(screen.getByText('Already given back')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '201' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Undo Request' }));
    expect(await screen.findByText('Amount cannot exceed 200 pts.')).toBeInTheDocument();
    expect(api.posts).toHaveLength(0);
  });

  it('notApplied → a "Not applied (N)" list with reasons', async () => {
    mockApi([creditRow], {
      notApplied: [
        { outletId: 'O9', fieldName: 'Target', points: -50, reason: 'OUTLET_NOT_LINKED_TO_PARTNER', kind: 'DEDUCTION' },
        { outletId: 'O8', fieldName: 'Volume', points: 70, reason: 'OUTLET_NOT_FOUND' },
      ],
      acknowledged: ['NOT_APPLIED'],
    });
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    const box = await screen.findByTestId('batch-not-applied');
    expect(box).toHaveTextContent('Not applied (2)');
    expect(box).toHaveTextContent('O9 · Target · −50 pts · NOT deducted — Outlet is not linked to a partner account');
    expect(box).toHaveTextContent('O8 · Volume · 70 pts · NOT credited — Outlet ID not found in this tenant');
  });
});

describe('Payout status — U9: every deduction row is reachable for Undo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'CLIENT_ADMIN', clientId: 'bajaj', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('25 credits then a deduction (row 26): hidden by the 20-row cut; "Deductions only" shows it with Undo', async () => {
    const credits = Array.from({ length: 25 }, (_, i) => ({ ...creditRow, rowNum: i + 1, outletId: `C${i}`, fieldId: `fc${i}` }));
    mockApi([...credits, { ...deductionRow, rowNum: 26 }]);
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    await screen.findAllByRole('button', { name: /^Reverse$/ });
    expect(screen.queryByRole('button', { name: /Undo deduction/ })).toBeNull();
    expect(screen.getByText(/tick "Deductions only" to see every deduction row/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Deductions only (shows every deduction row)'));
    expect(await screen.findByRole('button', { name: /Undo deduction/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^Reverse$/ })).toBeNull();
  });

  it('a credit-only batch has no "Deductions only" filter', async () => {
    mockApi([creditRow]);
    render(<PayoutStatusPage />);
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    await screen.findByRole('button', { name: /^Reverse$/ });
    expect(screen.queryByLabelText(/Deductions only/)).toBeNull();
  });
});
