import * as XLSX from 'xlsx';
import {
  buildCreditUploadXlsx,
  buildPayoutReportXlsx,
  buildPreviewReportXlsx,
  PAYOUT_REPORT_COLUMNS,
  PREVIEW_REPORT_COLUMNS,
} from './points-compute-export.helper';
import type { ComputePreview } from './points-compute.types';

/**
 * These tests pin the EXACT contract the existing credits upload parser expects
 * (platform/src/lib/credits-payouts-parser.ts + credits-payouts-template.ts), so the exported
 * file round-trips UNCHANGED through the real credits-upload flow:
 *   Row 0 = title (skipped) · Row 1 = headers · Row 2+ = one data row per outlet.
 *   Headers = "Outlet ID" | "Outlet Name" | <field name>… | "<field name> Narration"…
 *   Value columns keyed by CreditField NAME; value cells = WHOLE points (no ×100); blank = SKIP.
 */

/** Read sheet[0] back as arrays-of-arrays exactly as parseCreditUpload does (header:1, defval:''). */
function readCreditAoa(buf: Buffer): (string | number)[][] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: '',
  }) as (string | number)[][];
}

/** Read a named sheet back into row objects. */
function readSheet(buf: Buffer, name: string): Record<string, unknown>[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[name];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

function samplePreview(overrides: Partial<ComputePreview> = {}): ComputePreview {
  return {
    clientId: 'deoleo',
    period: '2026-07',
    counts: { total: 7, ok: 4, skip: 1, error: 1, noRule: 1 },
    totalPoints: 1850,
    totalPayoutRupees: 0,
    engineDisabled: false,
    directCreditEnabled: false,
    sourceKey: 'pe_test',
    ruleVersionsUsed: [
      { ruleId: 'rule_cases_q3', version: 7 },
      { ruleId: 'rule_vis', version: 2 },
    ],
    rows: [
      {
        outletCode: 'O1',
        outletName: 'Outlet One',
        program: 'GOLD',
        kpiCode: 'CASES_SOLD',
        ruleId: 'rule_cases_q3',
        ruleVersion: 7,
        awardType: 'POINTS',
        fieldId: 'cf_a',
        fieldName: 'Scheme Q3',
        status: 'OK',
        points: 1300,
        achievement: 600,
        target: 500,
        explanation: 'Gate passed (600 ≥ 500) → slab +300 → milestone +1000 → 1,300 pts',
      },
      {
        outletCode: 'O2',
        outletName: 'Outlet Two',
        program: 'GOLD',
        kpiCode: 'CASES_SOLD',
        ruleId: 'rule_cases_q3',
        ruleVersion: 7,
        awardType: 'POINTS',
        fieldId: 'cf_a',
        fieldName: 'Scheme Q3',
        status: 'OK',
        points: 200,
        achievement: 520,
        target: 500,
        explanation: 'Gate passed → 200 pts',
      },
      {
        outletCode: 'O1',
        outletName: 'Outlet One',
        program: 'GOLD',
        kpiCode: 'VISIBILITY',
        ruleId: 'rule_vis',
        ruleVersion: 2,
        awardType: 'POINTS',
        fieldId: 'cf_b',
        fieldName: 'Visibility Bonus',
        status: 'OK',
        points: 50,
        achievement: 95,
        target: 90,
        explanation: 'Visibility ≥ 90 → 50 pts',
      },
      {
        // Second OK row for the SAME (outlet × field) as O2/cf_a → must SUM into one cell (200 + 300 = 500).
        outletCode: 'O2',
        outletName: 'Outlet Two',
        program: 'GOLD',
        kpiCode: 'CASES_SOLD',
        ruleId: 'rule_cases_q3',
        ruleVersion: 7,
        awardType: 'POINTS',
        fieldId: 'cf_a',
        fieldName: 'Scheme Q3',
        status: 'OK',
        points: 300,
        achievement: 530,
        target: 500,
        explanation: 'Top-up → 300 pts',
      },
      {
        outletCode: 'O3',
        outletName: 'Outlet Three',
        program: 'GOLD',
        kpiCode: 'CASES_SOLD',
        fieldId: 'cf_a',
        fieldName: 'Scheme Q3',
        status: 'SKIP',
        reason: 'No target for CASES_SOLD (nullAs=skipRule)',
        achievement: 100,
        target: null,
      },
      {
        outletCode: 'O4',
        outletName: 'Outlet Four',
        program: 'GOLD',
        kpiCode: 'CASES_SOLD',
        fieldId: 'cf_a',
        fieldName: 'Scheme Q3',
        status: 'ERROR',
        reason: 'Achievement value is not a number',
        achievement: null,
        target: 500,
      },
      {
        outletCode: 'O5',
        outletName: 'Outlet Five',
        program: 'SILVER',
        kpiCode: 'CASES_SOLD',
        status: 'NO_RULE',
        reason: 'No active rule for program SILVER × CASES_SOLD',
      },
    ],
    ...overrides,
  };
}

describe('buildCreditUploadXlsx — round-trips through the credits upload parser', () => {
  it('emits the EXACT header row the parser expects (Outlet ID, Outlet Name, field names, narration)', () => {
    const aoa = readCreditAoa(buildCreditUploadXlsx(samplePreview()));

    // Row 0 is a TITLE the parser skips.
    expect(String(aoa[0][0])).toContain('Credits & Payouts Data');

    // Row 1 is the header row the parser reads.
    const header = aoa[1].map((h) => String(h).trim());
    expect(header).toEqual([
      'Outlet ID',
      'Outlet Name',
      'Scheme Q3',
      'Visibility Bonus',
      'Scheme Q3 Narration',
      'Visibility Bonus Narration',
    ]);
    // The two anchors the parser hard-requires.
    expect(header.indexOf('Outlet ID')).toBe(0);
    expect(header.indexOf('Outlet Name')).toBe(1);
  });

  it('includes ONLY OK rows — skip/error/no-rule outlets are excluded', () => {
    const aoa = readCreditAoa(buildCreditUploadXlsx(samplePreview()));
    const dataOutletIds = aoa.slice(2).map((r) => String(r[0]).trim());
    expect(dataOutletIds).toEqual(['O1', 'O2']); // O3 (SKIP), O4 (ERROR), O5 (NO_RULE) are gone
    expect(dataOutletIds).not.toContain('O3');
    expect(dataOutletIds).not.toContain('O4');
    expect(dataOutletIds).not.toContain('O5');
  });

  it('writes WHOLE points per (outlet × field), summing duplicate (outlet × field) rows', () => {
    const aoa = readCreditAoa(buildCreditUploadXlsx(samplePreview()));
    const header = aoa[1].map((h) => String(h).trim());
    const col = (name: string) => header.indexOf(name);

    // Rebuild the (outletId → row) map the way the parser indexes data (row 2+).
    const byOutlet = new Map<string, (string | number)[]>();
    for (const r of aoa.slice(2)) byOutlet.set(String(r[0]).trim(), r);

    const o1 = byOutlet.get('O1')!;
    const o2 = byOutlet.get('O2')!;

    // O1: Scheme Q3 = 1300 (whole int), Visibility Bonus = 50.
    expect(o1[col('Scheme Q3')]).toBe(1300);
    expect(Number.isInteger(o1[col('Scheme Q3')])).toBe(true);
    expect(o1[col('Visibility Bonus')]).toBe(50);

    // O2: Scheme Q3 = 200 + 300 = 500 (summed); no Visibility Bonus → blank cell.
    expect(o2[col('Scheme Q3')]).toBe(500);
    expect(o2[col('Visibility Bonus')]).toBe('');

    // Narration columns exist but are blank (match the template; parser treats them as optional).
    expect(o1[col('Scheme Q3 Narration')]).toBe('');
    expect(o1[col('Visibility Bonus Narration')]).toBe('');
  });

  it('produces an empty-but-valid sheet when there are no OK rows', () => {
    const preview = samplePreview({
      rows: [
        {
          outletCode: 'OX',
          kpiCode: 'CASES_SOLD',
          status: 'SKIP',
          reason: 'nothing to credit',
        },
      ],
      counts: { total: 1, ok: 0, skip: 1, error: 0, noRule: 0 },
      totalPoints: 0,
    });
    const aoa = readCreditAoa(buildCreditUploadXlsx(preview));
    // Title + header only; header still carries the two required anchors.
    const header = aoa[1].map((h) => String(h).trim());
    expect(header).toEqual(['Outlet ID', 'Outlet Name']);
    expect(aoa.slice(2)).toHaveLength(0);
  });
});

describe('buildPreviewReportXlsx — full human review report', () => {
  it('emits one Preview Rows row per preview row with the full column set', () => {
    const preview = samplePreview();
    const rows = readSheet(buildPreviewReportXlsx(preview), 'Preview Rows');
    expect(rows).toHaveLength(preview.rows.length); // every status, not just OK

    for (const col of PREVIEW_REPORT_COLUMNS) {
      expect(Object.prototype.hasOwnProperty.call(rows[0], col)).toBe(true);
    }
  });

  it('renders a known OK row with points, rule identity and the trace explanation', () => {
    const rows = readSheet(buildPreviewReportXlsx(samplePreview()), 'Preview Rows');
    const o1 = rows.find(
      (r) => r['Outlet Code'] === 'O1' && r['KPI Code'] === 'CASES_SOLD',
    )!;
    expect(o1['Outlet Name']).toBe('Outlet One');
    expect(o1['Program']).toBe('GOLD');
    expect(o1['Status']).toBe('OK');
    expect(o1['Points']).toBe(1300);
    expect(o1['Achievement']).toBe(600);
    expect(o1['Target']).toBe(500);
    expect(o1['Rule ID']).toBe('rule_cases_q3');
    expect(o1['Rule Version']).toBe(7);
    expect(String(o1['Reason / Explanation'])).toContain('1,300 pts');
  });

  it('renders a non-OK row with its reason and no points', () => {
    const rows = readSheet(buildPreviewReportXlsx(samplePreview()), 'Preview Rows');
    const o5 = rows.find((r) => r['Outlet Code'] === 'O5')!;
    expect(o5['Status']).toBe('NO_RULE');
    expect(o5['Points']).toBe(''); // no points on a non-OK row
    expect(String(o5['Reason / Explanation'])).toContain('No active rule');
  });

  it('emits a Summary sheet with counts, total points and the engineDisabled flag', () => {
    const preview = samplePreview();
    const summaryRows = readSheet(buildPreviewReportXlsx(preview), 'Summary');
    expect(summaryRows).toHaveLength(1);
    const s = summaryRows[0];
    expect(s['Client']).toBe('deoleo');
    expect(s['Period']).toBe('2026-07');
    expect(s['Total']).toBe(preview.counts.total);
    expect(s['OK']).toBe(preview.counts.ok);
    expect(s['Skip']).toBe(preview.counts.skip);
    expect(s['Error']).toBe(preview.counts.error);
    expect(s['No Rule']).toBe(preview.counts.noRule);
    expect(s['Total Points']).toBe(1850);
    expect(s['Engine Disabled']).toBe(false);
  });

  it('reflects engineDisabled=true when the per-tenant flag is off', () => {
    const summaryRows = readSheet(
      buildPreviewReportXlsx(samplePreview({ engineDisabled: true })),
      'Summary',
    );
    expect(summaryRows[0]['Engine Disabled']).toBe(true);
  });

  it('EXCLUDES PAYOUT rows (they belong in the payout report) and reconciles its points-only counts', () => {
    const mixed = samplePreview({
      totalPoints: 1300,
      totalPayoutRupees: 5200,
      rows: [
        {
          outletCode: 'O1', outletName: 'Outlet One', program: 'GOLD', kpiCode: 'CASES_SOLD',
          ruleId: 'r_pts', ruleVersion: 1, awardType: 'POINTS', fieldId: 'cf_a', fieldName: 'Scheme',
          status: 'OK', points: 1300, achievement: 600, target: 500, explanation: '1,300 pts',
        },
        {
          outletCode: 'O2', outletName: 'Outlet Two', program: 'GOLD', kpiCode: 'VISIBILITY',
          ruleId: 'r_pay', ruleVersion: 1, awardType: 'PAYOUT', fieldId: 'cf_p', fieldName: 'Payout',
          status: 'OK', payoutRupees: 5200, achievement: 98, target: 90, explanation: '₹5,200',
        },
      ],
    });
    const rows = readSheet(buildPreviewReportXlsx(mixed), 'Preview Rows');
    expect(rows.map((r) => r['Outlet Code'])).toEqual(['O1']); // the PAYOUT outlet O2 is excluded
    const s = readSheet(buildPreviewReportXlsx(mixed), 'Summary')[0];
    expect(s['Total']).toBe(1); // points rows only
    expect(s['OK']).toBe(1); // no longer counts the PAYOUT OK row
    expect(s['Total Points']).toBe(1300);
  });
});

describe('buildPayoutReportXlsx — report-only payout amounts (never credited)', () => {
  /** A preview mixing a POINTS row (must be EXCLUDED) with OK + non-OK PAYOUT rows. */
  function payoutPreview(): ComputePreview {
    return samplePreview({
      counts: { total: 3, ok: 2, skip: 0, error: 1, noRule: 0 },
      totalPoints: 1300,
      totalPayoutRupees: 5200,
      rows: [
        {
          outletCode: 'O1', outletName: 'Outlet One', program: 'GOLD', kpiCode: 'CASES_SOLD',
          ruleId: 'rule_cases_q3', ruleVersion: 7, awardType: 'POINTS', fieldId: 'cf_a',
          fieldName: 'Scheme Q3', status: 'OK', points: 1300, achievement: 600, target: 500,
          explanation: '1,300 pts',
        },
        {
          outletCode: 'O2', outletName: 'Outlet Two', program: 'GOLD', kpiCode: 'VISIBILITY',
          ruleId: 'rule_payout', ruleVersion: 1, awardType: 'PAYOUT', fieldId: 'cf_p',
          fieldName: 'Visibility Payout', status: 'OK', payoutRupees: 5200, achievement: 98, target: 90,
          explanation: 'Visibility ≥ 90 → ₹5,200',
        },
        {
          outletCode: 'O3', outletName: 'Outlet Three', program: 'GOLD', kpiCode: 'VISIBILITY',
          ruleId: 'rule_payout', ruleVersion: 1, awardType: 'PAYOUT', fieldId: 'cf_p',
          fieldName: 'Visibility Payout', status: 'ERROR', reason: 'Achievement value is not a number',
          achievement: null, target: 90,
        },
      ],
    });
  }

  it('includes ONLY PAYOUT rows (POINTS rows are excluded) with the full column set', () => {
    const rows = readSheet(buildPayoutReportXlsx(payoutPreview()), 'Payout Rows');
    expect(rows).toHaveLength(2); // the two PAYOUT rows; the POINTS row O1 is excluded
    expect(rows.map((r) => r['Outlet Code'])).toEqual(['O2', 'O3']);
    for (const col of PAYOUT_REPORT_COLUMNS) {
      expect(Object.prototype.hasOwnProperty.call(rows[0], col)).toBe(true);
    }
  });

  it('shows the whole-INR amount on an OK payout row and blank on a non-OK one', () => {
    const rows = readSheet(buildPayoutReportXlsx(payoutPreview()), 'Payout Rows');
    const o2 = rows.find((r) => r['Outlet Code'] === 'O2')!;
    const o3 = rows.find((r) => r['Outlet Code'] === 'O3')!;
    expect(o2['Status']).toBe('OK');
    expect(o2['Payout (INR)']).toBe(5200);
    expect(o3['Status']).toBe('ERROR');
    expect(o3['Payout (INR)']).toBe(''); // no amount on a non-OK row
    expect(String(o3['Reason / Explanation'])).toContain('not a number');
  });

  it('summarises payout-only counts and the total payout (INR)', () => {
    const summary = readSheet(buildPayoutReportXlsx(payoutPreview()), 'Summary');
    expect(summary).toHaveLength(1);
    const s = summary[0];
    expect(s['Client']).toBe('deoleo');
    expect(s['Period']).toBe('2026-07');
    expect(s['Payout Rows']).toBe(2); // excludes the POINTS row
    expect(s['OK']).toBe(1);
    expect(s['Error']).toBe(1);
    expect(s['Total Payout (INR)']).toBe(5200);
  });

  it('produces a valid empty report when there are no payout rows', () => {
    const rows = readSheet(buildPayoutReportXlsx(samplePreview()), 'Payout Rows'); // POINTS-only sample
    expect(rows).toHaveLength(0);
    const summary = readSheet(buildPayoutReportXlsx(samplePreview()), 'Summary');
    expect(summary[0]['Payout Rows']).toBe(0);
    expect(summary[0]['Total Payout (INR)']).toBe(0);
  });
});
