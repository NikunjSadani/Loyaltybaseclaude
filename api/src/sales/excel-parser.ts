import * as XLSX from 'xlsx';
import { PointsAwardRow } from './sales.service';

// ── Month normaliser ──────────────────────────────────────────────────────────
// Converts various admin-friendly month formats to canonical "YYYY-MM".
//
//   "2026-07"  → "2026-07"   (already canonical)
//   "Jul-26"   → "2026-07"   (MMM-YY)
//   "Jul-2026" → "2026-07"   (MMM-YYYY)
//   "07/2026"  → "2026-07"   (MM/YYYY)
//   "2026/07"  → "2026-07"   (YYYY/MM)
//   43978      → uses XLSX date serial conversion

const MONTH_NAMES: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function normaliseMonth(raw: any): string {
  if (typeof raw === 'number') {
    // Excel date serial → JS date
    const d = XLSX.SSF.parse_date_code(raw);
    const mm = String(d.m).padStart(2, '0');
    const yyyy = String(d.y);
    return `${yyyy}-${mm}`;
  }

  const s = String(raw).trim();

  // Already canonical: 2026-07
  if (/^\d{4}-\d{2}$/.test(s)) return s;

  // YYYY/MM
  const slashYM = s.match(/^(\d{4})\/(\d{2})$/);
  if (slashYM) return `${slashYM[1]}-${slashYM[2]}`;

  // MM/YYYY
  const slashMY = s.match(/^(\d{2})\/(\d{4})$/);
  if (slashMY) return `${slashMY[2]}-${slashMY[1]}`;

  // Jul-26 or Jul-2026
  const mmmYY = s.match(/^([A-Za-z]{3})[- ](\d{2,4})$/);
  if (mmmYY) {
    const mon = MONTH_NAMES[mmmYY[1].toLowerCase()];
    if (!mon) throw new Error(`Unknown month abbreviation: "${mmmYY[1]}"`);
    const yr = mmmYY[2].length === 2 ? `20${mmmYY[2]}` : mmmYY[2];
    return `${yr}-${mon}`;
  }

  throw new Error(`Cannot parse month value: "${s}"`);
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parses an admin-uploaded points-award Excel file.
 *
 * Expected sheet layout (first sheet):
 *   | Outlet ID | Month | <param1> | <param2> | … | Total |
 *
 * - Parameter columns = all columns between "Month" and "Total" (case-insensitive)
 * - Each non-zero parameter cell → one PointsAwardRow
 * - Rows with blank Outlet ID are skipped (summary rows, totals, etc.)
 */
export function parsePointsAwardExcel(buffer: Buffer): PointsAwardRow[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  // sheet_to_json with header:1 → array of arrays; first row = headers
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (raw.length === 0) return [];

  // ── Find header row ────────────────────────────────────────────────────────
  const headers: string[] = (raw[0] as any[]).map((h) =>
    String(h ?? '').trim(),
  );

  const idxOutlet = headers.findIndex((h) => h.toLowerCase() === 'outlet id' || h.toLowerCase() === 'outletcode' || h.toLowerCase() === 'outlet_id');
  const idxMonth  = headers.findIndex((h) => h.toLowerCase() === 'month');
  const idxTotal  = headers.findIndex((h) => h.toLowerCase() === 'total');

  if (idxOutlet === -1) throw new Error('Excel is missing required "Outlet ID" column');
  if (idxMonth  === -1) throw new Error('Excel is missing required "Month" column');

  // Parameter columns: everything after "Month" up to (not including) "Total"
  // If there's no "Total" column, treat everything after "Month" as params
  const paramEnd = idxTotal !== -1 ? idxTotal : headers.length;
  const paramCols: Array<{ idx: number; name: string }> = [];
  for (let i = idxMonth + 1; i < paramEnd; i++) {
    const name = headers[i].trim();
    if (name) paramCols.push({ idx: i, name });
  }

  // ── Parse data rows ────────────────────────────────────────────────────────
  const result: PointsAwardRow[] = [];

  for (let r = 1; r < raw.length; r++) {
    const row = raw[r] as any[];
    const outletRaw = row[idxOutlet];
    const outletCode = String(outletRaw ?? '').trim();

    // Skip blank/summary rows
    if (!outletCode) continue;

    const monthRaw = row[idxMonth];
    const month = normaliseMonth(monthRaw);

    for (const col of paramCols) {
      const val = row[col.idx];
      const points = typeof val === 'number' ? val : parseFloat(String(val ?? ''));

      // Skip zero, negative, or non-numeric cells
      if (!Number.isFinite(points) || points <= 0) continue;

      result.push({
        outletCode,
        month,
        parameterName: col.name,
        points: Math.round(points), // whole points only
      });
    }
  }

  return result;
}
