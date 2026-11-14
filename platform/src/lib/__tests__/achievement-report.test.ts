/**
 * M5 — the sales/achievement "Download problem rows" file: summary counts + only the rows to act on,
 * and a "showing the first N of M" line when the API capped the list.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildAchievementReportBuffer } from '../achievement-report';

const read = (buf: ArrayBuffer) => XLSX.read(new Uint8Array(buf), { type: 'array' });
const aoa = (wb: XLSX.WorkBook, name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1 });

describe('buildAchievementReportBuffer', () => {
  it('has a Summary sheet with the counts and a Problem Rows sheet', () => {
    const wb = read(buildAchievementReportBuffer(
      [{ rowIndex: 4, outletCode: 'X1', status: 'rejected_outlet', remarks: 'Unknown outlet' }],
      { summary: { month: '2026-11', total: 10, saved: 8, skippedBlank: 1, rejected: 1, partlyIgnored: 0 } },
    ));
    expect(wb.SheetNames).toEqual(['Summary', 'Problem Rows']);
    const summary = aoa(wb, 'Summary').map((r) => r.join('|'));
    expect(summary).toContain('Rows in file|10');
    expect(summary).toContain('Saved|8');
    expect(summary).toContain('Rejected|1');
    expect(summary.join('\n')).toMatch(/lists only the rows that need attention/);
    const rows = aoa(wb, 'Problem Rows');
    expect(rows[1]).toEqual([4, 'X1', 'Rejected — unknown outlet', 'Unknown outlet']);
  });

  it('says "Showing the first 500 of N" in the file when the list was capped', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ rowIndex: i + 2, outletCode: `O${i}`, status: 'rejected_kpi', remarks: 'bad' }));
    const wb = read(buildAchievementReportBuffer(rows, {
      summary: { total: 3000, saved: 1000, skippedBlank: 0, rejected: 2000, partlyIgnored: 0 },
      problem: { shown: 500, total: 2000, truncated: true },
      warning: { shown: 0, total: 0, truncated: false },
    }));
    const text = [...aoa(wb, 'Summary'), ...aoa(wb, 'Problem Rows')].map((r) => r.join(' ')).join('\n');
    expect(text).toMatch(/Showing the first 500 of 2,000 rejected rows/);
    expect(text).not.toMatch(/partly-ignored rows\./);
  });
});
