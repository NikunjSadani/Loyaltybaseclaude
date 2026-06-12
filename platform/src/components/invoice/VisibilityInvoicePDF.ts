/**
 * generateVisibilityInvoicePDF
 *
 * Generates a self-billing visibility invoice as a PDF and triggers browser
 * download. Uses jsPDF (already installed as jspdf ^4.2.1).
 *
 * Layout:
 *   ┌───────────────────────────────────────────────┐
 *   │  INVOICE          TGSL-VIS-O2-202501-001      │
 *   │  Tech Gifsy Solutions Limited  (right corner)  │
 *   ├────────────────────┬──────────────────────────┤
 *   │  Billed By         │  Billed To               │
 *   ├────────────────────┴──────────────────────────┤
 *   │  Description table (service + SAC + amount)    │
 *   ├───────────────────────────────────────────────┤
 *   │  Totals (amount, ± GST rows, invoice total)    │
 *   ├───────────────────────────────────────────────┤
 *   │  Bank details                                  │
 *   ├───────────────────────────────────────────────┤
 *   │  Disclaimer (self-billing, no signature)       │
 *   └───────────────────────────────────────────────┘
 *
 * NO mention of 194C, TDS, or net disbursement anywhere.
 */

import type { VisibilityInvoice } from '@/lib/invoice';

const GREEN = [22, 163, 74] as const;   // #16a34a
const DARK  = [26, 26, 46] as const;   // #1A1A2E
const GRAY  = [107, 114, 128] as const;
const LGRAY = [243, 244, 246] as const;

type RGB = readonly [number, number, number];

function setFill(doc: InstanceType<typeof import('jspdf')['jsPDF']>, rgb: RGB) {
  doc.setFillColor(rgb[0], rgb[1], rgb[2]);
}
function setDraw(doc: InstanceType<typeof import('jspdf')['jsPDF']>, rgb: RGB) {
  doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
}
function setTextColor(doc: InstanceType<typeof import('jspdf')['jsPDF']>, rgb: RGB) {
  doc.setTextColor(rgb[0], rgb[1], rgb[2]);
}

export async function generateVisibilityInvoicePDF(inv: VisibilityInvoice): Promise<void> {
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const PW = 210;  // page width
  const M  = 15;   // margin

  let y = M;

  // ── Header bar ────────────────────────────────────────────────────────────
  setFill(doc, DARK);
  doc.rect(0, 0, PW, 24, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  setTextColor(doc, [255, 255, 255]);
  doc.text('INVOICE', M, 15);

  // Company name (right)
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text('Tech Gifsy Solutions Limited', PW - M, 10, { align: 'right' });
  doc.text('West Bengal, India', PW - M, 15, { align: 'right' });

  y = 30;

  // ── Invoice meta row ──────────────────────────────────────────────────────
  // Invoice number (left)
  setTextColor(doc, GRAY);
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE NUMBER', M, y);
  doc.setFont('helvetica', 'normal');
  setTextColor(doc, DARK);
  doc.setFontSize(9);
  doc.text(inv.invoiceNumber, M, y + 5);

  // Period (center)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  setTextColor(doc, GRAY);
  doc.text('PERIOD', PW / 2, y, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  setTextColor(doc, DARK);
  doc.setFontSize(9);
  doc.text(inv.periodLabel, PW / 2, y + 5, { align: 'center' });

  // Date (right)
  const genDate = new Date(inv.generatedAt).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  setTextColor(doc, GRAY);
  doc.text('DATE', PW - M, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  setTextColor(doc, DARK);
  doc.setFontSize(9);
  doc.text(genDate, PW - M, y + 5, { align: 'right' });

  y += 14;

  // Divider
  setDraw(doc, LGRAY);
  doc.setLineWidth(0.4);
  doc.line(M, y, PW - M, y);
  y += 8;

  // ── Billed By / Billed To ─────────────────────────────────────────────────
  const colW = (PW - M * 2) / 2 - 4;

  // Billed By — left
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  setTextColor(doc, GRAY);
  doc.text('BILLED BY (SERVICE PROVIDER)', M, y);
  y += 5;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  setTextColor(doc, DARK);
  doc.text(inv.firmName, M, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setTextColor(doc, [55, 65, 81]);
  doc.text(inv.partnerName, M, y);
  y += 4.5;
  doc.text(inv.retailerState + ', India', M, y);
  y += 4.5;
  if (inv.panNumber) {
    setTextColor(doc, GRAY);
    doc.setFontSize(8);
    doc.text(`PAN: ${inv.panNumber}`, M, y);
    y += 4.5;
  }
  if (inv.gstNumber) {
    doc.text(`GSTIN: ${inv.gstNumber}`, M, y);
    y += 4.5;
  }

  // Billed To — right column (reset y to same start)
  const rightX = M + colW + 8;
  let rightY = y - (
    4.5 * (inv.panNumber ? 1 : 0) +
    4.5 * (inv.gstNumber ? 1 : 0) +
    4.5 * 2 + 5 + 5 + 4.5
  );

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  setTextColor(doc, GRAY);
  doc.text('BILLED TO', rightX, rightY);
  rightY += 5;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  setTextColor(doc, DARK);
  doc.text('Tech Gifsy Solutions Limited', rightX, rightY);
  rightY += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setTextColor(doc, [55, 65, 81]);
  doc.text('Kolkata, West Bengal, India', rightX, rightY);
  rightY += 4.5;

  y += 6;

  // Divider
  setDraw(doc, LGRAY);
  doc.line(M, y, PW - M, y);
  y += 8;

  // ── Service line table ────────────────────────────────────────────────────
  // Header row
  setFill(doc, LGRAY);
  doc.rect(M, y, PW - M * 2, 8, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  setTextColor(doc, GRAY);
  doc.text('DESCRIPTION', M + 2, y + 5.5);
  doc.text('SAC', PW - M - 52, y + 5.5);
  doc.text('AMOUNT', PW - M - 2, y + 5.5, { align: 'right' });
  y += 8;

  // Service row
  setTextColor(doc, DARK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(inv.description, M + 2, y + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(inv.sacCode, PW - M - 52, y + 6);
  doc.setFont('helvetica', 'bold');
  doc.text(`Rs. ${inv.baseAmount.toLocaleString('en-IN')}`, PW - M - 2, y + 6, { align: 'right' });
  y += 12;

  // ── Totals block ──────────────────────────────────────────────────────────
  setDraw(doc, LGRAY);
  doc.line(M, y, PW - M, y);
  y += 6;

  const totalsLX = PW - M - 80;
  const totalsRX = PW - M;

  function totalRow(label: string, value: string, bold = false, color: RGB = DARK) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(bold ? 9.5 : 9);
    setTextColor(doc, color);
    doc.text(label, totalsLX, y);
    doc.text(value, totalsRX, y, { align: 'right' });
    y += 6;
  }

  totalRow('Base Amount', `Rs. ${inv.baseAmount.toLocaleString('en-IN')}`, true);

  if (inv.gstApplicable) {
    if (inv.gstType === 'CGST_SGST') {
      totalRow('CGST @ 9%', `Rs. ${inv.cgst.toLocaleString('en-IN')}`, false, GRAY);
      totalRow('SGST @ 9%', `Rs. ${inv.sgst.toLocaleString('en-IN')}`, false, GRAY);
    } else {
      totalRow('IGST @ 18%', `Rs. ${inv.igst.toLocaleString('en-IN')}`, false, GRAY);
    }

    y += 2;
    setDraw(doc, GRAY);
    doc.setLineWidth(0.3);
    doc.line(totalsLX, y, totalsRX, y);
    y += 5;
    totalRow('Invoice Total', `Rs. ${inv.totalInvoiceAmount.toLocaleString('en-IN')}`, true, GREEN);
  }

  y += 4;

  // ── Bank details ──────────────────────────────────────────────────────────
  setDraw(doc, LGRAY);
  doc.setLineWidth(0.4);
  doc.line(M, y, PW - M, y);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  setTextColor(doc, GRAY);
  doc.text('BANK DETAILS', M, y);
  y += 5;

  const bankDetails = [
    ['Bank Name', inv.bankName],
    ['Account Number', inv.accountNumber],
    ['IFSC Code', inv.ifscCode],
  ];

  for (const [label, value] of bankDetails) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    setTextColor(doc, GRAY);
    doc.text(`${label}:`, M, y);
    setTextColor(doc, DARK);
    doc.setFont('helvetica', 'bold');
    doc.text(value, M + 32, y);
    y += 5;
  }

  y += 4;

  // ── Disclaimer ────────────────────────────────────────────────────────────
  setFill(doc, LGRAY);
  const disclaimerText =
    'This is an automated invoice generated by Tech Gifsy Solutions Limited on behalf of the ' +
    'service provider named above, under a mutually agreed self-billing arrangement. ' +
    'No signature is required on this invoice.';

  // Measure text height
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.5);
  const disclaimerLines = doc.splitTextToSize(disclaimerText, PW - M * 2 - 8);
  const disclaimerH = disclaimerLines.length * 4 + 8;

  doc.rect(M, y, PW - M * 2, disclaimerH, 'F');
  setTextColor(doc, GRAY);
  doc.text(disclaimerLines, M + 4, y + 5);

  // ── Save ──────────────────────────────────────────────────────────────────
  doc.save(`${inv.invoiceNumber}.pdf`);
}
