/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { pdfSafe, statementToPdfBlob } from '../statement-pdf';
import type { StatementDoc, StatementLine } from '../statement-model';
import { blobBytes } from './blob-bytes';

function docOf(lines: StatementLine[], over: Partial<StatementDoc> = {}): StatementDoc {
  return {
    title: 'Wallet Statement',
    outletName: 'Anil Traders',
    outletCode: 'OUT-1',
    periodLabel: 'Apr 2026 – Jun 2026',
    openingBalance: 100,
    closingBalance: 100,
    lines,
    generatedAt: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

function manyLines(n: number): StatementLine[] {
  const out: StatementLine[] = [];
  let bal = 100;
  for (let i = 0; i < n; i++) {
    const points = i % 2 ? -5 : 15;
    bal += points;
    out.push({
      kind: 'points', id: `r${i}`, date: new Date(Date.UTC(2026, 3, 1) + i * 60_000),
      description: `Visibility · row ${i}`, type: points > 0 ? 'Earned' : 'Redeemed', points, balance: bal,
    });
  }
  return out;
}

/** Decode the (uncompressed) PDF as latin1 text so we can grep content streams. */
async function pdfText(blob: Blob): Promise<string> {
  const bytes = await blobBytes(blob);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
const pageCount = (pdf: string) => (pdf.match(/\/Type \/Page\b(?!s)/g) ?? []).length;
const count = (pdf: string, needle: string) => pdf.split(needle).length - 1;

describe('statementToPdfBlob', () => {
  it('produces a PDF with the opening, closing and Balance column text', async () => {
    const pdf = await pdfText(
      await statementToPdfBlob(
        docOf([{ kind: 'points', id: 'a', date: new Date('2026-04-05T06:00:00Z'), description: 'Points earned', type: 'Earned', points: 40, balance: 140 }], { closingBalance: 140 }),
      ),
    );
    expect(pdf.startsWith('%PDF')).toBe(true);
    expect(pdf).toContain('Opening balance');
    expect(pdf).toContain('Closing balance');
    expect(pdf).toContain('(Balance)');
    expect(pdf).toContain('Wallet Statement');
    expect(pdf).toContain('Anil Traders');
    expect(pdf).toContain('05 Apr 2026');
  });

  it('a 2,500-row statement spans several pages with the column header repeated once per page', async () => {
    const pdf = await pdfText(await statementToPdfBlob(docOf(manyLines(2500))));
    const pages = pageCount(pdf);
    expect(pages).toBeGreaterThan(1);
    expect(count(pdf, '(Balance) Tj')).toBe(pages);
    expect(pdf).toContain(`Page ${pages} of ${pages}`);
  });

  it('renders 5,000 rows in under 3 s', async () => {
    const t0 = performance.now();
    await statementToPdfBlob(docOf(manyLines(5000)));
    expect(performance.now() - t0).toBeLessThan(3000);
  }, 15_000);

  it('an empty statement is exactly one page saying "No transactions in this period"', async () => {
    const pdf = await pdfText(await statementToPdfBlob(docOf([])));
    expect(pageCount(pdf)).toBe(1);
    expect(pdf).toContain('No transactions in this period');
  });

  it('writes payout amounts as "Rs." (Helvetica has no rupee glyph) and signed points', async () => {
    const pdf = await pdfText(
      await statementToPdfBlob(
        docOf([
          { kind: 'points', id: 'a', date: new Date('2026-04-05T06:00:00Z'), description: 'Points redeemed', type: 'Redeemed', points: -50, balance: 50 },
          { kind: 'payout', id: 'p', date: new Date('2026-04-06T06:00:00Z'), description: 'Visibility · Apr 2026', type: 'Payout', amountInr: 1234.5, utr: 'UTR9' },
        ]),
      ),
    );
    expect(pdf).toContain('(-50)');
    expect(pdf).toContain('Rs. 1,234.50');
    expect(pdf).toContain('UTR9');
  });
});

describe('pdfSafe', () => {
  it('maps the rupee sign to "Rs." and characters Helvetica cannot draw to "?"', () => {
    expect(pdfSafe('₹100 हिंदी')).toMatch(/^Rs\.100 \?+$/);
  });
  it('keeps Latin-1 and the WinAnsi punctuation the statement uses', () => {
    expect(pdfSafe('Café · Apr 2026 – Jun 2026')).toBe('Café · Apr 2026 – Jun 2026');
  });
});
