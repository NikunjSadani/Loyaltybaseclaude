import * as XLSX from 'xlsx';
import { buildXlsx } from './xlsx';

/** Read the first sheet of a buildXlsx buffer back into row objects. */
function readBack(buf: Buffer): Record<string, unknown>[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

describe('buildXlsx — formula-injection sanitisation', () => {
  it('prefixes a leading =,+,-,@ string cell with an apostrophe', () => {
    const buf = buildXlsx([
      {
        name: 'S',
        rows: [
          { Name: '=cmd|\'/c calc\'!A1', B: '+1+1', C: '-2', D: '@SUM(A1)' },
        ],
      },
    ]);
    const [row] = readBack(buf);
    expect(row.Name).toBe('\'=cmd|\'/c calc\'!A1');
    expect(row.B).toBe('\'+1+1');
    expect(row.C).toBe('\'-2');
    expect(row.D).toBe('\'@SUM(A1)');
  });

  it('leaves ordinary strings and non-string cells untouched', () => {
    const buf = buildXlsx([
      { name: 'S', rows: [{ Name: 'Trade Loyalty', Count: 5, Flag: 'Premium' }] },
    ]);
    const [row] = readBack(buf);
    expect(row.Name).toBe('Trade Loyalty');
    expect(row.Flag).toBe('Premium');
    expect(row.Count).toBe(5); // numbers pass through unchanged
  });

  it('is idempotent — an already-escaped value is not double-prefixed', () => {
    const buf = buildXlsx([{ name: 'S', rows: [{ Name: '\'=already' }] }]);
    const [row] = readBack(buf);
    expect(row.Name).toBe('\'=already'); // leading apostrophe → no further escaping
  });
});
