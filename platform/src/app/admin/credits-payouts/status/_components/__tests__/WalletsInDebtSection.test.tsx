/// <reference types="vitest/globals" />
/**
 * Wallets in debt — audit item 9 (2026-11-19, no silent pass-throughs): every wallet in debt with the reversal(s)
 * behind it, an Excel download, nothing when there is none, and a loud error when the list can't be loaded.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import * as XLSX from 'xlsx';

vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));
import { downloadBlob } from '@/lib/download';
import WalletsInDebtSection, { buildWalletsInDebtXlsx, type DebtWallet } from '../WalletsInDebtSection';

const W: DebtWallet[] = [
  {
    walletId: 'w1', partnerName: 'Shop One', outletCodes: ['O1'], balance: -2986, debtPoints: 2986, owedPoints: 2986, note: null,
    sources: [{
      creditReversalId: 'REV1', kind: 'OVER_REVERSAL', owedPoints: 2986, debtRestoredPoints: 0,
      approvedAt: '2026-11-19T06:00:00.000Z', fieldName: 'Volume', period: '2026-10', outletCode: 'O1',
    }],
  },
  { walletId: 'w2', partnerName: 'Shop Two', outletCodes: ['O2'], balance: -841, debtPoints: 841, owedPoints: 841, note: 'No reversal behind it — negative from imported / earlier history', sources: [] },
];

function stub(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('WalletsInDebtSection', () => {
  it('summary from the FULL totals (B4), the list with the reversal behind each wallet, and a complete Excel download', async () => {
    // 3 wallets below zero, 5,000 owed in all — only 2 rows returned (truncated): the summary uses the totals
    stub({ success: true, data: { total: 3, totalOwedPoints: 5000, truncated: true, limit: 2, wallets: W } });
    render(<WalletsInDebtSection />);
    expect((await screen.findByTestId('wallets-in-debt-summary')).textContent).toBe('3 wallets below zero · 5,000 pts owed (first 2 listed)');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const r1 = screen.getByTestId('debt-wallet-w1');
    expect(r1.textContent).toContain('−2,986 pts');
    expect(r1.textContent).toContain('Reversal took more than the wallet held — 2,986 pts (O1 · Volume · 2026-10) · reversal REV1');
    expect(screen.getByTestId('debt-wallet-w2').textContent).toContain('negative from imported');
    fireEvent.click(screen.getByRole('button', { name: /Excel/ }));
    await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'wallets-in-debt.xlsx'));
    // the export asks for everything it may (limit 5,000) and says when the file is still cut
    expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).includes('limit=5000'))).toBe(true);
    expect((await screen.findByTestId('wallets-in-debt-export-msg')).textContent).toBe(
      'The file has the first 2 of 3 wallets (it says so on its first line).',
    );
  });

  it('the Excel has one row per wallet × source, and a first-line note when it is not complete', () => {
    const wb = XLSX.read(buildWalletsInDebtXlsx(W), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Wallets in debt'], { header: 1 });
    expect(rows[0]).toEqual(['Outlet code(s)', 'Outlet / partner', 'Balance (pts)', 'Owed (pts)', 'Source', 'Reversal', 'Approved on', 'Field', 'Period']);
    expect(rows[1]).toEqual(expect.arrayContaining(['O1', 'Shop One', -2986, 2986, 'Reversal took more than the wallet held', 'REV1', 'Volume', '2026-10']));
    expect(rows[2]).toEqual(expect.arrayContaining(['O2', 'Shop Two', -841, 'No reversal behind it — negative from imported / earlier history']));
    const cut = XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(buildWalletsInDebtXlsx(W, { total: 9 }), { type: 'array' }).Sheets['Wallets in debt'], { header: 1 });
    expect(cut[0]).toEqual(['First 2 of 9 wallets — narrow by programme to get the rest']);
  });

  it('nothing in debt → renders nothing; a failed load → a visible error', async () => {
    stub({ success: true, data: { total: 0, limit: 1000, wallets: [] } });
    const { container, unmount } = render(<WalletsInDebtSection />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
    unmount();
    stub({ success: false, error: 'boom' });
    render(<WalletsInDebtSection />);
    expect((await screen.findByTestId('wallets-in-debt-error')).textContent).toBe('boom');
  });
});
