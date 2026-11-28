import * as fs from 'fs';
import * as path from 'path';
import {
  escapeHtml, fmtInt, fmtMoney, fmtPct, fmtPct1, fmtScore, renderTrackerEmail, RLP_HEADERS_TAIL, NOT_BILLING_HEADERS_TAIL,
} from './payout-tracker.email';
import type { NotBillingLine, RlpLine, TrackerSummary } from './payout-tracker.types';
import {
  BAND_STYLE, BODY_TEXT, COLOUR_KEY_INTRO, contrast, HEADER_TEXT, SCALE2_COLORS, SCALE3_COLORS, scale2Color, scale3Color,
  SECTION_FILL, summarySection, TOTAL_FILL, VALUE_RULES, type Scale3Rule, type RagRule, ragBand, isTotalLabel,
} from './payout-tracker.format';
import { valueTone } from './payout-tracker.email';

function rlp(label: string, over: Partial<RlpLine> = {}): RlpLine {
  return {
    label, outlets: 120, outletsOver100: 48, woa: 0.4, valueTarget: 12345678, valueAch: 14444443, achPct: 1.17,
    visEligible: 100, visAttempted: 80, visApproved: 60, visApprovedPct: 0.75, linesOver100: 30, linesPct: 0.25,
    score: 0.84321, rank: 1, ...over,
  };
}
function nb(label: string, over: Partial<NotBillingLine> = {}): NotBillingLine {
  return {
    label, retailOutlets: 1500, wsOutlets: 210, retailZero: 300, retailZeroPct: 0.2, wsZero: 21, wsZeroPct: 0.1,
    lmZeroRetail: 250, lmZeroWs: 18, ...over,
  };
}

const summary: TrackerSummary = {
  zoneRlp: [rlp('West 1 (MHG) — Sachin Shenoy'), rlp('North', { rank: 2, score: 0.5 }), rlp('Total', { rank: null, outlets: 240 })],
  zoneNotBilling: [nb('West 1'), nb('South', { retailZeroPct: null, wsZeroPct: null, retailOutlets: 0, wsOutlets: 0 }), nb('Total')],
  smRlp: [rlp('Pune & <Nashik> "HQ"', { woa: null, score: null, rank: null }), rlp('Total', { rank: null })],
  smNotBilling: [nb('Pune & <Nashik> "HQ"'), nb('Total')],
  bottomAsm: Array.from({ length: 10 }, (_, i) => rlp(`ASM HQ ${i + 1}`, { rank: 40 + i, score: 0.3 - i * 0.01 })),
  totals: { retailPayout: 5480610, wsPoints: 459659, retailOutlets: 1500, wsOutlets: 210 },
};

const meta = { clientName: 'Bajaj Consumer Care', monthLabel: 'November 2026', salesAsOf: '27 Nov 2026', provisional: true };
const closed = { ...meta, provisional: false };

describe('payout-tracker email — formatting', () => {
  it('Indian grouping, no decimals', () => {
    expect(fmtInt(12345678)).toBe('1,23,45,678');
    expect(fmtInt(1234567.6)).toBe('12,34,568');
    expect(fmtInt(999)).toBe('999');
    expect(fmtInt(1000)).toBe('1,000');
    expect(fmtInt(100000)).toBe('1,00,000');
    expect(fmtInt(0)).toBe('0');
    expect(fmtInt(-1234567)).toBe('-12,34,567');
    expect(fmtInt(null)).toBe('–');
    expect(fmtInt(NaN)).toBe('–');
  });
  it('money ₹, % whole, score 2-decimal %', () => {
    expect(fmtMoney(5480610)).toBe('₹54,80,610');
    expect(fmtMoney(-1500)).toBe('-₹1,500');
    expect(fmtMoney(null)).toBe('–');
    expect(fmtPct(1.17)).toBe('117%');
    expect(fmtPct(0.255)).toBe('26%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(null)).toBe('–');
    expect(fmtPct1(0.996)).toBe('99.6%');
    expect(fmtPct1(1.17)).toBe('117.0%');
    expect(fmtPct1(0.2556)).toBe('25.6%');
    expect(fmtPct1(0)).toBe('0.0%');
    expect(fmtPct1(null)).toBe('–');
    expect(fmtScore(0.84321)).toBe('0.84');
    expect(fmtScore(null)).toBe('–');
  });
  it('escapes HTML', () => {
    expect(escapeHtml(`A & <b> "c" 'd'`)).toBe('A &amp; &lt;b&gt; &quot;c&quot; &#39;d&#39;');
  });
});

describe('renderTrackerEmail', () => {
  const prov = renderTrackerEmail(meta, summary);
  const fin = renderTrackerEmail(closed, summary);

  it('subject in both modes', () => {
    expect(prov.subject).toBe('PROVISIONAL – Bajaj Consumer Care Payout Tracker – November 2026 (sales up to 27 Nov 2026)');
    expect(fin.subject).toBe('Bajaj Consumer Care Payout Tracker – November 2026 (sales up to 27 Nov 2026)');
  });

  it('intro sentence + provisional box only when provisional', () => {
    expect(prov.html).toContain('Dear Team,');
    expect(prov.html).toContain(
      'Please find below the November 2026 payout tracker summary (provisional — sales up to 27 Nov 2026; figures will change until the month is closed). The outlet-level detail is in the attached Excel.',
    );
    expect(fin.html).toContain('Please find below the November 2026 payout tracker summary. The outlet-level detail is in the attached Excel.');
    expect(prov.html).toContain('PROVISIONAL – not a payment file');
    expect(prov.html).toMatch(/background-color:#FFF4D6;border:1px solid #D99A00/);
    expect(fin.html).not.toContain('not a payment file');
    expect(fin.html).not.toContain('#FFF4D6');
    expect(prov.text).toContain('PROVISIONAL – not a payment file');
    expect(fin.text).not.toContain('not a payment file');
  });

  it('all 5 titles in order + headers present', () => {
    const titles = [
      '1. Zone Summary – RLP',
      '2. Zone Summary – Outlets Not yet Started Billing',
      '3. SM Summary – RLP',
      '4. SM Summary – Outlets Not yet Started Billing',
      '5. Bottom 10 ASM HQs (by score)',
    ];
    let last = -1;
    for (const t of titles) {
      const i = prov.html.indexOf(`font-weight:bold;font-size:15px;color:#1f2933;">${escapeHtml(t)}</p>`);
      expect(i).toBeGreaterThan(last);
      last = i;
      expect(prov.text).toContain(t);
    }
    for (const h of [...RLP_HEADERS_TAIL, ...NOT_BILLING_HEADERS_TAIL]) {
      expect(prov.html).toContain(`>${escapeHtml(h)}</th>`);
    }
    expect(prov.html).toContain('>Zone</th>');
    expect(prov.html).toContain('>SM HQ</th>');
    expect(prov.html).toContain('>ASM HQ</th>');
    expect((prov.html.match(/<table [^>]*min-width:600px/g) ?? []).length).toBe(5); // + 1 small colour-key table
    expect((prov.html.match(/Score \(0–1\) = 30% WoA \+ 30% Ach % \+ 20% Approved % \+ 20% % Outlets\. Rank 1 = best\./g) ?? []).length).toBe(3);
    // RLP header order exactly as the Excel
    const thead = prov.html.slice(prov.html.indexOf('<thead>'), prov.html.indexOf('</thead>'));
    const ths = [...thead.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(ths).toEqual(['Zone', ...RLP_HEADERS_TAIL].map(escapeHtml));
  });

  it('cells formatted: Indian grouping, ₹, %, score, null → –', () => {
    expect(prov.html).toContain('>₹1,23,45,678</td>');
    expect(prov.html).toContain('>₹1,44,44,443</td>');
    expect(prov.html).toContain('>117.0%</td>');
    expect(prov.html).toContain('>0.84</td>');
    expect(prov.html).toContain('>1,500</td>');
    expect(prov.html).toContain('>–</td>');
    expect(prov.text).toContain('₹1,23,45,678');
  });

  it('escapes dynamic labels', () => {
    expect(prov.html).toContain('West 1 (MHG) — Sachin Shenoy');
    expect(prov.html).toContain('Pune &amp; &lt;Nashik&gt; &quot;HQ&quot;');
    expect(prov.html).not.toContain('<Nashik>');
    const nasty = renderTrackerEmail({ ...meta, clientName: 'A&B <x>', monthLabel: '<script>' }, summary);
    expect(nasty.html).toContain('A&amp;B &lt;x&gt;');
    expect(nasty.html).not.toMatch(/<script/i);
  });

  it('Total row bold with light background', () => {
    expect(prov.html).toMatch(/<tr style="font-weight:bold;background-color:#F4F6FA;"><td [^>]*font-weight:bold;[^>]*>Total<\/td>/);
    const nonTotal = prov.html.match(/<tr[^>]*><td [^>]*>North<\/td>/)![0];
    expect(nonTotal).not.toContain('font-weight:bold');
  });

  it('mobile-safe document: viewport, text-size-adjust, inline CSS only, no style/script/img', () => {
    const h = prov.html;
    expect(h.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(h).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(h).toContain('-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%');
    expect(h).toContain('font-family:Arial,Helvetica,sans-serif;font-size:14px');
    expect(h).toContain('color:#1f2933');
    expect(h).not.toMatch(/<style/i);
    expect(h).not.toMatch(/<script/i);
    expect(h).not.toMatch(/<img/i);
    expect(h).not.toMatch(/<link/i);
    expect(h).not.toMatch(/https?:\/\//i);
    expect((h.match(/<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%">/g) ?? []).length).toBe(5);
    expect(h).toContain('border-collapse:collapse;font-size:13px;min-width:600px');
    expect(h).toContain(`bgcolor="#${SECTION_FILL.hierarchy}" style="padding:6px 8px;border:1px solid #d0d7e2;background-color:#${SECTION_FILL.hierarchy};color:#FFFFFF;font-weight:bold;`);
    expect(h).not.toMatch(/class=|linear-gradient|display:\s*flex/i);
    expect(h).toContain('padding:6px 8px;border:1px solid #d0d7e2;');
    expect(h).toContain('This is an automated report from Gifsy.');
  });

  it('plain text: pipe-separated aligned lines', () => {
    const lines = prov.text.split('\n');
    const header = lines.find((l) => l.startsWith('Zone ') && /\|\s+WoA \|/.test(l))!; // WoA right-aligned under 1-decimal values
    expect(prov.text).toContain('117.0%'); // value-coloured % columns are 1-decimal in the text too
    const total = lines.find((l) => l.startsWith('Total') && l.includes('|'))!;
    expect(header).toBeDefined();
    expect(header.length).toBe(total.length);
    expect(prov.text).toContain('This is an automated report from Gifsy.');
  });

  it('data notes: CLIENT notes only, in an escaped "Data notes" box ABOVE the footer (html + text); ops-only / none → no box', () => {
    expect(prov.html).not.toContain('Data notes');
    const opsOnly = renderTrackerEmail({ ...meta, notes: [{ audience: 'ops', text: 'OPS ONLY codes' }] }, summary);
    expect(opsOnly.html).not.toContain('Data notes');
    expect(opsOnly.html + opsOnly.text).not.toContain('OPS ONLY');
    const r = renderTrackerEmail(
      {
        ...meta,
        notes: [
          { audience: 'client', text: '2 outlets <b>left off</b>' },
          { audience: 'ops', text: 'OPS ONLY codes' },
          { audience: 'client', text: 'bonus & co' },
        ],
      },
      summary,
    );
    expect(r.html + r.text).not.toContain('OPS ONLY');
    const box = r.html.indexOf('Data notes');
    expect(box).toBeGreaterThan(-1);
    expect(box).toBeLessThan(r.html.indexOf('This is an automated report from Gifsy.'));
    expect(r.html).toContain('2 outlets &lt;b&gt;left off&lt;/b&gt;');
    expect(r.html).toContain('bonus &amp; co');
    expect(r.html).not.toContain('<b>left off</b>');
    expect(r.text).toMatch(/Data notes[\s\S]*- 2 outlets <b>left off<\/b>[\s\S]*This is an automated report/);
  });

  it('empty tables render a "No data" row (no crash)', () => {
    const empty: TrackerSummary = { ...summary, zoneRlp: [], bottomAsm: [] };
    const r = renderTrackerEmail(closed, empty);
    expect((r.html.match(/>No data<\/td>/g) ?? []).length).toBe(2);
  });

  describe('visual formatting (owner 2026-11-27)', () => {
    /** The <td> whose text is exactly `text` in the row whose label cell is `label` (first match). */
    const cellOf = (html: string, label: string, text: string): string => {
      const row = html.match(new RegExp(`<tr[^>]*><td [^>]*>${label}</td>.*?</tr>`))![0];
      return row.match(new RegExp(`<td [^>]*>${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</td>`))![0];
    };

    it('headers are coloured by section, inline + bgcolor, white text', () => {
      const thead = prov.html.slice(prov.html.indexOf('<thead>'), prov.html.indexOf('</thead>'));
      const ths = [...thead.matchAll(/<th bgcolor="#([0-9A-F]{6})" style="[^"]*background-color:#\1;color:#FFFFFF;[^"]*">([^<]*)<\/th>/g)];
      expect(ths.length).toBe(1 + RLP_HEADERS_TAIL.length);
      ths.forEach((m, i) => expect([m[2], m[1]]).toEqual([m[2], SECTION_FILL[summarySection(i === 0 ? 'Zone' : RLP_HEADERS_TAIL[i - 1], i)]]));
      expect(new Set(ths.map((m) => m[1])).size).toBe(6);
    });

    it('RAG by thresholds: Ach % 117% green, 95% amber, 80% red; WoA 40% amber; Approved % 75% amber; Retail % 20% amber', () => {
      const s: TrackerSummary = {
        ...summary,
        zoneRlp: [
          rlp('North', { achPct: 1.17 }), rlp('East', { achPct: 0.95 }), rlp('West', { achPct: 0.8 }), rlp('South', { achPct: 0.996 }),
          rlp('Total', { achPct: 0.5, rank: null }),
        ],
      };
      const h = renderTrackerEmail(meta, s).html;
      const g = BAND_STYLE.green, a = BAND_STYLE.amber, r = BAND_STYLE.red;
      expect(cellOf(h, 'North', '117.0%')).toContain(`bgcolor="#${g.fill}" style="padding:6px 8px;border:1px solid #d0d7e2;text-align:right;white-space:nowrap;background-color:#${g.fill};color:#${g.text};"`);
      expect(cellOf(h, 'East', '95.0%')).toContain(`background-color:#${a.fill};color:#${a.text};`);
      expect(cellOf(h, 'West', '80.0%')).toContain(`background-color:#${r.fill};color:#${r.text};`);
      // 99.6% (target missed) reads "99.6%", not "100%", and is amber — number and colour agree (owner 2026-11-27)
      expect(cellOf(h, 'South', '99.6%')).toContain(`background-color:#${a.fill};`);
      expect(cellOf(h, 'North', '40.0%')).toContain(`#${a.fill}`); // WoA 0.4 → amber (30–50%)
      expect(cellOf(h, 'North', '75.0%')).toContain(`#${a.fill}`); // Approved % 0.75 → amber (60–80%)
      expect(cellOf(h, 'North', '25.0%')).toContain(`#${r.fill}`); // % Outlets 0.25 → red (< 30%)
      expect(cellOf(prov.html, 'West 1', '20.0%')).toContain(`#${a.fill}`); // Retail % 0.2 → amber (lower is better)
      expect(cellOf(prov.html, 'West 1', '10.0%')).toContain(`#${g.fill}`); // WS % 0.1 → green (≤ 10%)
      // counts / rank stay plain
      expect(cellOf(h, 'North', '120')).not.toContain('background-color');
    });

    it('colour matches the PRINTED number: band on the value rounded to 1-decimal %', () => {
      const g = BAND_STYLE.green, a = BAND_STYLE.amber;
      const ach = VALUE_RULES['Ach %'] as RagRule;
      const woa = VALUE_RULES['WoA'] as RagRule;
      const ret = VALUE_RULES['Retail %'] as RagRule;
      expect([fmtPct1(0.99951), ragBand(ach, 0.99951)]).toEqual(['100.0%', 'green']);
      expect([fmtPct1(0.29951), ragBand(woa, 0.29951)]).toEqual(['30.0%', 'amber']);
      expect([fmtPct1(0.10049), ragBand(ret, 0.10049)]).toEqual(['10.0%', 'green']);
      expect([fmtPct1(0.9994), ragBand(ach, 0.9994)]).toEqual(['99.9%', 'amber']);
      const s: TrackerSummary = {
        ...summary,
        zoneRlp: [rlp('North', { achPct: 0.99951, woa: 0.29951 }), rlp('Total', { rank: null })],
        zoneNotBilling: [nb('West 1', { retailZeroPct: 0.10049 }), nb('Total')],
      };
      const h = renderTrackerEmail(meta, s).html;
      expect(cellOf(h, 'North', '100.0%')).toContain(`background-color:#${g.fill};`);
      expect(cellOf(h, 'North', '30.0%')).toContain(`background-color:#${a.fill};`);
      expect(cellOf(h, 'West 1', '10.0%')).toContain(`background-color:#${g.fill};`);
    });

    it('one-data-row table: ₹ scale stays white (matches Excel, which writes no scale rule)', () => {
      const s: TrackerSummary = { ...summary, zoneRlp: [rlp('North'), rlp('Total', { rank: null })] };
      const h = renderTrackerEmail(meta, s).html;
      expect(cellOf(h, 'North', '₹1,44,44,443')).toContain(`background-color:#${SCALE2_COLORS.min};`);
    });

    it('Total detection = exact "Total" label (shared helper with Excel)', () => {
      const s: TrackerSummary = { ...summary, zoneRlp: [rlp(' total '), rlp('Total', { rank: null })] };
      const h = renderTrackerEmail(meta, s).html;
      expect((h.match(/<tr style="font-weight:bold;background-color:#F4F6FA;">/g) ?? []).length).toBe(
        (renderTrackerEmail(meta, summary).html.match(/<tr style="font-weight:bold;background-color:#F4F6FA;">/g) ?? []).length,
      );
      expect(isTotalLabel('Total')).toBe(true);
      expect(isTotalLabel(' total ')).toBe(false);
      expect(isTotalLabel('TOTAL')).toBe(false);
    });

    it('Total rows are NEVER value-coloured (bold, light fill only); null ratios stay plain', () => {
      const s: TrackerSummary = { ...summary, zoneRlp: [rlp('North'), rlp('Total', { achPct: 0.5, rank: null })] };
      const h = renderTrackerEmail(meta, s).html;
      const totalRow = h.match(/<tr style="font-weight:bold;background-color:#F4F6FA;">.*?<\/tr>/)![0];
      expect(totalRow).toContain('>50.0%</td>');
      expect(totalRow).not.toMatch(/bgcolor|<td [^>]*background-color/);
      for (const b of Object.values(BAND_STYLE)) expect(totalRow).not.toContain(b.fill);
      expect(`#${TOTAL_FILL}`).toBe('#F4F6FA');
      // SM row with woa=null + score=null: '–' cells, no colour
      const pune = prov.html.match(/<tr[^>]*><td [^>]*>Pune &amp; &lt;Nashik&gt; &quot;HQ&quot;<\/td>.*?<\/tr>/)![0];
      for (const td of pune.match(/<td [^>]*>–<\/td>/g)!) expect(td).not.toContain('background-color');
    });

    it('Score: fixed-anchor scale (0.40 red → 0.60 yellow → 0.80 green, clamped); ₹ = white → blue over the table', () => {
      const rule = VALUE_RULES['Score'] as Scale3Rule;
      expect(scale3Color(rule, 0.4)).toBe(SCALE3_COLORS.min);
      expect(scale3Color(rule, 0.1)).toBe(SCALE3_COLORS.min);
      expect(scale3Color(rule, 0.6)).toBe(SCALE3_COLORS.mid);
      expect(scale3Color(rule, 0.95)).toBe(SCALE3_COLORS.max);
      expect(scale3Color(rule, null)).toBeNull();
      expect(scale2Color(5, 5, 10)).toBe(SCALE2_COLORS.min);
      expect(scale2Color(10, 5, 10)).toBe(SCALE2_COLORS.max);
      expect(scale2Color(7, 7, 7)).toBe(SCALE2_COLORS.min); // flat range
      expect(valueTone('Value Ach', 5, 10, { lo: 5, hi: 10 })).toEqual({ bg: `#${SCALE2_COLORS.max}`, fg: `#${BODY_TEXT}` });
      expect(valueTone('Rank', 14, 1, null)).toBeNull();
      expect(valueTone('Ach %', 0, 1, null)).toBeNull(); // label column never
      // in the rendered email: higher ₹ → the blue end, lower → white end (within the table, Total excluded)
      const s: TrackerSummary = { ...summary, zoneRlp: [rlp('North', { valueAch: 100 }), rlp('East', { valueAch: 900 }), rlp('Total', { valueAch: 1000, rank: null })] };
      const h = renderTrackerEmail(meta, s).html;
      expect(cellOf(h, 'North', '₹100')).toContain(`background-color:#${SCALE2_COLORS.min};`);
      expect(cellOf(h, 'East', '₹900')).toContain(`background-color:#${SCALE2_COLORS.max};`);
      expect(cellOf(h, 'North', '0.84')).toContain('background-color:#'); // score coloured
    });

    it('colour is never the only signal: numbers printed, colour key present; every text/fill pair ≥ 4.5:1', () => {
      expect(prov.html).toContain(escapeHtml(COLOUR_KEY_INTRO));
      expect(prov.html).toContain('Ach %: green ≥ 100% · amber 90% to &lt; 100% · red &lt; 90%');
      expect(prov.html).toContain('>On track</td>');
      for (const f of Object.values(SECTION_FILL)) expect([f, contrast(HEADER_TEXT, f) >= 4.5]).toEqual([f, true]);
      for (const b of Object.values(BAND_STYLE)) expect([b.fill, contrast(b.text, b.fill) >= 4.5]).toEqual([b.fill, true]);
      for (const f of [...Object.values(SCALE3_COLORS), ...Object.values(SCALE2_COLORS)]) {
        expect([f, contrast(BODY_TEXT, f) >= 4.5]).toEqual([f, true]);
      }
    });

    it('text fallback carries no colour key / colour markup', () => {
      expect(prov.text).not.toContain(COLOUR_KEY_INTRO);
      expect(prov.text).not.toMatch(/#[0-9A-F]{6}|bgcolor|On track/);
    });
  });

  it('writes a preview fixture for humans', () => {
    const dir = path.join(__dirname, '__fixtures__');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'email-preview.html'), prov.html, 'utf8');
    expect(fs.existsSync(path.join(dir, 'email-preview.html'))).toBe(true);
  });
});
