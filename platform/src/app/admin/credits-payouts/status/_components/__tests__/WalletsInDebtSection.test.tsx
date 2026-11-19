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
      approvedAt: '2026-11-19T06:00:00.000Z', fieldName: 'Volume', period: '2026-10',
    }],
  },
  { walletId: 'w2', partnerName: 'Shop Two', outletCodes: ['O2'], balance: -841, debtPoints: 841, owedPoints: 841, note: 'No reversal behind it — negative from imported / earlier history', sources: [] },
];

function stub(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('WalletsInDebtSection', () => {
  it('summary, the list (expand) with the reversal behind each wallet, and an Excel download', async () => {
    stub({ success: true, data: { total: 2, limit: 1000, wallets: W } });
    render(<WalletsInDebtSection />);
    expect((await screen.findByTestId('wallets-in-debt-summary')).textContent).toBe('2 wallets in debt · 3,827 pts owed');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const r1 = screen.getByTestId('debt-wallet-w1');
    expect(r1.textContent).toContain('−2,986 pts');
    expect(r1.textContent).toContain('Reversal took more than the wallet held — 2,986 pts (Volume · 2026-10) · reversal REV1');
    expect(screen.getByTestId('debt-wallet-w2').textContent).toContain('negative from imported');
    fireEvent.click(screen.getByRole('button', { name: /Excel/ }));
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'wallets-in-debt.xlsx');
  });

  it('the Excel has one row per wallet × source', () => {
    const wb = XLSX.read(buildWalletsInDebtXlsx(W), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Wallets in debt'], { header: 1 });
    expect(rows[0]).toEqual(['Outlet code(s)', 'Outlet / partner', 'Balance (pts)', 'Debt (pts)', 'Owed (pts)', 'Source', 'Reversal', 'Approved on', 'Field', 'Period']);
    expect(rows[1]).toEqual(expect.arrayContaining(['O1', 'Shop One', -2986, 2986, 2986, 'Reversal took more than the wallet held', 'REV1', 'Volume', '2026-10']));
    expect(rows[2]).toEqual(expect.arrayContaining(['O2', 'Shop Two', -841, 'No reversal behind it — negative from imported / earlier history']));
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
