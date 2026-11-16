import ExcelJS from 'exceljs';
import { buildXlsx, cellSafe } from '../common/xlsx';
import { DISPERSAL_MAX_ROWS, DISPERSAL_NAME_MAX, DispersalBrandLimits, describeBrandAmounts } from './voucher-dispersal.parse';

/**
 * The upload template: sheet "Recipients" (Phone | Name | Amount (₹) | Brand | Note) with a Brand
 * dropdown (list validation over a hidden "Brands" sheet) and the Phone column formatted as TEXT (so
 * Excel never turns a mobile into 9.87E+09), plus an "Instructions" sheet listing each brand's live
 * amount rules. Built with exceljs (SheetJS CE cannot write data validation).
 */
export async function buildDispersalTemplate(brands: DispersalBrandLimits[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Recipients');
  ws.columns = [
    { header: 'Phone', key: 'phone', width: 16, style: { numFmt: '@' } },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Amount (₹)', key: 'amount', width: 14 },
    { header: 'Brand', key: 'brand', width: 18 },
    { header: 'Note', key: 'note', width: 36 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const list = wb.addWorksheet('Brands', { state: 'hidden' });
  brands.forEach((b, i) => {
    list.getCell(i + 1, 1).value = cellSafe(b.label);
  });
  const lastRow = DISPERSAL_MAX_ROWS + 1;
  if (brands.length > 0) {
    for (let r = 2; r <= lastRow; r++) {
      ws.getCell(r, 4).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`Brands!$A$1:$A$${brands.length}`],
        showErrorMessage: true,
        errorTitle: 'Unknown brand',
        error: 'Pick a brand from the list.',
      };
    }
  }

  const ins = wb.addWorksheet('Instructions');
  ins.columns = [{ width: 110 }];
  const lines = [
    'Voucher Dispersal — how to fill this file',
    '',
    `1. One row per recipient on the "Recipients" sheet (up to ${DISPERSAL_MAX_ROWS} rows). Do not rename the columns.`,
    '2. Phone: the 10-digit Indian mobile number that will receive the WhatsApp (+91 / leading 0 are fine).',
    `3. Name: the recipient's name as it should appear in the WhatsApp message (max ${DISPERSAL_NAME_MAX} characters).`,
    '4. Amount (₹): whole rupees only (no paise). It must be an amount the chosen brand can issue (see below).',
    '5. Brand: pick from the dropdown.',
    '6. Note: optional, for your own reference (not sent to the recipient).',
    '7. Each phone may appear only ONCE per campaign — a repeated phone is marked DUPLICATE and gets no voucher.',
    '8. After upload you will see a preview with every invalid / duplicate row and the total against the budget. Nothing is bought until you confirm.',
    '',
    'Brands and the amounts they can issue (live from Hubble when this template was downloaded):',
    ...brands.map((b) =>
      b.available && b.product
        ? `  • ${b.label}: ${describeBrandAmounts(b.product)}`
        : `  • ${b.label}: limits unavailable right now (${b.unavailableReason ?? 'unknown'}) — rows for it will be rejected until Hubble answers`,
    ),
  ];
  lines.forEach((l, i) => {
    ins.getCell(i + 1, 1).value = cellSafe(l);
  });
  ins.getRow(1).font = { bold: true, size: 13 };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** One delivery-report row (no voucher code — never). */
export interface DispersalReportRow {
  rowNumber: number;
  phone: string;
  name: string;
  amountRupees: number | null;
  brand: string | null;
  voucherStatus: string;
  hubbleReference: string | null;
  boughtAt: Date | null;
  failureReason: string | null;
  whatsappStatus: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  messageFailureReason: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : '');

export function buildDispersalReport(rows: DispersalReportRow[]): Buffer {
  return buildXlsx([
    {
      name: 'Delivery report',
      rows: rows.map((r) => ({
        Row: r.rowNumber,
        Phone: r.phone,
        Name: r.name,
        Amount: r.amountRupees ?? '',
        Brand: r.brand ?? '',
        'Voucher status': r.voucherStatus,
        'Hubble order ref': r.hubbleReference ?? '',
        'Bought at': iso(r.boughtAt),
        'Failure reason': r.failureReason ?? '',
        'WhatsApp status': r.whatsappStatus,
        'Sent at': iso(r.sentAt),
        'Delivered at': iso(r.deliveredAt),
        'Read at': iso(r.readAt),
        'Message failure reason': r.messageFailureReason ?? '',
      })),
    },
  ]);
}
