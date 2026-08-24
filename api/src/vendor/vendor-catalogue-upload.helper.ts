/**
 * Vendor catalogue BULK UPLOAD (Gift Catalogue & Dispatch, Wave 2) — PURE Excel
 * build/parse helpers, DI-free (mirrors rewards-fulfilment.helpers.ts). The service
 * composes these with the SAME per-item create path (price bounds + moderation), so
 * no business logic lives here — only shape + light cell coercion.
 *
 * Layout (single header row, then one row per gift):
 *   Name | Category Code | Selling Value (paise) | MRP (paise) |
 *   Description | Image URLs | Redemption Mode | Fulfilment Channel | Stock Quantity
 *
 * `Image URLs` is a comma/space/newline-separated list. `Stock Quantity` blank =
 * untracked (unlimited).
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '../common/xlsx';

export const VENDOR_UPLOAD_COLS = [
  'Name',
  'Category Code',
  'Selling Value (paise)',
  'MRP (paise)',
  'Description',
  'Image URLs',
  'Redemption Mode',
  'Fulfilment Channel',
  'Stock Quantity',
] as const;

/** Build a blank downloadable template (header + one example-less blank row). */
export function buildVendorUploadTemplateBuffer(): Buffer {
  const header: string[] = [...VENDOR_UPLOAD_COLS];
  const example = [
    'Wireless Earbuds',
    'ELEC',
    '150000',
    '199900',
    'Bluetooth 5.3 earbuds',
    'https://cdn.example.com/earbuds.png',
    'PHYSICAL_GIFT',
    'BRAND',
    '50',
  ];
  const ws = aoaToSheetSafe([header, example]);
  ws['!cols'] = header.map(() => ({ wch: 20 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vendor Catalogue');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export interface ParsedVendorRow {
  /** 1-based sheet row number for user-facing errors (1 = header). */
  rowIndex: number;
  name?: string;
  categoryCode?: string;
  sellingValuePaise?: number;
  mrpPaise?: number;
  description?: string;
  imageUrls: string[];
  redemptionMode?: string;
  fulfilmentChannel?: string;
  stockQuantity?: number;
}

export interface ParseVendorUploadResult {
  rows: ParsedVendorRow[];
}

/**
 * Parse an uploaded vendor catalogue .xlsx. Throws on a non-template shape (missing
 * `Name` header, or no data rows). Blank trailing rows are skipped. Numeric cells are
 * coerced to integers; a non-numeric numeric cell yields `undefined` (the service
 * rejects it per-row so one bad row never aborts the batch).
 */
export function parseVendorUploadBuffer(buffer: Buffer | ArrayBuffer): ParseVendorUploadResult {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  if (wb.SheetNames.length === 0) {
    throw new Error('Unrecognized file: no worksheet found');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawAoa = XLSX.utils.sheet_to_json<(string | number | null | undefined)[]>(ws, {
    header: 1,
    defval: null,
  });
  if (rawAoa.length < 2) {
    throw new Error('Unrecognized file: expected the vendor catalogue template (missing header / data rows)');
  }

  const headerRow = (rawAoa[0] as (string | number | null)[]).map((c) => String(c ?? '').trim());
  const idxOf = (label: string) => headerRow.indexOf(label);

  const nameCol = idxOf('Name');
  if (nameCol === -1) {
    throw new Error('Unrecognized template: missing the required "Name" column');
  }
  const categoryCol = idxOf('Category Code');
  const sellingCol = idxOf('Selling Value (paise)');
  const mrpCol = idxOf('MRP (paise)');
  const descCol = idxOf('Description');
  const imagesCol = idxOf('Image URLs');
  const modeCol = idxOf('Redemption Mode');
  const channelCol = idxOf('Fulfilment Channel');
  const stockCol = idxOf('Stock Quantity');

  const rows: ParsedVendorRow[] = [];
  for (let ri = 1; ri < rawAoa.length; ri++) {
    const row = rawAoa[ri] as (string | number | null | undefined)[];
    if (!row || row.every((c) => c === null || c === undefined || String(c).trim() === '')) {
      continue;
    }
    const str = (ci: number): string | undefined => {
      if (ci < 0 || ci >= row.length) return undefined;
      const v = String(row[ci] ?? '').trim();
      return v === '' ? undefined : v;
    };
    const int = (ci: number): number | undefined => {
      const s = str(ci);
      if (s === undefined) return undefined;
      const n = Number(s.replace(/,/g, ''));
      return Number.isFinite(n) ? Math.round(n) : undefined;
    };

    const name = str(nameCol);
    if (!name) continue; // key column blank → skip

    const imagesRaw = str(imagesCol);
    const imageUrls = imagesRaw
      ? imagesRaw.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean)
      : [];

    rows.push({
      rowIndex: ri + 1,
      name,
      categoryCode: str(categoryCol),
      sellingValuePaise: int(sellingCol),
      mrpPaise: int(mrpCol),
      description: str(descCol),
      imageUrls,
      redemptionMode: str(modeCol),
      fulfilmentChannel: str(channelCol),
      stockQuantity: int(stockCol),
    });
  }

  return { rows };
}
