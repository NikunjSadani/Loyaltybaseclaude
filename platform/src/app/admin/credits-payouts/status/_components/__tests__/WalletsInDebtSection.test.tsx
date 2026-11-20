/// <reference types="vitest/globals" />
/**
 * Wallets below zero — audit item 9 + fix rounds 3/4 (no silent pass-throughs): every wallet below zero with the
 * reversal(s) behind it (one line per allocation), totals from the API, a programme filter, a complete-or-loudly-cut
 * Excel (clean table + "About" sheet), a busy export button, nothing when there is none, a loud error on failure.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import * as XLSX from 'xlsx';

vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));
import { downloadBlob } from '@/lib/download';
import WalletsInDebtSection, { buildWalletsInDebtXlsx, type DebtWallet } from '../WalletsInDebtSection';

const SRC = {
  creditReversalId: 'REV1', kind: 'OVER_REVERSAL', owedPoints: 2986, debtRestoredPoints: 0,
  approvedAt: '2026-11-19T06:00:00.000Z', fieldName: 'Volume', period: '2026-10', outletCode: 'O1',
};
const W: DebtWallet[] = [
  {
    walletId: 'w1', partnerName: 'Shop One', outletCodes: ['O1'], balance: -3086, debtPoints: 3086, owedPoints: 3086, note: null,
    // one reversal touching TWO positions of the wallet → two lines (no duplicate React keys)
    sources: [{ ...SRC, allocationId: 'al1' }, { ...SRC, allocationId: 'al2', owedPoints: 100 }],
  },
  { walletId: 'w2', partnerName: 'Shop Two', outletCodes: ['O2'], balance: -841, debtPoints: 841, owedPoints: 841, note: 'No reversal behind it — negative from imported / earlier history', sources: [] },
];

function stub(byUrl: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => ({ ok: true, status: 200, json: async () => byUrl(String(u)) })));
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('WalletsInDebtSection', () => {
  it('summary from the FULL totals, one line per allocation, programme filter refetches, complete Excel with a busy button', async () => {
    stub((u) => ({
      success: true,
      data: u.includes('programName=Gold')
        ? { total: 1, totalOwedPoints: 841, truncated: false, limit: 1000, availablePrograms: ['Gold', 'Silver'], wallets: [W[1]] }
        : { total: 3, totalOwedPoints: 5000, truncated: true, limit: u.includes('limit=5000') ? 5000 : 2, availablePrograms: ['Gold', 'Silver'], wallets: W },
    }));
    render(<WalletsInDebtSection />);
    expect((await screen.findByTestId('wallets-in-debt-summary')).textContent).toBe('3 wallets below zero · 5,000 pts owed (first 2 listed)');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const lines = screen.getByTestId('debt-wallet-w1').querySelectorAll('li');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain('Reversal took more than the wallet held — 2,986 pts (O1 · Volume · 2026-10) · reversal REV1');
    expect(screen.getByTestId('debt-wallet-w2').textContent).toContain('negative from imported');

    fireEvent.click(screen.getByRole('button', { name: /Excel/ }));
    expect(screen.getByRole('button', { name: /Preparing/ })).toBeDisabled(); // no double download
    await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'wallets-below-zero.xlsx');
    expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).includes('limit=5000'))).toBe(true);
    expect((await screen.findByTestId('wallets-in-debt-export-msg')).textContent).toBe(
      'The file has the first 2 of 3 wallets (see its "About" sheet) — choose a programme to get the rest.',
    );

    fireEvent.change(screen.getByTestId('wallets-in-debt-program'), { target: { value: 'Gold' } });
    expect((await screen.findByText('1 wallet below zero · 841 pts owed')).textContent).toBeTruthy();
    expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).includes('programName=Gold'))).toBe(true);
  });

  it('the Excel is a clean table (header first, per-source points + source outlet code); a cut file says so on an "About" sheet', () => {
    const wb = XLSX.read(buildWalletsInDebtXlsx(W, { total: 9, program: 'Gold' }), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Wallets below zero'], { header: 1 });
    expect(rows[0]).toEqual([
      'Wallet outlet code(s)', 'Outlet / partner', 'Balance (pts)', 'Owed (pts)',
      'Source', 'Source points', 'Source outlet code', 'Reversal', 'Approved on', 'Field', 'Period',
    ]);
    expect(rows[1]).toEqual(expect.arrayContaining(['O1', 'Shop One', -3086, 3086, 'Reversal took more than the wallet held', 2986, 'O1', 'REV1', 'Volume', '2026-10']));
    expect(rows[2]).toEqual(expect.arrayContaining([100]));
    expect(rows[3]).toEqual(expect.arrayContaining(['O2', 'Shop Two', -841, 'No reversal behind it — negative from imported / earlier history']));
    const about = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.About, { header: 1 });
    expect(about).toEqual([['Programme: Gold'], ['This file has the first 2 of 9 wallets — choose a programme to get the rest.']]);
    expect(XLSX.read(buildWalletsInDebtXlsx(W), { type: 'array' }).SheetNames).toEqual(['Wallets below zero']);
  });

  it('nothing below zero → renders nothing; a failed load → a visible error', async () => {
    stub(() => ({ success: true, data: { total: 0, totalOwedPoints: 0, limit: 1000, wallets: [] } }));
    const { container, unmount } = render(<WalletsInDebtSection />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
    unmount();
    stub(() => ({ success: false, error: 'boom' }));
    render(<WalletsInDebtSection />);
    expect((await screen.findByTestId('wallets-in-debt-error')).textContent).toBe('boom');
  });
});
