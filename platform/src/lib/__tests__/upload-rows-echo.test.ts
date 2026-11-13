/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { normalizeRowsEcho } from '../upload-rows-echo';

describe('normalizeRowsEcho (memory-safety upload echo)', () => {
  it('passes the new API shape through unchanged', () => {
    const data = {
      totalRows: 3,
      problemRows: [{ rowIndex: 3, status: 'rejected_outlet', remarks: 'x' }],
      problemRowCount: 900,
      problemRowsTruncated: true,
      warningRows: [],
      warningRowCount: 0,
      warningRowsTruncated: false,
      skippedBlankCount: 2,
    };
    expect(normalizeRowsEcho(data)).toEqual(data);
  });

  it('derives the split from an older API build that still sends every row', () => {
    const out = normalizeRowsEcho({
      totalRows: 4,
      rows: [
        { rowIndex: 3, status: 'accepted', remarks: '' },
        { rowIndex: 4, status: 'rejected_outlet', remarks: 'Outlet code "Z" not found' },
        { rowIndex: 5, status: 'accepted', remarks: 'Ignored value(s) for KPI(s) not applicable to this outlet: A' },
        { rowIndex: 6, status: 'skipped_blank', remarks: 'All KPI cells blank — row skipped' },
      ],
    });
    expect(out.problemRows.map((r) => r.rowIndex)).toEqual([4]);
    expect(out.warningRows.map((r) => r.rowIndex)).toEqual([5]);
    expect(out.skippedBlankCount).toBe(1);
    expect('rows' in out).toBe(false);
  });

  it('defaults missing lists to empty (never crashes a screen)', () => {
    const out = normalizeRowsEcho({ totalRows: 0 });
    expect(out.problemRows).toEqual([]);
    expect(out.warningRows).toEqual([]);
    expect(out.problemRowsTruncated).toBe(false);
  });
});
