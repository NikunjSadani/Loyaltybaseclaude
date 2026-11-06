/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { statementToXlsxBlob, XLSX_HEADER } from '../statement-xlsx';
import type { StatementDoc, StatementLine } from '../statement-model';
import { blobBytes } from './blob-bytes';

function doc(lines: StatementLine[], opening = 100, closing?: number): StatementDoc {
  const lastBal = [...lines].reverse().find((l) => l.kind === 'points');
  return {
    title: 'Wallet Statement',
    outletName: 'Anil Traders',
    outletCode: 'OUT-1',
    periodLabel: 'Apr 2026 – Jun 2026',
    openingBalance: opening,
    closingBalance: closing ?? (lastBal && lastBal.kind === 'points' ? lastBal.balance : opening),
    lines,
    generatedAt: new Date('2026-07-01T00:00:00Z'),
  };
}
const pts = (id: string, date: string, points: number, balance: number, description = 'Points earned'): StatementLine => ({
  kind: 'points', id, date: new Date(date), description, type: points >= 0 ? 'Earned' : 'Redeemed', points, balance,
});
const pay = (id: string, date: string, amountInr: number): StatementLine => ({
  kind: 'payout', id, date: new Date(date), description: 'Visibility · May 2026', type: 'Payout', amountInr, utr: 'UTR9',
});

async function readBack(d: StatementDoc) {
  const blob = statementToXlsxBlob(d);
  const wb = XLSX.read(await blobBytes(blob), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: true, defval: '' });
  const headerIdx = aoa.findIndex((r) => r[0] === 'Date');
  return { wb, ws, aoa, headerIdx };
}

describe('statementToXlsxBlob', () => {
  it('writes one "Wallet Statement" sheet with the title, outlet, period and opening balance block', async () => {
    const { wb, aoa } = await readBack(doc([]));
    expect(wb.SheetNames).toEqual(['Wallet Statement']);
    expect(aoa[0][0]).toBe('Wallet Statement');
    expect(aoa[1].join(' ')).toContain('Anil Traders');
    expect(aoa[1].join(' ')).toContain('OUT-1');
    expect(aoa[2].join(' ')).toContain('Apr 2026 – Jun 2026');
    expect(aoa[3]).toEqual(expect.arrayContaining(['Opening balance', 100]));
  });

  it('the header row has Balance between Points and Amount', async () => {
    const { aoa, headerIdx } = await readBack(doc([]));
    expect(aoa[headerIdx].slice(0, XLSX_HEADER.length)).toEqual(XLSX_HEADER);
    const h = aoa[headerIdx] as string[];
    expect(h.indexOf('Balance')).toBe(h.indexOf('Points') + 1);
    expect(h[h.indexOf('Balance') + 1]).toMatch(/^Amount/);
  });

  it('Points and Balance cells are numbers (so Excel can sum them), debits negative', async () => {
    const { ws, headerIdx } = await readBack(doc([pts('a', '2026-04-05T06:00:00Z', -50, 50)]));
    const r = headerIdx + 1; // 0-based row of the first line
    const pointsCell = ws[XLSX.utils.encode_cell({ r, c: 3 })];
    const balCell = ws[XLSX.utils.encode_cell({ r, c: 4 })];
    expect(pointsCell.t).toBe('n');
    expect(pointsCell.v).toBe(-50);
    expect(balCell.t).toBe('n');
    expect(balCell.v).toBe(50);
  });

  it('dates are the IST "dd Mon yyyy" string (18:45Z on 31 Mar → 01 Apr 2026)', async () => {
    const { aoa, headerIdx } = await readBack(doc([pts('a', '2026-03-31T18:45:00Z', 10, 110)]));
    expect(aoa[headerIdx + 1][0]).toBe('01 Apr 2026');
  });

  it('payout rows have empty Points/Balance and a numeric Amount + UTR', async () => {
    const { ws, aoa, headerIdx } = await readBack(doc([pay('p', '2026-05-10T06:00:00Z', 1234.5)]));
    const line = aoa[headerIdx + 1];
    expect(line[3]).toBe('');
    expect(line[4]).toBe('');
    const amt = ws[XLSX.utils.encode_cell({ r: headerIdx + 1, c: 5 })];
    expect(amt.t).toBe('n');
    expect(amt.v).toBe(1234.5);
    expect(line[6]).toBe('UTR9');
  });

  it('shows opening and closing, and opening + Σ Points = closing', async () => {
    const d = doc([
      pts('a', '2026-04-05T06:00:00Z', 40, 140),
      pay('p', '2026-04-06T06:00:00Z', 500),
      pts('b', '2026-04-07T06:00:00Z', -25, 115),
    ]);
    const { aoa, headerIdx } = await readBack(d);
    const lineRows = aoa.slice(headerIdx + 1, headerIdx + 1 + d.lines.length);
    const sum = lineRows.reduce<number>((s, r) => s + (typeof r[3] === 'number' ? r[3] : 0), 0);
    const closingRow = aoa.find((r) => r.includes('Closing balance'))!;
    const closing = closingRow.find((c) => typeof c === 'number') as number;
    expect(closing).toBe(115);
    expect(100 + sum).toBe(closing);
  });

  it('neutralises a description that starts with "=" (formula injection)', async () => {
    const { aoa, headerIdx } = await readBack(doc([pts('a', '2026-04-05T06:00:00Z', 1, 101, '=HYPERLINK("x")')]));
    expect(aoa[headerIdx + 1][1]).toBe(`'=HYPERLINK("x")`);
  });

  it('an empty statement is a valid workbook with the header block and a "No transactions in this period" row', async () => {
    const { aoa, headerIdx } = await readBack(doc([], 70, 70));
    expect(headerIdx).toBeGreaterThan(0);
    expect(aoa[headerIdx + 1][0]).toBe('No transactions in this period');
    expect(aoa.find((r) => r.includes('Closing balance'))).toEqual(expect.arrayContaining([70]));
  });
});
