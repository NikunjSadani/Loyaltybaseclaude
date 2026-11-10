/**
 * Column-mapping fingerprint (H2). The worker stamps `SalesImport.mappingFingerprint` with the fingerprint of the
 * mapping it parsed the file with; preview/apply compare it with the CURRENT profile's and block every month when they
 * differ ("reprocess the file"), because the aggregates were built under the old reading of the file (a different
 * amount column, dimension, date order, decimal separator…).
 *
 * Only what changes the PARSED NUMBERS is hashed (dimension LABELS are display text and are ignored); headers are
 * compared after normalizeHeader, exactly as the parser matches them.
 */
import { createHash } from 'node:crypto';
import type { SalesColumnMapping } from '../sales-import.contract';
import { normalizeHeader } from './normalize';

function h(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const n = normalizeHeader(v);
  return n === '' ? null : n;
}

export function mappingFingerprint(m: SalesColumnMapping | null | undefined): string | null {
  if (!m || typeof m !== 'object') return null;
  const canon = [
    h(m.sheetName ?? null),
    m.headerRow ?? 'auto',
    h(m.outletCode),
    h(m.outletName ?? null),
    h(m.invoiceDate),
    h(m.amount ?? null),
    h(m.quantity ?? null),
    [...(m.dimensions ?? [])]
      .map((d) => [d.key, h(d.header)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    m.dateOrder ?? 'DMY',
    m.decimalSeparator ?? 'auto',
  ];
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}
