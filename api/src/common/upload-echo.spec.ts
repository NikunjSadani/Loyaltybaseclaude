import { problemRowsEcho, UPLOAD_ECHO_MAX_ROWS } from './upload-echo';

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
