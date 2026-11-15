import { ParsedRow, targetUploadRowsEcho } from './targets.helpers';

/**
 * Memory-safety (2026-11-13): target / achievement uploads no longer echo every parsed row
 * (with its KPI values). Only rejected rows + ignored-value warning rows come back, each capped
 * at 500 and slimmed to row / outlet / status / remarks.
 */
function row(i: number, status: ParsedRow['status'], remarks = ''): ParsedRow {
  return {
    rowIndex: i + 3,
    outletCode: `O${i}`,
    outletName: `Outlet ${i}`,
    outletType: 'RETAIL',
    monthTargets: status === 'accepted' ? { '2026-11': { SALES: i } } : {},
    status,
    remarks,
  };
}

describe('targetUploadRowsEcho', () => {
  it('6,500-row file: echoes only the rejected + warning rows, never the accepted ones', () => {
    const rows: ParsedRow[] = [];
    for (let i = 0; i < 6500; i++) {
      if (i % 1000 === 0) rows.push(row(i, 'rejected_outlet', `Outlet code "O${i}" not found — row rejected`));
      else if (i % 1000 === 1) rows.push(row(i, 'accepted', 'Ignored value(s) for KPI(s) not applicable to this outlet: X'));
      else if (i % 1000 === 2) rows.push(row(i, 'skipped_blank', 'All KPI cells blank — row skipped'));
      else rows.push(row(i, 'accepted'));
    }
    const out = targetUploadRowsEcho(rows);
    expect(out.problemRowCount).toBe(7);
    expect(out.problemRows.map((r) => r.outletCode)).toEqual(['O0', 'O1000', 'O2000', 'O3000', 'O4000', 'O5000', 'O6000']);
    expect(out.problemRowsTruncated).toBe(false);
    expect(out.warningRowCount).toBe(7);
    expect(out.warningRows.every((r) => r.status === 'accepted')).toBe(true);
    expect(out.skippedBlankCount).toBe(7);
    // Slim rows: no parsed KPI values travel back.
    expect(Object.keys(out.problemRows[0]).sort()).toEqual(['outletCode', 'outletName', 'remarks', 'rowIndex', 'status']);
    // Tiny payload vs. the old full echo.
    expect(JSON.stringify(out).length).toBeLessThan(5_000);
  });

  it('caps rejected rows at 500 with the true total + truncated flag', () => {
    const rows = Array.from({ length: 800 }, (_, i) => row(i, i % 2 ? 'rejected_kpi' : 'rejected_outlet', 'bad'));
    const out = targetUploadRowsEcho(rows);
    expect(out.problemRows).toHaveLength(500);
    expect(out.problemRowCount).toBe(800);
    expect(out.problemRowsTruncated).toBe(true);
    expect(out.problemRows[0].rowIndex).toBe(3); // file order
  });

  it('a skipped row whose values were ALL out of scope is a warning (its remark explains why)', () => {
    const out = targetUploadRowsEcho([
      row(0, 'skipped_blank', 'No applicable KPI values — row skipped. Ignored value(s) for KPI(s) not applicable to this outlet: X'),
    ]);
    expect(out.warningRowCount).toBe(1);
    expect(out.problemRowCount).toBe(0);
  });
});
