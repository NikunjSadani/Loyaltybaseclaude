#!/usr/bin/env node
/**
 * Bajaj HELD OPENING BALANCES manifest builder (client migration, owner-approved 2026-11-21).
 *
 * The 11-Nov-2026 vendor Earn & Burn import (BAJAJ-PROD-OUTLET-IMPORT.md §9b) loaded 2,281 wallets. Vendor File 2
 * (FY26-27 cumulative report, closing at 11 Nov 2026) also has outlets with a NON-ZERO closing that were NOT in that
 * import (not on prod / no wallet yet). This script builds their dated passbooks for the held-opening-balances
 * loader (api/src/wallet/held-opening-balances/held-balances-load.main.ts) — it reads files only, never a database.
 *
 * Passbook = the SAME method as the prod import builder (scratchpad eb_build_prod_spljun.js), per outlet:
 *  - outlet present in File 1 (history Apr 2025 → 31 Oct 2026): monthly EARN at the file's header dates, SPL
 *    scratch payouts 30 Jun 2025, FY26-27 redemptions by their real periods, FY25-26 lapse 30 Jun 2026, 1–11 Nov
 *    redemptions 11 Nov 2026, pre-Apr-25 over-redemption recovery as ADJUST 1 Apr 2025; every event rounded, the
 *    rounding difference put on the largest event so Σ events == the target;
 *  - outlet ONLY in File 2: LastYearCarryForward as "Opening balance carried from last year" (1 Apr 2026), monthly
 *    Earn_<month> at the 1st of the month, Burn_<month> at the month end (November → 11 Nov 2026, when the vendor
 *    stopped redemptions), same rounding rule;
 *  - TARGET (every outlet): the vendor's own 11-Nov closing (File 2 ClosingPoints) ROUNDED to whole points.
 *
 * Usage (paths are arguments — nothing client-specific is hard-coded):
 *   node api/scripts/bajaj-held-opening-balances-manifest.mjs \
 *     --file1 "<…>/2026.11.04/Earn  Burn Points of 25 to 26  Expire points data Year 25.xlsx" \
 *     --file2 "<…>/2026.11.04/12.11/WholesalerCumulativePointsReport2026-2027 (1).xls" \
 *     --imported "<scratchpad>/prodimport/bajaj-prod-earnburn-manifest-spljun.json" \
 *     --out "<scratchpad>/bajaj-held-opening-balances-2026-11-11.json" [--expect-outlets 40]
 * Exit: 0 ok · 2 bad args · 4 header / coherence mismatch (nothing written).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const X = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'xlsx'));

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
for (const k of ['file1', 'file2', 'imported', 'out']) {
  if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
}
const die = (msg) => { console.error(`ABORT: ${msg}`); process.exit(4); };

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const r2 = (n) => Math.round(n);
const inr = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const a = X.utils.sheet_to_json(X.readFile(args.file1).Sheets['File'], { header: 1, defval: '' });
const b = X.utils.sheet_to_json(X.readFile(args.file2).Sheets['Sheet1'], { header: 1, defval: '' });

// ── header assertions (column plans are positional — fail loudly if a layout differs) ──
const h1 = a[1].map(norm);
const need = [[6, 'CODE'], [79, '(2025-2026)FY Laps Points'], [102, 'Final Closing Points'], [101, 'Total Burn Points( 16 Oct to'], [77, 'Total Burn Points ( 1 April'], [86, 'Total Burn Points ( 1 July T'], [93, 'Total Burn Points ( 26 Aug t'], [98, 'Total Burn Points ( 16 Sep t'], [100, 'Oct 26 ( 16 Oct to 31Oct)']];
for (const [i, p] of need) if (!h1[i].startsWith(p)) die(`File 1 header col ${i}: "${h1[i]}" (expected "${p}…")`);
const bh = b[0].map(norm);
const F2 = { code: 8, name: 7, earn0: 10, burn0: 22, earnTotal: 34, burnTotal: 35, carry: 36, closing: 37 };
const MONTHS = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
if (bh[F2.code] !== 'OutletCode' || bh[F2.closing] !== 'ClosingPoints' || bh[F2.carry] !== 'LastYearCarryForward' || bh[F2.earnTotal] !== 'EarnTotal' || bh[F2.burnTotal] !== 'BurnTotal') die('File 2 header mismatch');
MONTHS.forEach((m, i) => {
  if (bh[F2.earn0 + i] !== `Earn_${m}` || bh[F2.burn0 + i] !== `Burn_${m}`) die(`File 2 month header mismatch at ${m}`);
});

// ── File 1 plan: IDENTICAL to eb_build_prod_spljun.js ──
const EARN = [[13, '2025-04-01', 'Points earned'], [14, '2025-05-01', 'Points earned'], [15, '2025-06-01', 'Points earned'],
  [22, '2025-07-01', 'Points earned'], [23, '2025-08-25', 'Points earned'], [24, '2025-09-25', 'Points earned'], [25, '2025-10-25', 'Points earned'], [26, '2025-11-25', 'Points earned'], [27, '2025-12-25', 'Points earned'],
  [29, '2026-01-26', 'Points earned'], [31, '2026-02-26', 'Points earned'], [33, '2026-03-01', 'Points earned'],
  [16, '2025-06-30', 'Points earned — SPL4 Scratch Payout'], [17, '2025-06-30', 'Points earned — SPL5 Scratch Payout'], [18, '2025-06-30', 'Points earned — SPL6 Scratch Payout'], [19, '2025-06-30', 'Points earned — SPL 7.0 Scratch Payout'],
  [20, '2025-09-25', 'Points earned — SPL MAH Sept'], [21, '2025-11-25', 'Points earned — Bottle QPS Nov-25'], [28, '2025-12-25', 'Points earned — Dec-25 Aligned'], [30, '2026-01-26', 'Points earned — Jan-26 Aligned'], [32, '2026-01-26', 'Points earned — Jan-26 Aligned'],
  [50, '2026-04-01', 'Points earned'], [51, '2026-05-01', 'Points earned'], [81, '2026-06-01', 'Points earned'], [82, '2026-07-01', 'Points earned'], [88, '2026-08-01', 'Points earned'], [95, '2026-09-01', 'Points earned'], [89, '2026-07-31', 'Points earned — Jun/Jul approval']];
const BURN = [[35, '2025-05-01'], [36, '2025-06-01'], [37, '2025-07-01'], [38, '2025-08-01'], [39, '2025-09-25'], [40, '2025-10-15'], [41, '2025-10-31'], [42, '2025-11-25'], [43, '2025-12-25'], [44, '2026-01-26'], [45, '2026-02-20'], [46, '2026-02-28'], [47, '2026-03-31'],
  [53, '2026-04-30'], [58, '2026-05-20'], [63, '2026-05-31'], [68, '2026-06-30'], [84, '2026-07-31'], [85, '2026-08-25'], [91, '2026-08-31'], [92, '2026-09-15'], [96, '2026-09-30'], [97, '2026-10-15'], [100, '2026-10-31']];
const BURN_TOTALS = [[77, [53, 58, 63, 68]], [86, [84, 85]], [93, [91, 92]], [98, [96, 97]], [101, [100]]];
const LAPS = 79, LAPS_DATE = '2026-06-30', NOV_DATE = '2026-11-11';
const RANK = { EARN: 0, ADJUST: 1, REDEEM: 2, EXPIRE: 3 };
const RECOVERY_DATE = '2025-04-01', RECOVERY_LABEL = "Last year's over-redemption recovered";
const reconcile = (evs, target) => {
  const rd = evs.map((e) => ({ ...e, p: r2(e.v) })).filter((e) => e.p !== 0);
  if (!rd.length) return target ? null : [];
  const d = target - rd.reduce((s, e) => s + e.p, 0);
  if (d) { let k = 0; for (let j = 1; j < rd.length; j++) if (Math.abs(rd[j].p) > Math.abs(rd[k].p)) k = j; rd[k].p += d; }
  return rd.filter((e) => e.p !== 0);
};
const sortEv = (ev) => ev.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : RANK[x.t] - RANK[y.t]));

function fromFile1(code, r, q) {
  for (const [t, parts] of BURN_TOTALS) {
    if (Math.abs(num(r[t]) - parts.reduce((x, i) => x + num(r[i]), 0)) > 0.01) die(`BURN SPLIT MISMATCH ${code} col ${t}`);
  }
  const earnRaw = EARN.map(([i, d, l]) => ({ v: num(r[i]), date: d, label: l })).filter((e) => e.v !== 0);
  const burnRaw = BURN.map(([i, d]) => ({ v: num(r[i]), date: d })).filter((e) => e.v !== 0);
  const burnT = r2(burnRaw.reduce((s, e) => s + e.v, 0)), lapsT = r2(num(r[LAPS]));
  const nov = r2(num(q[F2.burn0 + 7]));
  if (num(q[F2.earn0 + 7])) die(`UNEXPECTED Nov earn ${code}`);
  const vendorClose = r2(num(q[F2.closing]));
  const netOct = vendorClose + nov;
  const earnCols = r2(earnRaw.reduce((s, e) => s + e.v, 0));
  const recovery = netOct - (earnCols - burnT - lapsT);
  const recEv = Math.abs(recovery) > 1 ? [{ d: RECOVERY_DATE, t: recovery < 0 ? 'ADJUST' : 'EARN', p: recovery, l: recovery < 0 ? RECOVERY_LABEL : 'Opening balance carried from last year' }] : [];
  const grossT = netOct + burnT + lapsT - (Math.abs(recovery) > 1 ? recovery : 0);
  const earn = reconcile(earnRaw, grossT), burn = reconcile(burnRaw, burnT);
  if (earn === null || burn === null) die(`RECONCILE ${code}: target with no source events`);
  const ev = sortEv([
    ...recEv,
    ...earn.map((e) => (e.p > 0 ? { d: e.date, t: 'EARN', p: e.p, l: e.label } : { d: e.date, t: 'ADJUST', p: e.p, l: e.label.replace('Points earned', 'Points reversed') })),
    ...burn.map((e) => ({ d: e.date, t: 'REDEEM', p: -e.p, l: 'Points redeemed' })),
    ...(lapsT ? [{ d: LAPS_DATE, t: 'EXPIRE', p: -lapsT, l: 'Points expired' }] : []),
    ...(nov ? [{ d: NOV_DATE, t: 'REDEEM', p: -nov, l: 'Points redeemed (1–11 Nov 2026)' }] : []),
  ]);
  return { ev, vendorClose, recovery: Math.abs(recovery) > 1 ? recovery : 0 };
}

// FY26-27 month → (earn date, burn date). November burn = 11 Nov (redemptions stopped).
const F2_DATES = [['2026-04-01', '2026-04-30'], ['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-06-30'], ['2026-07-01', '2026-07-31'], ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-11'], ['2026-12-01', '2026-12-31'], ['2027-01-01', '2027-01-31'], ['2027-02-01', '2027-02-28'], ['2027-03-01', '2027-03-31']];
function fromFile2Only(code, q) {
  const vendorClose = r2(num(q[F2.closing]));
  const carry = num(q[F2.carry]);
  const earnRaw = MONTHS.map((_m, i) => ({ v: num(q[F2.earn0 + i]), date: F2_DATES[i][0], label: 'Points earned' })).filter((e) => e.v !== 0);
  const burnRaw = MONTHS.map((_m, i) => ({ v: num(q[F2.burn0 + i]), date: F2_DATES[i][1] })).filter((e) => e.v !== 0);
  // vendor's own coherence: carry + Σearn − Σburn == closing (to the paisa)
  const sumE = earnRaw.reduce((s, e) => s + e.v, 0), sumB = burnRaw.reduce((s, e) => s + e.v, 0);
  if (Math.abs(carry + sumE - sumB - num(q[F2.closing])) > 0.01) die(`FILE 2 COHERENCE ${code}: carry ${carry} + earn ${sumE} − burn ${sumB} ≠ closing ${q[F2.closing]}`);
  if (Math.abs(sumE - num(q[F2.earnTotal])) > 0.01 || Math.abs(sumB - num(q[F2.burnTotal])) > 0.01) die(`FILE 2 TOTALS ${code}`);
  const burnT = r2(sumB);
  const grossT = vendorClose + burnT; // carry + earns, rounded to tie out to the rounded closing
  const credits = [...(carry ? [{ v: carry, date: '2026-04-01', label: 'Opening balance carried from last year' }] : []), ...earnRaw];
  const earn = reconcile(credits, grossT), burn = reconcile(burnRaw, burnT);
  if (earn === null || burn === null) die(`RECONCILE ${code}: target with no source events`);
  const ev = sortEv([
    ...earn.map((e) => (e.p > 0 ? { d: e.date, t: 'EARN', p: e.p, l: e.label } : { d: e.date, t: 'ADJUST', p: e.p, l: e.label === 'Points earned' ? 'Points reversed' : "Last year's balance (negative) carried" })),
    ...burn.map((e) => ({ d: e.date, t: 'REDEEM', p: -e.p, l: e.date === '2026-11-11' ? 'Points redeemed (1–11 Nov 2026)' : 'Points redeemed' })),
  ]);
  return { ev, vendorClose, recovery: 0 };
}

const imported = JSON.parse(fs.readFileSync(args.imported, 'utf8'));
const IMPORTED = new Set((Array.isArray(imported) ? imported : imported.outlets).map((r) => String(r.code ?? r.outletCode)));
const A = new Map();
for (const r of a.slice(2)) { const c = norm(r[6]); if (c) A.set(c, r); }

const out = [];
const st = { file2Rows: 0, importedInFile2: 0, zeroNotImported: 0, held: 0, fromFile1: 0, fromFile2Only: 0, events: 0 };
let rawHeld = 0, roundedHeld = 0, rawImported = 0, rawAll = 0;
for (const q of b.slice(1)) {
  const code = norm(q[F2.code]);
  if (!code) continue;
  st.file2Rows++;
  const raw = num(q[F2.closing]);
  rawAll += raw;
  if (IMPORTED.has(code)) { st.importedInFile2++; rawImported += raw; continue; }
  if (raw === 0) { st.zeroNotImported++; continue; }
  const r = A.get(code);
  const res = r ? fromFile1(code, r, q) : fromFile2Only(code, q);
  const bal = res.ev.reduce((s, e) => s + e.p, 0);
  if (bal !== res.vendorClose) die(`COHERENCE ${code}: Σ events ${bal} ≠ rounded closing ${res.vendorClose}`);
  if (!res.ev.length) die(`EMPTY PASSBOOK ${code}`);
  for (const e of res.ev) {
    if (!Number.isInteger(e.p) || e.p === 0 || (e.t === 'EARN') !== (e.p > 0)) die(`BAD EVENT ${code} ${JSON.stringify(e)}`);
  }
  st.held++; st.events += res.ev.length; r ? st.fromFile1++ : st.fromFile2Only++;
  rawHeld += raw; roundedHeld += res.vendorClose;
  out.push({ outletCode: code, closingPoints: res.vendorClose, events: res.ev, vendorClosingRaw: raw, outletName: norm(q[F2.name]), origin: r ? 'FILE1+FILE2' : 'FILE2_ONLY', ...(res.recovery ? { recovery: res.recovery } : {}) });
}
if (args['expect-outlets'] && Number(args['expect-outlets']) !== out.length) die(`expected ${args['expect-outlets']} outlets, built ${out.length}`);
out.sort((x, y) => (x.outletCode < y.outletCode ? -1 : 1));
fs.writeFileSync(args.out, JSON.stringify(out, null, 0));

const importedRounded = (Array.isArray(imported) ? imported : imported.outlets).reduce((s, r) => s + (r.net ?? r.closingPoints ?? 0), 0);
const round2 = (n) => Math.round(n * 100) / 100;
console.log(JSON.stringify(st));
console.log(`held outlets: ${out.length} | Σ vendor closing (raw) ${inr(round2(rawHeld))} | Σ held rounded per outlet ${inr(roundedHeld)} | rounding ${inr(round2(rawHeld - roundedHeld))}`);
console.log(`reconciliation: vendor total (File 2) ${inr(round2(rawAll))} = imported raw ${inr(round2(rawImported))} (${IMPORTED.size} wallets, rounded ${inr(importedRounded)}) + held raw ${inr(round2(rawHeld))} (${out.length}) + zero-balance ${st.zeroNotImported} outlets`);
console.log(`  rounded: imported ${inr(importedRounded)} + held ${inr(roundedHeld)} = ${inr(importedRounded + roundedHeld)}; vendor − rounded = ${inr(round2(rawAll - importedRounded - roundedHeld))} (rounding)`);
console.log(`wrote ${args.out}`);
