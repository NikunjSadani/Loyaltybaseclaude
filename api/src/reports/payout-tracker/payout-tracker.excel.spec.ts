import ExcelJS from 'exceljs';
import {
  ABOUT_NOTES,
  FMT,
  NO_DATA_TEXT,
  formatIst,
  notBillingHeaders,
  colLetter,
  provisionalLine,
  ragFormula,
  rlpHeaders,
  writeTrackerWorkbook,
  type TrackerWorkbookInput,
} from './payout-tracker.excel';
import {
  BAND_STYLE,
  COLOUR_KEY_INTRO,
  HEADER_TEXT,
  outletSheetSection,
  SECTION_FILL,
  summarySection,
  VALUE_RULES,
  type RagRule,
  type Section,
} from './payout-tracker.format';
import {
  RETAIL_COLUMNS,
  wsColumns,
  type NotBillingLine,
  type RetailRow,
  type RlpLine,
  type Row,
  type TrackerRows,
  type TrackerSummary,
  type WsRow,
} from './payout-tracker.types';

const INPUT: TrackerWorkbookInput = {
  clientName: 'Bajaj Consumer Care',
  month: '2026-11',
  monthLabel: 'November 2026',
  salesAsOf: '27 Nov 2026',
  provisional: true,
  quarterLabel: 'Oct–Dec 2026',
};
// 2026-11-27 06:35 UTC = 12:05 IST
const GENERATED = new Date(Date.UTC(2026, 10, 27, 6, 35));

function retailRow(over: Row): RetailRow {
  const cells: Row = {};
  for (const h of RETAIL_COLUMNS) cells[h] = null;
  Object.assign(cells, {
    Zone: 'North', State: 'Delhi', 'SM HQ': 'Delhi', 'ASM HQ': 'Delhi East', 'SO HQ': 'Shahdara', 'SAP Code': '0012345',
    'DB Name': 'ABC Distributors', TOWN: 'Delhi', 'POP STRATA': 'Metro', 'Customer Code': '000987654321', 'Customer Name': 'Sharma Stores',
    Program: 'Unnati', 'Sub- Program': 'Unnati', 'Outlet Type': 'SSS', 'Total Target': 50000, 'Total Ach': 58500.5, 'Total Ach %': 1.17,
    'ADHO Ach %': 1.2, 'Line Target': 12, 'Line Ach': 14, 'Line Ach %': 1.1667, 'Total Payout': 125000, 'Visibility Payout': 'NA',
    Reason: null, 'Gifsy Approval': 1, WOA: 1,
  });
  Object.assign(cells, over);
  return { cells, meta: { approved: true, lastMonthTotal: 1000, smKey: 'sm1', smLabel: 'Delhi', asmHq: 'Delhi East', zone: 'North' } };
}

function wsRow(over: Row): WsRow {
  const cells: Row = {};
  for (const h of wsColumns(INPUT.quarterLabel)) cells[h] = null;
  Object.assign(cells, {
    Zone: 'West', CODE: '0045', 'SAP Code': '7788', 'Customer Name': 'Patel Traders', Target: 200000, Ach: 150000.25, 'Ach%': 0.75,
    'Ach WOA': 0, 'Total Cases': 12.5, 'Base Points': 1250000, 'Total Points': 1300, [`Consistency Bonus (${INPUT.quarterLabel})`]: '— (paid in December 2026)',
    'Final Points': 1300, 'Gifsy Approval': 1,
  });
  Object.assign(cells, over);
  return { cells, meta: { approved: true, lastMonthTotal: null, smKey: 'sm2', smLabel: 'Mumbai', zone: 'West', totalAch: 150000.25 } };
}

function rlp(label: string, score: number | null, rank: number | null): RlpLine {
  return {
    label, outlets: 100, outletsOver100: 40, woa: 0.4, valueTarget: 1234567.5, valueAch: 1000000, achPct: 0.81, visEligible: 80,
    visAttempted: 60, visApproved: 45, visApprovedPct: 0.75, linesOver100: 30, linesPct: 0.3, score, rank,
  };
}
function nb(label: string): NotBillingLine {
  return { label, retailOutlets: 100, wsOutlets: 20, retailZero: 10, retailZeroPct: 0.1, wsZero: 5, wsZeroPct: 0.25, lmZeroRetail: 8, lmZeroWs: null as unknown as number };
}

const SUMMARY: TrackerSummary = {
  zoneRlp: [rlp('North', 0.6, 1), rlp('Total', 0.6, null)],
  zoneNotBilling: [nb('North'), nb('South'), nb('Total')],
  smRlp: [rlp('Delhi', 0.55, 1), rlp('Total', 0.55, null)],
  smNotBilling: [nb('Delhi'), nb('Total')],
  bottomAsm: [rlp('Delhi East', 0.2, 12)],
  totals: { retailPayout: 125000, wsPoints: 1300, retailOutlets: 1, wsOutlets: 1 },
};

const ROWS: TrackerRows = {
  retail: [retailRow({}), retailRow({ 'Customer Code': '=HYPERLINK("x")', 'Total Ach %': null })],
  ws: [wsRow({})],
  exceptions: [{ code: '00777', name: 'Ghost Outlet', reason: 'No sales chain (unassigned ISR)' }],
};

async function load(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

function rowValues(ws: ExcelJS.Worksheet, r: number, n: number): unknown[] {
  const out: unknown[] = [];
  for (let c = 1; c <= n; c++) out.push(ws.getCell(r, c).value);
  return out;
}

/** Find the 1-based row whose column A equals `text`. */
function findRow(ws: ExcelJS.Worksheet, text: string): number {
  for (let r = 1; r <= ws.rowCount; r++) if (ws.getCell(r, 1).value === text) return r;
  throw new Error(`row not found: ${text}`);
}

describe('writeTrackerWorkbook', () => {
  let wb: ExcelJS.Workbook;
  beforeAll(async () => {
    wb = await load(await writeTrackerWorkbook(INPUT, ROWS, SUMMARY, GENERATED));
  });

  it('writes sheets in order, Exceptions included when there are exceptions', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'retail', 'Ws', 'Exceptions', 'About']);
  });

  it('omits Exceptions when there are none', async () => {
    const b = await load(await writeTrackerWorkbook(INPUT, { ...ROWS, exceptions: [] }, SUMMARY, GENERATED));
    expect(b.worksheets.map((w) => w.name)).toEqual(['Summary', 'retail', 'Ws', 'About']);
  });

  describe('Summary', () => {
    let ws: ExcelJS.Worksheet;
    beforeAll(() => {
      ws = wb.getWorksheet('Summary')!;
    });

    it('has the title and the red bold provisional line', () => {
      expect(ws.getCell('A1').value).toBe('Bajaj Consumer Care — Payout Tracker — November 2026');
      const p = ws.getCell('A2');
      expect(p.value).toBe(
        'PROVISIONAL — November 2026 to date (sales up to 27 Nov 2026). Figures will change until the month is closed. Not a payment file.',
      );
      expect(p.font?.bold).toBe(true);
      expect(p.font?.color?.argb).toBe('FFC00000');
    });

    it('drops the provisional line for a closed month', async () => {
      const b = await load(await writeTrackerWorkbook({ ...INPUT, provisional: false }, ROWS, SUMMARY, GENERATED));
      const s = b.getWorksheet('Summary')!;
      expect(s.getCell('A2').value).toBeNull();
      expect(s.getCell('A3').value).toBe('1. Zone Summary - RLP');
      expect(JSON.stringify(rowValues(s, 1, 1))).not.toContain('PROVISIONAL');
    });

    it('lays out the five titled tables with exact headers, weights and a blank row between', () => {
      const titles = [
        ['1. Zone Summary - RLP', rlpHeaders('Zone'), true, SUMMARY.zoneRlp.length],
        ['2. Zone Summary - Outlets Not yet Started Billing', notBillingHeaders('Zone'), false, SUMMARY.zoneNotBilling.length],
        ['3. SM Summary - RLP', rlpHeaders('SM HQ'), true, SUMMARY.smRlp.length],
        ['4. SM Summary - Outlets Not yet Started Billing', notBillingHeaders('SM HQ'), false, SUMMARY.smNotBilling.length],
        ['5. Bottom 10 ASM HQs (by score)', rlpHeaders('ASM HQ'), true, SUMMARY.bottomAsm.length],
      ] as const;
      expect(findRow(ws, titles[0][0])).toBe(4); // title, provisional, blank
      let expectedNext = 4;
      for (const [title, headers, weighted, n] of titles) {
        const t = findRow(ws, title);
        expect(t).toBe(expectedNext);
        expect(ws.getCell(t, 1).font?.bold).toBe(true);
        const h = weighted ? t + 2 : t + 1;
        expect(rowValues(ws, h, headers.length)).toEqual([...headers]);
        expect(ws.getCell(h, 2).font?.bold).toBe(true);
        expect((ws.getCell(h, 2).fill as ExcelJS.FillPattern).fgColor?.argb).toBe(`FF${SECTION_FILL.outlet}`); // Outlet Count = outlet section
        expect((ws.getCell(h, 1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe(`FF${SECTION_FILL.hierarchy}`);
        expect(ws.getCell(h, 2).border?.top?.style).toBe('thin');
        if (weighted) {
          const w = t + 1;
          expect(rowValues(ws, w, 15)).toEqual([null, null, null, 0.3, null, null, 0.3, null, null, null, 0.2, null, 0.2, null, null]);
          expect(ws.getCell(w, 4).numFmt).toBe('0%');
          // weights sit exactly above WoA / Ach % / Approved % / % Outlets
          expect([ws.getCell(h, 4).value, ws.getCell(h, 7).value, ws.getCell(h, 11).value, ws.getCell(h, 13).value]).toEqual([
            'WoA', 'Ach %', 'Approved %', '% Outlets',
          ]);
        }
        const last = h + n;
        expect(ws.getCell(last + 1, 1).value).toBeNull(); // blank separator
        expectedNext = last + 2;
      }
    });

    it('exact RLP and not-billing header text', () => {
      expect(rlpHeaders('Zone')).toEqual([
        'Zone', 'Outlet Count - As approved by Gifsy', 'Outlets > 100%', 'WoA', 'Value Target', 'Value Ach', 'Ach %',
        'Outlets eligible for Visibility payout', 'Visibility attempted (Outlets)', 'Approved', 'Approved %',
        'Outlets With >100% Ach of Line', '% Outlets', 'Score', 'Rank',
      ]);
      expect(notBillingHeaders('SM HQ')).toEqual([
        'SM HQ', 'Outlet Count - As approved by Gifsy - Retail', 'Outlet Count - As approved by Gifsy - WS', 'Retail on ₹0 (this month)',
        'Retail %', 'WS on ₹0 (this month)', 'WS %', 'Last month ₹0 - Retail', 'Last month ₹0 - WS',
      ]);
    });

    it('writes values with formats and bolds the Total line only', () => {
      const t = findRow(ws, '1. Zone Summary - RLP');
      const north = t + 3;
      const total = t + 4;
      expect(ws.getCell(north, 1).value).toBe('North');
      expect(ws.getCell(north, 2).value).toBe(100);
      expect(ws.getCell(north, 2).numFmt).toBe('0');
      expect(ws.getCell(north, 4).value).toBe(0.4);
      expect(ws.getCell(north, 4).numFmt).toBe(FMT.PCT1); // value-coloured % → 1 decimal (owner 2026-11-27)
      for (const c of [7, 11, 13]) expect([c, ws.getCell(north, c).numFmt]).toEqual([c, FMT.PCT1]); // Ach %, Approved %, % Outlets
      expect(ws.getCell(total, 7).numFmt).toBe(FMT.PCT1); // Total row too (same column format, just not coloured)
      expect(ws.getCell(north, 5).value).toBe(1234567.5);
      expect(ws.getCell(north, 5).numFmt).toBe(FMT.MONEY); // summary ₹ = whole rupees, same as the email
      expect(ws.getCell(north, 14).numFmt).toBe(FMT.SCORE); // score 0–1, 2 decimals (not a %)
      expect(ws.getCell(north, 15).value).toBe(1);
      expect(ws.getCell(north, 1).font?.bold).toBeFalsy();
      expect(ws.getCell(total, 1).value).toBe('Total');
      expect(ws.getCell(total, 1).font?.bold).toBe(true);
      expect(ws.getCell(total, 5).font?.bold).toBe(true);
      expect(ws.getCell(total, 15).value).toBeNull(); // rank null → empty

      const nbT = findRow(ws, '2. Zone Summary - Outlets Not yet Started Billing');
      expect(ws.getCell(nbT + 2, 5).value).toBe(0.1);
      expect(ws.getCell(nbT + 2, 5).numFmt).toBe(FMT.PCT1); // Retail %
      expect(ws.getCell(nbT + 2, 7).numFmt).toBe(FMT.PCT1); // WS %
      expect(ws.getCell(nbT + 2, 4).numFmt).toBe('0'); // counts unchanged
      expect(ws.getCell(nbT + 2, 9).value).toBeNull();
      expect(ws.getCell(nbT + 4, 1).value).toBe('Total');
      expect(ws.getCell(nbT + 4, 1).font?.bold).toBe(true);
    });
  });

  describe('retail', () => {
    let ws: ExcelJS.Worksheet;
    beforeAll(() => {
      ws = wb.getWorksheet('retail')!;
    });

    it('header = RETAIL_COLUMNS exactly, bold + filled, frozen, auto-filtered', () => {
      expect(rowValues(ws, 1, RETAIL_COLUMNS.length)).toEqual([...RETAIL_COLUMNS]);
      expect(ws.getCell(1, RETAIL_COLUMNS.length + 1).value).toBeNull();
      expect(ws.getCell(1, 1).font?.bold).toBe(true);
      expect((ws.getCell(1, 1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe(`FF${SECTION_FILL.outlet}`); // Zone
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(ws.autoFilter).toBeTruthy();
      const widths = Array.from({ length: RETAIL_COLUMNS.length }, (_, i) => ws.getColumn(i + 1).width);
      // exceljs' reader collapses equal-width adjacent <col> ranges, so a few read back undefined — check the rest.
      const defined = widths.filter((w): w is number => typeof w === 'number');
      expect(defined.length).toBeGreaterThan(RETAIL_COLUMNS.length / 2);
      for (const w of defined) expect(w).toBeLessThanOrEqual(40);
      expect(ws.getColumn((RETAIL_COLUMNS as readonly string[]).indexOf('Customer Name') + 1).width).toBeGreaterThanOrEqual(15);
    });

    const col = (h: string) => (RETAIL_COLUMNS as readonly string[]).indexOf(h) + 1;

    it('stores codes as text (leading zeros kept)', () => {
      const cc = ws.getCell(2, col('Customer Code'));
      expect(cc.value).toBe('000987654321');
      expect(cc.type).toBe(ExcelJS.ValueType.String);
      expect(cc.numFmt).toBe('@');
      expect(ws.getCell(2, col('SAP Code')).value).toBe('0012345');
      expect(ws.getCell(2, col('SAP Code')).type).toBe(ExcelJS.ValueType.String);
    });

    it('applies number formats by column, keeps strings as text, null → empty', () => {
      expect(ws.getCell(2, col('Total Target')).value).toBe(50000);
      expect(ws.getCell(2, col('Total Target')).numFmt).toBe(FMT.VALUE);
      expect(ws.getCell(2, col('Total Ach')).value).toBe(58500.5);
      expect(ws.getCell(2, col('Total Ach %')).value).toBe(1.17);
      expect(ws.getCell(2, col('Total Ach %')).numFmt).toBe(FMT.PCT1); // 99.6% must not show as 100%
      expect(ws.getCell(2, col('Line Ach %')).numFmt).toBe(FMT.PCT1);
      expect(ws.getCell(2, col('Line Target')).numFmt).toBe('0');
      expect(ws.getCell(2, col('Total Payout')).value).toBe(125000);
      expect(ws.getCell(2, col('Total Payout')).numFmt).toBe(FMT.MONEY);
      expect(ws.getCell(2, col('Gifsy Approval')).value).toBe(1);
      expect(ws.getCell(2, col('Gifsy Approval')).numFmt).toBe('0');
      expect(ws.getCell(2, col('Visibility Payout')).value).toBe('NA');
      expect(ws.getCell(2, col('Visibility Payout')).type).toBe(ExcelJS.ValueType.String);
      expect(ws.getCell(2, col('Reason')).value).toBeNull();
      expect(ws.getCell(3, col('Total Ach %')).value).toBeNull();
    });

    it('neutralises formula-looking strings', () => {
      const c = ws.getCell(3, col('Customer Code'));
      expect(c.type).toBe(ExcelJS.ValueType.String);
      expect(c.value).toBe(`'=HYPERLINK("x")`);
      expect(c.formula).toBeUndefined();
    });
  });

  describe('Ws', () => {
    let ws: ExcelJS.Worksheet;
    const headers = wsColumns(INPUT.quarterLabel);
    const col = (h: string) => headers.indexOf(h) + 1;
    beforeAll(() => {
      ws = wb.getWorksheet('Ws')!;
    });

    it('header = wsColumns(quarterLabel) exactly, frozen + filtered', () => {
      expect(rowValues(ws, 1, headers.length)).toEqual(headers);
      expect(headers).toContain('Consistency Bonus (Oct–Dec 2026)');
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(ws.autoFilter).toBeTruthy();
    });

    it('writes cells with the right types and formats', () => {
      expect(ws.getCell(2, col('CODE')).value).toBe('0045');
      expect(ws.getCell(2, col('CODE')).type).toBe(ExcelJS.ValueType.String);
      expect(ws.getCell(2, col('SAP Code')).value).toBe('7788');
      expect(ws.getCell(2, col('SAP Code')).type).toBe(ExcelJS.ValueType.String);
      expect(ws.getCell(2, col('Ach%')).numFmt).toBe(FMT.PCT1);
      expect(ws.getCell(2, col('Target')).numFmt).toBe(FMT.VALUE);
      expect(ws.getCell(2, col('Total Cases')).value).toBe(12.5);
      expect(ws.getCell(2, col('Total Cases')).numFmt).toBe(FMT.CASES); // cases to 2 decimals
      expect(ws.getCell(2, col('Base Points')).numFmt).toBe(FMT.MONEY);
      expect(ws.getCell(2, col('Final Points')).numFmt).toBe(FMT.MONEY);
      expect(ws.getCell(2, col('Ach WOA')).value).toBe(0);
      expect(ws.getCell(2, col('Ach WOA')).numFmt).toBe('0');
      expect(ws.getCell(2, col('Consistency Bonus (Oct–Dec 2026)')).value).toBe('— (paid in December 2026)');
      expect(ws.getCell(2, col('FB1 Points')).value).toBeNull();
    });

    it('writes a numeric code as text if the row builder passes a number', async () => {
      const b = await load(await writeTrackerWorkbook(INPUT, { ...ROWS, ws: [wsRow({ CODE: 12345 })] }, SUMMARY, GENERATED));
      const c = b.getWorksheet('Ws')!.getCell(2, col('CODE'));
      expect(c.value).toBe('12345');
      expect(c.type).toBe(ExcelJS.ValueType.String);
    });
  });

  it('Exceptions sheet lists Code | Name | Reason', () => {
    const ws = wb.getWorksheet('Exceptions')!;
    expect(rowValues(ws, 1, 3)).toEqual(['Code', 'Name', 'Reason']);
    expect(rowValues(ws, 2, 3)).toEqual(['00777', 'Ghost Outlet', 'No sales chain (unassigned ISR)']);
    expect(ws.getCell(2, 1).type).toBe(ExcelJS.ValueType.String);
  });

  describe('About', () => {
    it('has client, month, status, sales-up-to, IST generated-at and the notes', () => {
      const ws = wb.getWorksheet('About')!;
      const all: unknown[][] = [];
      ws.eachRow((r) => all.push([r.getCell(1).value, r.getCell(2).value]));
      const kv = Object.fromEntries(all.filter((r) => r[1] != null).map((r) => [r[0], r[1]]));
      expect(kv['Client']).toBe('Bajaj Consumer Care');
      expect(kv['Month']).toBe('November 2026 (2026-11)');
      expect(String(kv['Status'])).toMatch(/^PROVISIONAL/);
      expect(kv['Sales up to']).toBe('27 Nov 2026');
      expect(kv['Generated at']).toBe('27 Nov 2026 12:05 IST');
      expect(String(kv['Exceptions'])).toContain('1 outlet');
      const col1 = all.map((r) => r[0]);
      for (const n of ABOUT_NOTES) expect(col1).toContain(n);
      expect(ABOUT_NOTES).toContain('Only outlets whose KYC is currently approved by Gifsy are included.');
      expect(ABOUT_NOTES).toContain('Gifsy Approval = 1 when the outlet earns a payout / points on the current figures.');
      expect(ABOUT_NOTES.some((n) => /KYC not approved|include only KYC-approved/.test(n))).toBe(false);
      expect(ABOUT_NOTES.some((n) => n.startsWith('Score = 30%'))).toBe(true);
    });

    it('prints every CLIENT data note as its own row under "Data notes" (formula-safe); ops-only notes never; none → no section', async () => {
      const notes = [
        { audience: 'client' as const, text: 'Consistency bonus (Oct–Dec 2026) not computed: October 2026 was imported' },
        { audience: 'ops' as const, text: 'OPS ONLY: 3 outlet code(s) not in the master: A, B, C' },
        { audience: 'client' as const, text: '=HYPERLINK("x")' },
      ];
      const b = await load(await writeTrackerWorkbook({ ...INPUT, notes }, ROWS, SUMMARY, GENERATED));
      const col1: unknown[] = [];
      b.getWorksheet('About')!.eachRow((r) => col1.push(r.getCell(1).value));
      const at = col1.indexOf('Data notes');
      expect(at).toBeGreaterThan(-1);
      expect(col1[at + 1]).toBe(notes[0].text);
      expect(String(col1[at + 2])).not.toMatch(/^=/); // cellSafe
      expect(String(col1[at + 2])).toContain('HYPERLINK');
      expect(col1.some((v) => String(v).includes('OPS ONLY'))).toBe(false);
      const opsOnly = await load(await writeTrackerWorkbook({ ...INPUT, notes: [notes[1]] }, ROWS, SUMMARY, GENERATED));
      const c2: unknown[] = [];
      opsOnly.getWorksheet('About')!.eachRow((r) => c2.push(r.getCell(1).value));
      expect(c2).not.toContain('Data notes');
      const none: unknown[] = [];
      wb.getWorksheet('About')!.eachRow((r) => none.push(r.getCell(1).value));
      expect(none).not.toContain('Data notes');
    });

    it('says FINAL for a closed month', async () => {
      const b = await load(await writeTrackerWorkbook({ ...INPUT, provisional: false }, ROWS, SUMMARY, GENERATED));
      expect(String(b.getWorksheet('About')!.getCell(3, 2).value)).toMatch(/^FINAL/);
    });
  });

  it('formatIst crosses the IST day boundary', () => {
    expect(formatIst(new Date(Date.UTC(2026, 11, 31, 19, 0)))).toBe('01 Jan 2027 00:30 IST');
  });

  it('empty rows + empty summary still produce a valid workbook', async () => {
    const empty: TrackerSummary = {
      zoneRlp: [], zoneNotBilling: [], smRlp: [], smNotBilling: [], bottomAsm: [],
      totals: { retailPayout: 0, wsPoints: 0, retailOutlets: 0, wsOutlets: 0 },
    };
    const b = await load(await writeTrackerWorkbook(INPUT, { retail: [], ws: [], exceptions: [] }, empty, GENERATED));
    expect(b.worksheets.map((w) => w.name)).toEqual(['Summary', 'retail', 'Ws', 'About']);
    expect(rowValues(b.getWorksheet('retail')!, 1, RETAIL_COLUMNS.length)).toEqual([...RETAIL_COLUMNS]);
    expect(b.getWorksheet('retail')!.getCell(2, 1).value).toBeNull();
    const s = b.getWorksheet('Summary')!;
    const t = findRow(s, '1. Zone Summary - RLP');
    expect(s.getCell(t + 3, 1).value).toBe(NO_DATA_TEXT);
    expect(findRow(s, '5. Bottom 10 ASM HQs (by score)')).toBeGreaterThan(t);
    expect(provisionalLine('X', 'Y')).toContain('Not a payment file.');
    expect(FMT.MONEY).toContain('[>=100000]');
  });
});

// ─── Visual formatting (owner 2026-11-27): section-coloured headers + conditional formatting on Summary values only ──
describe('writeTrackerWorkbook — visual formatting', () => {
  let wb: ExcelJS.Workbook;
  type CF = {
    ref: string;
    rules: Array<{
      type: string;
      formulae?: string[];
      cfvo?: Array<{ type: string; value?: number }>;
      style?: { fill?: { bgColor?: { argb?: string } }; font?: { color?: { argb?: string } } };
    }>;
  };
  const cfsOf = (b: ExcelJS.Workbook, name: string): CF[] =>
    (b.getWorksheet(name) as unknown as { conditionalFormattings?: CF[] }).conditionalFormattings ?? [];
  const cfs = (name: string) => cfsOf(wb, name);
  const headerFill = (ws: ExcelJS.Worksheet, r: number, c: number) => (ws.getCell(r, c).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;

  beforeAll(async () => {
    wb = await load(await writeTrackerWorkbook(INPUT, ROWS, SUMMARY, GENERATED));
  });

  it('retail header: each column filled by its section, white bold text, 6 sections', () => {
    const ws = wb.getWorksheet('retail')!;
    const expectSection: Record<string, Section> = {
      Zone: 'outlet', 'Customer Name': 'outlet', Program: 'outlet', 'SM HQ': 'hierarchy', 'ISR Name': 'hierarchy',
      'Total Target': 'target', 'Line Target': 'target', 'Total Ach': 'achievement', 'FB Ach %': 'achievement', WOA: 'achievement',
      'Visibility Status': 'visibility', 'Potential Payout': 'visibility', 'Total Payout': 'outcome', 'Visibility Payout': 'outcome',
      Reason: 'outcome', 'Gifsy Approval': 'outcome',
    };
    for (const [h, s] of Object.entries(expectSection)) {
      const c = (RETAIL_COLUMNS as readonly string[]).indexOf(h) + 1;
      expect([h, headerFill(ws, 1, c)]).toEqual([h, `FF${SECTION_FILL[s]}`]);
      expect(ws.getCell(1, c).font?.color?.argb).toBe(`FF${HEADER_TEXT}`);
      expect(ws.getCell(1, c).font?.bold).toBe(true);
    }
    const fills = new Set(RETAIL_COLUMNS.map((_, i) => headerFill(ws, 1, i + 1)));
    expect(fills.size).toBe(6);
    for (const f of fills) expect(Object.values(SECTION_FILL).map((x) => `FF${x}`)).toContain(f);
  });

  it('Ws header: points / bonus / final points = outcome; cases = achievement; Target = target', () => {
    const ws = wb.getWorksheet('Ws')!;
    const headers = wsColumns(INPUT.quarterLabel);
    const at = (h: string) => headerFill(ws, 1, headers.indexOf(h) + 1);
    expect(at('Target')).toBe(`FF${SECTION_FILL.target}`);
    expect(at('Ach%')).toBe(`FF${SECTION_FILL.achievement}`);
    expect(at('FB2 Cases')).toBe(`FF${SECTION_FILL.achievement}`);
    expect(at('Base Points')).toBe(`FF${SECTION_FILL.outcome}`);
    expect(at('Consistency Bonus (Oct–Dec 2026)')).toBe(`FF${SECTION_FILL.outcome}`);
    expect(at('Final Points')).toBe(`FF${SECTION_FILL.outcome}`);
    expect(at('ASM HQ')).toBe(`FF${SECTION_FILL.hierarchy}`);
    expect(at('WH Name')).toBe(`FF${SECTION_FILL.outlet}`);
    expect(outletSheetSection('Something new')).toBe('outlet');
  });

  it('outlet rows stay plain: NO conditional formatting on retail / Ws / Exceptions / About, no data-cell fill', () => {
    for (const name of ['retail', 'Ws', 'Exceptions', 'About']) expect([name, cfs(name)]).toEqual([name, []]);
    const ws = wb.getWorksheet('retail')!;
    for (let c = 1; c <= RETAIL_COLUMNS.length; c++) expect(headerFill(ws, 2, c)).toBeUndefined();
  });

  it('Summary headers are section-coloured (label = hierarchy, Value Target = target, Score = outcome…)', () => {
    const ws = wb.getWorksheet('Summary')!;
    const h = findRow(ws, '1. Zone Summary - RLP') + 2;
    rlpHeaders('Zone').forEach((name, i) => {
      expect([name, headerFill(ws, h, i + 1)]).toEqual([name, `FF${SECTION_FILL[summarySection(name, i)]}`]);
    });
    expect(summarySection('Value Target', 4)).toBe('target');
    expect(summarySection('Approved %', 10)).toBe('visibility');
    expect(summarySection('Score', 13)).toBe('outcome');
    const nbh = findRow(ws, '2. Zone Summary - Outlets Not yet Started Billing') + 1;
    expect(headerFill(ws, nbh, 5)).toBe(`FF${SECTION_FILL.achievement}`); // Retail %
    expect(headerFill(ws, nbh, 8)).toBe(`FF${SECTION_FILL.outlet}`); // Last month ₹0 - Retail
  });

  it('Summary CF: RAG on ratio columns, colour scales on Score and ₹ — data rows only, never a Total row', () => {
    const ws = wb.getWorksheet('Summary')!;
    const list = cfs('Summary');
    expect(list.length).toBeGreaterThan(0);
    const t1 = findRow(ws, '1. Zone Summary - RLP');
    const north = t1 + 3; // title, weights, header, North, Total
    const total = t1 + 4;
    const byRef = new Map(list.map((c) => [c.ref, c]));

    const ach = byRef.get(`G${north}:G${north}`)!; // Ach %
    expect(ach).toBeDefined();
    expect(ach.rules.map((r) => r.type)).toEqual(['expression', 'expression', 'expression']);
    const x = `ROUND(G${north},3)`; // banded on the value rounded to the printed 1-decimal %
    expect(ach.rules[0].formulae![0]).toBe(`AND(ISNUMBER(G${north}),${x}>=1)`);
    expect(ach.rules[1].formulae![0]).toBe(`AND(ISNUMBER(G${north}),${x}>=0.9,${x}<1)`);
    expect(ach.rules[2].formulae![0]).toBe(`AND(ISNUMBER(G${north}),${x}<0.9)`);
    expect(ach.rules[0].style?.fill?.bgColor?.argb).toBe(`FF${BAND_STYLE.green.fill}`);
    expect(ach.rules[2].style?.font?.color?.argb).toBe(`FF${BAND_STYLE.red.text}`);
    for (const col of ['D', 'K', 'M']) expect([col, byRef.has(`${col}${north}:${col}${north}`)]).toEqual([col, true]); // WoA, Approved %, % Outlets

    const score = byRef.get(`N${north}:N${north}`)!;
    expect(score.rules[0].type).toBe('colorScale');
    expect(score.rules[0].cfvo).toEqual([{ type: 'num', value: 0.4 }, { type: 'num', value: 0.6 }, { type: 'num', value: 0.8 }]);
    // ₹ min→max scale is skipped on a ONE-data-row table (Excel would paint it blue; the email shows white)
    expect(byRef.has(`E${north}:E${north}`)).toBe(false);
    expect(byRef.has(`F${north}:F${north}`)).toBe(false);

    // counts / rank / label columns: never formatted
    for (const col of ['A', 'B', 'C', 'H', 'I', 'J', 'L', 'O']) expect([col, [...byRef.keys()].some((k) => k.startsWith(col))]).toEqual([col, false]);

    // no range on the Summary sheet touches ANY Total row
    const totalRows: number[] = [];
    ws.eachRow((row, r) => {
      if (row.getCell(1).value === 'Total') totalRows.push(r);
    });
    expect(totalRows).toContain(total);
    for (const c of list) {
      const [, a, b] = /^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(c.ref)!;
      for (const tr of totalRows) expect([c.ref, tr >= Number(a) && tr <= Number(b)]).toEqual([c.ref, false]);
    }
    expect(ws.getCell(total, 7).font?.bold).toBe(true);
    expect(headerFill(ws, total, 7)).toBe('FFF4F6FA');

    // not-billing: Retail % (E) / WS % (G), lower is better, over North..South; counts plain
    const nbT = findRow(ws, '2. Zone Summary - Outlets Not yet Started Billing');
    const nbcf = byRef.get(`E${nbT + 2}:E${nbT + 3}`)!;
    expect(nbcf.rules[0].formulae![0]).toBe(`AND(ISNUMBER(E${nbT + 2}),ROUND(E${nbT + 2},3)<=0.1)`);
    expect(nbcf.rules[2].formulae![0]).toBe(`AND(ISNUMBER(E${nbT + 2}),ROUND(E${nbT + 2},3)>0.25)`);
    expect(byRef.has(`G${nbT + 2}:G${nbT + 3}`)).toBe(true);
    expect(byRef.has(`D${nbT + 2}:D${nbT + 3}`)).toBe(false);

    // Bottom ASM (no Total row) is formatted too
    const bT = findRow(ws, '5. Bottom 10 ASM HQs (by score)');
    expect(byRef.has(`G${bT + 3}:G${bT + 3}`)).toBe(true);
  });

  it('keeps the Indian-grouping numFmt (quoted commas) on coloured ₹ cells', () => {
    const ws = wb.getWorksheet('Summary')!;
    const north = findRow(ws, '1. Zone Summary - RLP') + 3;
    expect(ws.getCell(north, 5).numFmt).toBe(FMT.MONEY);
    expect(FMT.MONEY).toContain('##","##","##0');
    expect(FMT.MONEY.includes(String.fromCharCode(92))).toBe(false); // no backslash escapes
  });

  it('a table that is ONLY a Total row gets no conditional formatting', async () => {
    const onlyTotal: TrackerSummary = { ...SUMMARY, zoneRlp: [rlp('Total', 0.6, null)], zoneNotBilling: [], smRlp: [], smNotBilling: [], bottomAsm: [] };
    const b = await load(await writeTrackerWorkbook(INPUT, ROWS, onlyTotal, GENERATED));
    expect(cfsOf(b, 'Summary')).toEqual([]);
  });

  it('₹ min→max scale present on a table with ≥ 2 data rows (Total still excluded)', async () => {
    const two: TrackerSummary = { ...SUMMARY, zoneRlp: [rlp('North', 0.6, 1), rlp('East', 0.5, 2), rlp('Total', 0.55, null)] };
    const b = await load(await writeTrackerWorkbook(INPUT, ROWS, two, GENERATED));
    const s = b.getWorksheet('Summary')!;
    const first = findRow(s, '1. Zone Summary - RLP') + 3;
    const refs = new Map(cfsOf(b, 'Summary').map((c) => [c.ref, c]));
    expect(refs.get(`E${first}:E${first + 1}`)!.rules[0].cfvo!.map((c) => c.type)).toEqual(['min', 'max']);
    expect(refs.get(`F${first}:F${first + 1}`)!.rules[0].type).toBe('colorScale');
    expect(s.getCell(first + 2, 1).value).toBe('Total');
  });

  it('Total detection is the shared exact-label helper (a "total"-ish label is a normal row)', async () => {
    const odd: TrackerSummary = { ...SUMMARY, zoneRlp: [rlp(' total ', 0.6, 1), rlp('Total', 0.6, null)], zoneNotBilling: [], smRlp: [], smNotBilling: [], bottomAsm: [] };
    const b = await load(await writeTrackerWorkbook(INPUT, ROWS, odd, GENERATED));
    const s = b.getWorksheet('Summary')!;
    const first = findRow(s, '1. Zone Summary - RLP') + 3;
    expect(cfsOf(b, 'Summary').some((c) => c.ref === `G${first}:G${first}`)).toBe(true); // coloured like any data row
    expect(s.getCell(first, 1).font?.bold).toBeFalsy();
    expect(s.getCell(first + 1, 1).font?.bold).toBe(true);
  });

  it('ragFormula / colLetter helpers', () => {
    expect(ragFormula('E5', VALUE_RULES['Retail %'] as RagRule, 'amber')).toBe('AND(ISNUMBER(E5),ROUND(E5,3)>0.1,ROUND(E5,3)<=0.25)');
    expect([colLetter(1), colLetter(15), colLetter(26), colLetter(27), colLetter(52)]).toEqual(['A', 'O', 'Z', 'AA', 'AZ']);
  });

  it('About sheet carries the colour key', () => {
    const col1: unknown[] = [];
    wb.getWorksheet('About')!.eachRow((r) => col1.push(r.getCell(1).value));
    const at = col1.indexOf(COLOUR_KEY_INTRO);
    expect(at).toBeGreaterThan(-1);
    expect(String(col1[at + 1])).toContain('Ach %: green ≥ 100%');
  });
});
