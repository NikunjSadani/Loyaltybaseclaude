/* Display label for a TDS liability row's deductee (admin TDS page). */

/** Identity of a per-deductee no-PAN row (backend `noPanDeductee`; absent on PAN rows). */
export interface NoPanDeductee {
  partnerId:   string | null;
  clientId:    string | null;
  name:        string;
  outletCodes: string[];
}

/**
 * The "Deductee PAN" cell. A no-PAN partner is its own deductee (key `__NO_PAN__:<id>`), shown as
 * "NO PAN ON FILE · <name> (<outlet codes>)"; the bare `__NO_PAN__` key holds only identity-less
 * (unattributed) amounts, e.g. a no-PAN deposit uploaded without an Outlet Code.
 */
export function deducteeCellLabel(row: { panNumber: string; noPanDeductee?: NoPanDeductee }): string {
  if (row.noPanDeductee) {
    const d = row.noPanDeductee;
    const codes = d.outletCodes.length ? ` (${d.outletCodes.join(', ')})` : '';
    return `NO PAN ON FILE · ${d.name || 'Unknown'}${codes}`;
  }
  if (row.panNumber === '__NO_PAN__') return 'NO PAN ON FILE (unattributed)';
  return row.panNumber || '—';
}
