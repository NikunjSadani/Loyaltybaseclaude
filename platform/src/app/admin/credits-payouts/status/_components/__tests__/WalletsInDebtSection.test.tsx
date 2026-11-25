/// <reference types="vitest/globals" />
/**
 * Wallets below zero — audit item 9 + fix rounds 3–5 (no silent pass-throughs): every wallet below zero with the
 * reversal(s) behind it (one line per allocation), totals from the API, a programme filter (summary names it, note on
 * inactive outlets, loading dims the old numbers, an error keeps the header + filter with Retry), an accessible export
 * (aria-disabled + "Preparing file…" / "Downloaded"), a clean Excel with a real date cell + "About" sheet, nothing when
 * there is none (ONLY when the server said so — anyNegative false), and a LOUD alert with Retry when the first load
 * fails (round 6: the screen never stays quiet on an unknown answer). The summary names the programme of the numbers
 * SHOWN (data.program), during loading and after a failed load (round 6, item 3); "Approved on" is dd-mmm-yyyy (item 6).
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
const ALL = { total: 3, totalOwedPoints: 5000, truncated: true, limit: 2, anyNegative: true, program: null, availablePrograms: ['Gold', 'Silver'], wallets: W };

function stub(byUrl: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => ({ ok: true, status: 200, json: async () => byUrl(String(u)) })));
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('WalletsInDebtSection', () => {
  it('summary from the FULL totals, one line per allocation, accessible complete Excel export', async () => {
    stub((u) => ({ success: true, data: u.includes('limit=5000') ? { ...ALL, limit: 5000 } : ALL }));
    render(<WalletsInDebtSection />);
    expect((await screen.findByTestId('wallets-in-debt-summary')).textContent).toBe('3 wallets below zero · 5,000 pts owed (first 2 listed)');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const lines = screen.getByTestId('debt-wallet-w1').querySelectorAll('li');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain('Reversal took more than the wallet held — 2,986 pts (O1 · Volume · 2026-10) · reversal REV1');
    expect(screen.getByTestId('debt-wallet-w2').textContent).toContain('negative from imported');

    const btn = screen.getByRole('button', { name: /Excel/ });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-disabled', 'true'); // B4: still focusable, announced as unavailable
    expect(screen.getByTestId('wallets-in-debt-export-status').textContent).toBe('Preparing file…');
    fireEvent.click(btn); // a second click while preparing does nothing
    await vi.waitFor(() => expect(screen.getByTestId('wallets-in-debt-export-status').textContent).toBe('Downloaded'));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'wallets-below-zero.xlsx');
    expect((await screen.findByTestId('wallets-in-debt-export-msg')).textContent).toBe(
      'The file has the first 2 of 3 wallets (see its "About" sheet) — choose a programme to get the rest.',
    );
  });

  it('programme filter: summary names the LOADED programme (also while loading and after a failed load), a note explains inactive outlets, old numbers dim; an error keeps the header + filter with Retry', async () => {
    let resolveGold: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes('programName=Gold')) {
        await new Promise<void>((r) => { resolveGold = r; });
        return { ok: true, status: 200, json: async () => ({ success: true, data: { total: 1, totalOwedPoints: 841, truncated: false, limit: 1000, anyNegative: true, program: 'Gold', availablePrograms: ['Gold', 'Silver'], wallets: [W[1]] } }) };
      }
      if (url.includes('programName=Silver')) return { ok: false, status: 500, json: async () => ({ success: false, error: 'db down' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: ALL }) };
    }));
    render(<WalletsInDebtSection />);
    await screen.findByTestId('wallets-in-debt-summary');
    fireEvent.change(screen.getByTestId('wallets-in-debt-program'), { target: { value: 'Gold' } });
    // loading: old numbers stay, dimmed, section aria-busy — and the label stays theirs (All programmes), not "in Gold"
    expect(screen.getByTestId('wallets-in-debt')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('wallets-in-debt-summary').className).toContain('opacity-50');
    expect(screen.getByTestId('wallets-in-debt-summary').textContent).toBe('3 wallets below zero · 5,000 pts owed (first 2 listed)');
    expect(screen.queryByTestId('wallets-in-debt-program-note')).toBeNull();
    await vi.waitFor(() => expect(resolveGold).not.toBeNull());
    resolveGold!();
    expect((await screen.findByText('1 wallet below zero in Gold · 841 pts owed')).textContent).toBeTruthy();
    expect(screen.getByTestId('wallets-in-debt-program-note').textContent).toMatch(/inactive appear only\s+under All programmes/);

    // a failed programme load: header + dropdown stay, inline error with Retry; the summary still names Gold (its numbers)
    fireEvent.change(screen.getByTestId('wallets-in-debt-program'), { target: { value: 'Silver' } });
    expect((await screen.findByTestId('wallets-in-debt-error')).textContent).toContain('db down');
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('wallets-in-debt-error'));
    expect(screen.getByTestId('wallets-in-debt-summary').textContent).toBe('1 wallet below zero in Gold · 841 pts owed');
    expect(screen.getByTestId('wallets-in-debt-program')).toHaveValue('Silver');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    fireEvent.change(screen.getByTestId('wallets-in-debt-program'), { target: { value: '' } });
    expect((await screen.findByText('3 wallets below zero · 5,000 pts owed (first 2 listed)')).textContent).toBeTruthy();
    expect(screen.queryByTestId('wallets-in-debt-error')).toBeNull();
  });

  it('the Excel is a clean table (header first, real date cell, per-source points + source outlet code); a cut file says so on an "About" sheet', () => {
    const wb = XLSX.read(buildWalletsInDebtXlsx(W, { total: 9, program: 'Gold' }), { type: 'array', cellDates: true, cellNF: true });
    const sheet = wb.Sheets['Wallets below zero'];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
    expect(rows[0]).toEqual([
      'Wallet outlet code(s)', 'Outlet / partner', 'Balance (pts)', 'Owed (pts)',
      'Source', 'Source points', 'Source outlet code', 'Reversal', 'Approved on', 'Field', 'Period',
    ]);
    expect(rows[1]).toEqual(expect.arrayContaining(['O1', 'Shop One', -3086, 3086, 'Reversal took more than the wallet held', 2986, 'O1', 'REV1', 'Volume', '2026-10']));
    expect(rows[1][8]).toBeInstanceOf(Date); // B8: a real date cell
    expect(sheet.I2.z).toBe('dd-mmm-yyyy'); // round 6 (item 6): explicit date format, not the machine default
    expect(sheet.I3.z).toBe('dd-mmm-yyyy');
    expect(sheet.I4?.z).not.toBe('dd-mmm-yyyy'); // the no-reversal row has no date
    expect(rows[3]).toEqual(expect.arrayContaining(['O2', 'Shop Two', -841, 'No reversal behind it — negative from imported / earlier history']));
    const about = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.About, { header: 1 });
    expect(about).toEqual([['Programme: Gold'], ['This file has the first 2 of 9 wallets — choose a programme to get the rest.']]);
    expect(XLSX.read(buildWalletsInDebtXlsx(W), { type: 'array' }).SheetNames).toEqual(['Wallets below zero']);
  });

  it('quiet ONLY when the server said none (anyNegative false); a first-load failure is LOUD (role=alert + Retry) and Retry recovers', async () => {
    stub(() => ({ success: true, data: { total: 0, totalOwedPoints: 0, limit: 1000, anyNegative: false, program: null, wallets: [] } }));
    const { container, unmount } = render(<WalletsInDebtSection />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
    unmount();

    let ok = false;
    stub(() => (ok ? { success: true, data: ALL } : { success: false, error: 'boom' }));
    render(<WalletsInDebtSection />);
    const alert = await screen.findByRole('alert');
    expect(alert).toBe(screen.getByTestId('wallets-in-debt-error'));
    expect(alert.textContent).toBe("Couldn't check for wallets below zero — boom Retry");
    ok = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findByTestId('wallets-in-debt-summary')).textContent).toBe('3 wallets below zero · 5,000 pts owed (first 2 listed)');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a network failure on the first load is loud too (never a silent empty screen)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<WalletsInDebtSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('offline');
  });
});

describe('WalletsInDebtSection — UPLOAD_DEDUCTION source (negative-points upload rows)', () => {
  const UD = {
    kind: 'UPLOAD_DEDUCTION' as const, batchId: 'cb1', fieldName: 'Target Achievement', period: '2026-10',
    deductedPoints: 320, at: '2026-11-03T06:00:00.000Z', outletCode: 'O3',
  };
  const WD: DebtWallet[] = [
    { walletId: 'w3', partnerName: 'Shop Three', outletCodes: ['O3'], balance: -220, debtPoints: 220, owedPoints: 220, note: null,
      sources: [UD, { ...SRC, allocationId: 'al9', owedPoints: 50 }] },
  ];

  it('renders "Upload deduction · <field> · <period> · −<points> pts"; reversal sources unchanged', async () => {
    stub(() => ({ success: true, data: { total: 1, totalOwedPoints: 220, limit: 1000, anyNegative: true, program: null, wallets: WD } }));
    render(<WalletsInDebtSection />);
    await screen.findByTestId('wallets-in-debt-summary');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const lines = screen.getByTestId('debt-wallet-w3').querySelectorAll('li');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe('Upload deduction · Target Achievement · 2026-10 · −320 pts');
    expect(lines[1].textContent).toContain('Reversal took more than the wallet held — 50 pts (O1 · Volume · 2026-10) · reversal REV1');
  });

  it('the Excel row for an upload deduction: Source "Upload deduction", points, outlet, no reversal, dated', () => {
    const wb = XLSX.read(buildWalletsInDebtXlsx(WD), { type: 'array', cellDates: true });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Wallets below zero'], { header: 1 });
    const r = rows[1] as unknown[];
    expect(r.slice(4, 8)).toEqual(['Upload deduction', 320, 'O3', '']);
    expect(r[8]).toBeInstanceOf(Date);
    expect(r.slice(9, 11)).toEqual(['Target Achievement', '2026-10']);
  });
});
