/**
 * Wallet statement → PDF Blob, built in the browser with the existing jsPDF (D6), lazy-loaded so
 * it stays out of the page bundle. Shared by the partner wallet and the sales outlet ledger.
 *
 * TEXT / FONT: this uses jsPDF's built-in Helvetica, which only covers WinAnsi (Latin-1 + a few
 * punctuation marks) — so `pdfSafe` writes ₹ as "Rs." and any other character it can't draw as
 * "?" (never dropped). This is the owner's FINAL D9 decision ("Rs." + names in English letters): an
 * embedded Unicode font was rejected because jsPDF has no complex-script shaping (one code point →
 * one glyph via the font cmap, no GSUB/GPOS), so Devanagari would render visibly wrong. See
 * platform/docs/plans/WALLET-STATEMENT-EXPORT-PLAN.md §"D9 FINDING".
 */
import { formatISTDate, formatISTDateTime } from '@/lib/ist-date';
import { EMPTY_STATEMENT_TEXT } from './statement-xlsx';
import type { StatementDoc } from './statement-model';
import { neutralFulfillerText } from '@/lib/fulfiller-name';

// cp1252 (WinAnsi) characters outside Latin-1 that Helvetica CAN draw.
const WINANSI_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Make a string drawable by Helvetica: ₹ → "Rs.", anything outside WinAnsi → "?". */
export function pdfSafe(s: string): string {
  let out = '';
  // OWNER RULE (2026-11-26): a downloaded statement never names the voucher fulfiller ("Hubble" → "Via API").
  for (const ch of neutralFulfillerText(s).replace(/₹\s?/g, 'Rs.')) {
    const c = ch.codePointAt(0) ?? 0;
    const ok = (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRAS.has(ch);
    out += ok ? ch : '?';
  }
  return out;
}

const fmtPoints = (n: number) => n.toLocaleString('en-IN');
const fmtInr = (n: number) =>
  `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// A4 portrait, mm.
const PW = 210;
const PH = 297;
const M = 14;
const BOTTOM = PH - 16; // keep clear of the footer
const LINE_H = 3.8;
// Column x positions (left edge, or right edge for right-aligned numeric columns).
const COL = {
  date: M,
  desc: M + 23,
  descW: 70,
  type: M + 96,
  points: M + 140, // right edge
  balance: M + 160, // right edge
  amount: PW - M, // right edge
};

export async function statementToPdfBlob(doc: StatementDoc): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: false });
  let y = M;

  const text = (s: string, x: number, yy: number, align?: 'right') =>
    pdf.text(pdfSafe(s), x, yy, align ? { align } : undefined);

  const columnHeader = () => {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(80, 80, 80);
    text('Date', COL.date, y);
    text('Description', COL.desc, y);
    text('Type', COL.type, y);
    text('Points', COL.points, y, 'right');
    text('Balance', COL.balance, y, 'right');
    text('Amount', COL.amount, y, 'right');
    pdf.setDrawColor(200, 200, 200);
    pdf.line(M, y + 1.5, PW - M, y + 1.5);
    y += 5;
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(30, 30, 30);
  };

  /** Page-break pattern (as so-declaration.ts): new page + repeated column header on overflow. */
  const ensureSpace = (need: number) => {
    if (y + need > BOTTOM) {
      pdf.addPage();
      y = M;
      columnHeader();
    }
  };

  // ── Header block (page 1) ──
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.setTextColor(26, 26, 46);
  text(doc.title, M, y + 2);
  y += 9;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(60, 60, 60);
  // Long outlet names wrap instead of running off the page.
  for (const line of pdf.splitTextToSize(pdfSafe(`${doc.outletName} (${doc.outletCode})`), PW - 2 * M) as string[]) {
    pdf.text(line, M, y);
    y += 4.5;
  }
  text(`Period: ${doc.periodLabel}`, M, y);
  y += 4.5;
  text(`Generated: ${formatISTDateTime(doc.generatedAt)}`, M, y);
  y += 6;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(26, 26, 46);
  text('Opening balance', M, y);
  text(`${fmtPoints(doc.openingBalance)} pts`, PW - M, y, 'right');
  y += 7;

  columnHeader();

  if (doc.lines.length === 0) {
    pdf.setFontSize(9);
    text(EMPTY_STATEMENT_TEXT, M, y + 2);
    y += 8;
  }

  pdf.setFontSize(8);
  // Tallest row that is kept on one page; anything taller flows line-by-line across pages.
  const MAX_ROW_ON_ONE_PAGE = BOTTOM - M - 10;
  for (const l of doc.lines) {
    // The description is printed IN FULL (no line limit); the row height adapts.
    const descLines = pdf.splitTextToSize(pdfSafe(l.description), COL.descW) as string[];
    const extra = l.kind === 'payout' && l.utr ? [pdfSafe(`UTR: ${l.utr}`)] : [];
    const allDesc = [...descLines, ...extra];
    const h = allDesc.length * LINE_H + 1.2;
    ensureSpace(Math.min(h, MAX_ROW_ON_ONE_PAGE));
    const base = y;
    text(formatISTDate(l.date), COL.date, base);
    text(l.type, COL.type, base);
    if (l.kind === 'points') {
      text(fmtPoints(l.points), COL.points, base, 'right');
      text(fmtPoints(l.balance), COL.balance, base, 'right');
    } else {
      text(fmtInr(l.amountInr), COL.amount, base, 'right');
    }
    allDesc.forEach((d, i) => {
      if (i > 0 && y + LINE_H > BOTTOM) {
        // Only a row taller than a page gets here: continue it on the next page (header repeated).
        pdf.addPage();
        y = M;
        columnHeader();
        pdf.setFontSize(8);
      } else if (i > 0) {
        y += LINE_H;
      }
      pdf.text(d, COL.desc, y);
    });
    y += LINE_H + 1.2;
  }

  // ── Closing balance ──
  ensureSpace(10);
  pdf.setDrawColor(200, 200, 200);
  pdf.line(M, y - 1, PW - M, y - 1);
  y += 4;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  text('Closing balance', M, y);
  text(`${fmtPoints(doc.closingBalance)} pts`, PW - M, y, 'right');

  // ── "Page n of N" footer on every page ──
  const total = pdf.getNumberOfPages();
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7);
  pdf.setTextColor(140, 140, 140);
  for (let p = 1; p <= total; p++) {
    pdf.setPage(p);
    text(`Page ${p} of ${total}`, PW - M, PH - 8, 'right');
    text(`${doc.title} · ${doc.outletCode}`, M, PH - 8);
  }

  return pdf.output('blob');
}
