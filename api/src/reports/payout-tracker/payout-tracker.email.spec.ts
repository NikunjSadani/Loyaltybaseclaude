import * as fs from 'fs';
import * as path from 'path';
import {
  escapeHtml, fmtInt, fmtMoney, fmtPct, fmtScore, renderTrackerEmail, RLP_HEADERS_TAIL, NOT_BILLING_HEADERS_TAIL,
} from './payout-tracker.email';
import type { NotBillingLine, RlpLine, TrackerSummary } from './payout-tracker.types';

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
    expect((prov.html.match(/<table /g) ?? []).length).toBe(5);
    expect((prov.html.match(/Score \(0–1\) = 30% WoA \+ 30% Ach % \+ 20% Approved % \+ 20% % Outlets\. Rank 1 = best\./g) ?? []).length).toBe(3);
    // RLP header order exactly as the Excel
    const thead = prov.html.slice(prov.html.indexOf('<thead>'), prov.html.indexOf('</thead>'));
    const ths = [...thead.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(ths).toEqual(['Zone', ...RLP_HEADERS_TAIL].map(escapeHtml));
  });

  it('cells formatted: Indian grouping, ₹, %, score, null → –', () => {
    expect(prov.html).toContain('>₹1,23,45,678</td>');
    expect(prov.html).toContain('>₹1,44,44,443</td>');
    expect(prov.html).toContain('>117%</td>');
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
    expect(h).toContain('background-color:#E7ECF3;font-weight:bold;');
    expect(h).toContain('padding:6px 8px;border:1px solid #d0d7e2;');
    expect(h).toContain('This is an automated report from Gifsy.');
  });

  it('plain text: pipe-separated aligned lines', () => {
    const lines = prov.text.split('\n');
    const header = lines.find((l) => l.startsWith('Zone ') && l.includes('| WoA |'))!;
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

  it('writes a preview fixture for humans', () => {
    const dir = path.join(__dirname, '__fixtures__');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'email-preview.html'), prov.html, 'utf8');
    expect(fs.existsSync(path.join(dir, 'email-preview.html'))).toBe(true);
  });
});
