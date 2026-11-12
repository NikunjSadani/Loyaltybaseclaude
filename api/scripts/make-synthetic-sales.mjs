#!/usr/bin/env node
/**
 * Synthetic DMS-style sales file generator for Sales Import staging checks (plan §13.2). OWNER: Lane I.
 * (Plain .mjs, not .ts: a .ts outside api/src would break `nest build` with TS6059.)
 *
 * Writes a CSV and an .xlsx with the SAME content: a marker row of "X", a header row, then ~2,000
 * invoice lines over the PREVIOUS month (starting on the 5th → a partial month) and the CURRENT month
 * (from the 1st up to today), across the given outlet codes plus 50 unknown customer codes, with
 * returns (negative lines) and 3 rows with an invalid date. Prints the exact expected totals.
 * All values are synthetic; outlet codes are whatever you pass in.
 *
 * Usage:
 *   node scripts/make-synthetic-sales.mjs --codes 1001,1002,1003 [--out <dir>] [--lines 2000] [--seed 7]
 *   node scripts/make-synthetic-sales.mjs --codes-file codes.txt   (one code per line)
 *
 * Column mapping to enter in Settings (neutral headers):
 *   outletCode "CUSTOMER CODE", outletName "CUSTOMER", invoiceDate "INVOICE DATE", amount "NET AMT",
 *   quantity "QTY (CASES)", dimensions brand ← "CODE", skuGroup ← "CLUB SKU", dateOrder DMY, headerRow auto.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
let codes = args.codes ? String(args.codes).split(',') : [];
if (args['codes-file']) codes = readFileSync(args['codes-file'], 'utf8').split(/\r?\n/);
codes = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
if (!codes.length) {
  console.error('Pass --codes a,b,c or --codes-file <file> (real roster outlet codes of the test tenant).');
  process.exit(2);
}
const outDir = resolve(args.out ?? '.');
const nLines = Number(args.lines ?? 2000);
let seed = Number(args.seed ?? 7);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

// IST "today" and the two months (relative to now: date-relative rule).
const ist = new Date(Date.now() + 330 * 60_000);
const y = ist.getUTCFullYear();
const m = ist.getUTCMonth();
const today = ist.getUTCDate();
const prevStart = new Date(Date.UTC(y, m - 1, 5));
const prevEnd = new Date(Date.UTC(y, m, 0));
const curStart = new Date(Date.UTC(y, m, 1));
const curEnd = new Date(Date.UTC(y, m, today));
const dayBetween = (a, b) => new Date(a.getTime() + Math.floor(rnd() * ((b - a) / 86_400_000 + 1)) * 86_400_000);
const dmy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

const BRANDS = ['ALPHA', 'BETA', 'GAMMA'];
const SKUS = ['50', '200', '500'];
const unknown = Array.from({ length: 50 }, (_, i) => `ZZ${String(90000 + i)}`);
const HEADER = ['INVOICE DATE', 'INVOICE NO', 'CUSTOMER CODE', 'CUSTOMER', 'CODE', 'CLUB SKU', 'NET AMT', 'QTY (CASES)'];

const rows = [];
const totals = {}; // month → { matchedPaise, matchedMicro, matchedOutlets:Set, unmatchedPaise, unmatchedCustomers:Set, lines }
const tot = (k) => (totals[k] ??= { lines: 0, matchedPaise: 0n, matchedMicro: 0n, matchedOutlets: new Set(), unmatchedPaise: 0n, unmatchedMicro: 0n, unmatchedCustomers: new Set() });
for (let i = 0; i < nLines; i++) {
  const prev = rnd() < 0.5;
  const d = prev ? dayBetween(prevStart, prevEnd) : dayBetween(curStart, curEnd);
  const isUnknown = rnd() < 0.08;
  const code = isUnknown ? pick(unknown) : pick(codes);
  const isReturn = rnd() < 0.05;
  const paise = BigInt(Math.floor(500 + rnd() * 500000)) * (isReturn ? -1n : 1n);
  const micro = BigInt(Math.floor(1 + rnd() * 40) * 10000) * (isReturn ? -1n : 1n); // 0.01 .. 0.40 cases
  rows.push([dmy(d), `INV${100000 + i}`, code, `Shop ${code}`, pick(BRANDS), pick(SKUS), Number(paise) / 100, Number(micro) / 1e6]);
  const t = tot(monthKey(d));
  t.lines++;
  if (isUnknown) {
    t.unmatchedPaise += paise;
    t.unmatchedMicro += micro;
    t.unmatchedCustomers.add(code);
  } else {
    t.matchedPaise += paise;
    t.matchedMicro += micro;
    t.matchedOutlets.add(code);
  }
}
const BAD = ['31-02-2026', 'not a date', '00-00-0000'];
for (const b of BAD) rows.push([b, 'INVBAD', pick(codes), 'Shop', 'ALPHA', '500', 1, 1]);

mkdirSync(outDir, { recursive: true });
const q = (v) => (typeof v === 'string' && /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
const csv = [HEADER.map(() => 'X'), HEADER, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
const csvPath = join(outDir, 'synthetic-sales.csv');
writeFileSync(csvPath, csv, 'utf8');

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Sales');
ws.addRow(HEADER.map(() => 'X'));
ws.addRow(HEADER);
for (const r of rows) {
  const m2 = /^(\d{2})-(\d{2})-(\d{4})$/.exec(r[0]);
  const asDate = m2 && !BAD.includes(r[0]) ? new Date(Date.UTC(+m2[3], +m2[2] - 1, +m2[1])) : r[0];
  const row = ws.addRow([asDate, ...r.slice(1)]);
  if (asDate instanceof Date) row.getCell(1).numFmt = 'dd-mm-yyyy';
}
const xlsxPath = join(outDir, 'synthetic-sales.xlsx');
await wb.xlsx.writeFile(xlsxPath);

const fmt = (p) => (Number(p) / 100).toFixed(2);
console.log(`Wrote ${csvPath} and ${xlsxPath}: ${rows.length} data rows (${BAD.length} with an invalid date → skipped).`);
for (const [k, t] of Object.entries(totals).sort()) {
  console.log(
    `${k}: lines=${t.lines} matchedOutlets=${t.matchedOutlets.size} matched ₹=${fmt(t.matchedPaise)} matched cases=${Number(t.matchedMicro) / 1e6} ` +
      `unmatchedCustomers=${t.unmatchedCustomers.size} unmatched ₹=${fmt(t.unmatchedPaise)} unmatched cases=${Number(t.unmatchedMicro) / 1e6}`,
  );
}
console.log(`Expect: rowsSkipped=${BAD.length}; previous month starts on the 5th → STARTS_AFTER_FIRST (partial-month ack needed).`);
console.log('Note: "matched" assumes every --codes entry is a live roster outlet of the tenant.');
