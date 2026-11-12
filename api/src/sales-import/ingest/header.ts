/**
 * Header-row resolution (plan §6.1 / task I-2). Pure.
 *
 * A mapped header must match EXACTLY ONE normalized header cell (exact, never "contains": "CODE" does
 * not match "CUSTOMER CODE"). `headerRow: 'auto'` picks the first of the first 10 rows that contains
 * every mapped header exactly once (rows above it, e.g. a DMS marker row of "X"s, are ignored); a number
 * is the 1-based SHEET row number (the row's `rowNo`). Anything else → needsMapping with the details.
 */
import type { SalesColumnMapping } from '../sales-import.contract';
import { normalizeHeader } from './normalize';

/** One physical row from a row source. `rowNo` = 1-based sheet row (xlsx) / line (CSV). */
export interface SourceRow {
  rowNo: number;
  cells: unknown[];
}

export interface ColumnIndex {
  outletCode: number;
  outletName: number | null;
  invoiceDate: number;
  amount: number | null;
  quantity: number | null;
  dims: Record<string, number>;
}

export interface ResolvedHeader {
  needsMapping: false;
  headerRowIdx: number; // index into the `rows` array given
  headerRowNo: number;  // the sheet row number of the header
  colIdx: ColumnIndex;
}

export interface UnresolvedHeader {
  needsMapping: true;
  reason: string;
  missing: string[];    // normalized mapped headers with no matching cell
  duplicates: string[]; // normalized mapped headers matching ≥ 2 cells
}

export type HeaderResolution = ResolvedHeader | UnresolvedHeader;

/** How many leading rows 'auto' scans (and how many rows NEEDS_MAPPING shows). */
export const HEADER_SCAN_ROWS = 10;

interface MappedField {
  field: string; // 'outletCode' | … | 'dim:<key>'
  header: string; // normalized
}

function mappedFields(mapping: SalesColumnMapping): MappedField[] {
  const out: MappedField[] = [];
  const add = (field: string, h: string | null | undefined) => {
    if (h !== null && h !== undefined && normalizeHeader(h) !== '') out.push({ field, header: normalizeHeader(h) });
  };
  add('outletCode', mapping.outletCode);
  add('outletName', mapping.outletName);
  add('invoiceDate', mapping.invoiceDate);
  add('amount', mapping.amount);
  add('quantity', mapping.quantity);
  for (const d of mapping.dimensions ?? []) add(`dim:${d.key}`, d.header);
  return out;
}

interface RowMatch {
  idx: Map<string, number>;
  missing: string[];
  duplicates: string[];
}

function matchRow(cells: unknown[], fields: MappedField[]): RowMatch {
  const positions = new Map<string, number[]>();
  cells.forEach((c, i) => {
    const h = normalizeHeader(c);
    if (h === '') return;
    const list = positions.get(h);
    if (list) list.push(i);
    else positions.set(h, [i]);
  });
  const idx = new Map<string, number>();
  const missing: string[] = [];
  const duplicates: string[] = [];
  for (const f of fields) {
    const p = positions.get(f.header) ?? [];
    if (p.length === 0) missing.push(f.header);
    else if (p.length > 1) duplicates.push(f.header);
    else idx.set(f.field, p[0]);
  }
  return { idx, missing: [...new Set(missing)], duplicates: [...new Set(duplicates)] };
}

function toColumnIndex(mapping: SalesColumnMapping, idx: Map<string, number>): ColumnIndex {
  const dims: Record<string, number> = {};
  for (const d of mapping.dimensions ?? []) dims[d.key] = idx.get(`dim:${d.key}`)!;
  return {
    outletCode: idx.get('outletCode')!,
    outletName: idx.get('outletName') ?? null,
    invoiceDate: idx.get('invoiceDate')!,
    amount: idx.get('amount') ?? null,
    quantity: idx.get('quantity') ?? null,
    dims,
  };
}

const describeProblem = (missing: string[], duplicates: string[]): string => {
  const parts: string[] = [];
  if (missing.length) parts.push(`not found: ${missing.join(', ')}`);
  if (duplicates.length) parts.push(`appears more than once: ${duplicates.join(', ')}`);
  return parts.join('; ');
};

export function resolveHeader(rows: SourceRow[], mapping: SalesColumnMapping): HeaderResolution {
  const fields = mappedFields(mapping);
  if (!fields.some((f) => f.field === 'outletCode') || !fields.some((f) => f.field === 'invoiceDate')) {
    return { needsMapping: true, reason: 'The column mapping needs an outlet-code and an invoice-date header.', missing: [], duplicates: [] };
  }
  if (!fields.some((f) => f.field === 'amount' || f.field === 'quantity')) {
    return { needsMapping: true, reason: 'The column mapping needs an amount or a quantity header.', missing: [], duplicates: [] };
  }
  // Two fields mapped to the same header text can never be resolved to distinct columns.
  const seen = new Map<string, string>();
  const clash: string[] = [];
  for (const f of fields) {
    if (seen.has(f.header)) clash.push(f.header);
    else seen.set(f.header, f.field);
  }
  if (clash.length) {
    return {
      needsMapping: true,
      reason: `The column mapping uses the same header for two fields: ${[...new Set(clash)].join(', ')}.`,
      missing: [],
      duplicates: [...new Set(clash)],
    };
  }

  if (typeof mapping.headerRow === 'number') {
    const i = rows.findIndex((r) => r.rowNo === mapping.headerRow);
    if (i < 0) {
      return { needsMapping: true, reason: `Header row ${mapping.headerRow} was not found in the file.`, missing: fields.map((f) => f.header), duplicates: [] };
    }
    const m = matchRow(rows[i].cells, fields);
    if (m.missing.length || m.duplicates.length) {
      return { needsMapping: true, reason: `Header row ${mapping.headerRow}: ${describeProblem(m.missing, m.duplicates)}.`, missing: m.missing, duplicates: m.duplicates };
    }
    return { needsMapping: false, headerRowIdx: i, headerRowNo: rows[i].rowNo, colIdx: toColumnIndex(mapping, m.idx) };
  }

  let best: RowMatch | null = null;
  const scan = rows.slice(0, HEADER_SCAN_ROWS);
  for (let i = 0; i < scan.length; i++) {
    const m = matchRow(scan[i].cells, fields);
    if (!m.missing.length && !m.duplicates.length) {
      return { needsMapping: false, headerRowIdx: i, headerRowNo: scan[i].rowNo, colIdx: toColumnIndex(mapping, m.idx) };
    }
    if (!best || m.idx.size > best.idx.size) best = m;
  }
  const missing = best ? best.missing : fields.map((f) => f.header);
  const duplicates = best ? best.duplicates : [];
  return {
    needsMapping: true,
    reason: `No header row in the first ${HEADER_SCAN_ROWS} rows has every mapped column exactly once (${describeProblem(missing, duplicates) || 'file is empty'}).`,
    missing,
    duplicates,
  };
}
