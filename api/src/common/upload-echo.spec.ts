import { fullRowsEcho, PREVIEW_FULL_ROWS_MAX, problemRowsEcho, UPLOAD_ECHO_MAX_ROWS } from './upload-echo';

describe('problemRowsEcho (uploads echo only problem rows, capped)', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ i, ok: i % 3 !== 0 }));

  it('keeps ONLY problem rows, in file order', () => {
    const out = problemRowsEcho(rows.slice(0, 10), (r) => !r.ok);
    expect(out.problemRows.map((r) => r.i)).toEqual([0, 3, 6, 9]);
    expect(out.problemRowCount).toBe(4);
    expect(out.problemRowsTruncated).toBe(false);
  });

  it('caps at 500 by default and flags truncation with the true total', () => {
    const out = problemRowsEcho(rows, (r) => !r.ok);
    expect(UPLOAD_ECHO_MAX_ROWS).toBe(500);
    expect(out.problemRows).toHaveLength(500);
    expect(out.problemRowCount).toBe(667);
    expect(out.problemRowsTruncated).toBe(true);
  });

  it('a clean file echoes nothing', () => {
    const out = problemRowsEcho(rows, () => false);
    expect(out).toEqual({ problemRows: [], problemRowCount: 0, problemRowsTruncated: false });
  });

  it('exactly at the cap is not truncated', () => {
    const out = problemRowsEcho(rows.slice(0, 5), () => true, 5);
    expect(out.problemRowsTruncated).toBe(false);
  });
});

describe('fullRowsEcho (previews before an irreversible apply show every row)', () => {
  it('keeps every row in order with the true count', () => {
    const rows = [{ n: 1, status: 'OK' }, { n: 2, status: 'SKIP' }, { n: 3, status: 'ERROR' }];
    expect(fullRowsEcho(rows)).toEqual({ rows, rowCount: 3, rowsTruncated: false });
  });

  it('caps generously (20,000) and flags the cut', () => {
    expect(PREVIEW_FULL_ROWS_MAX).toBe(20_000);
    const rows = Array.from({ length: 25 }, (_, n) => ({ n }));
    const e = fullRowsEcho(rows, 10);
    expect(e.rows.map((r) => r.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(e).toMatchObject({ rowCount: 25, rowsTruncated: true });
  });
});
