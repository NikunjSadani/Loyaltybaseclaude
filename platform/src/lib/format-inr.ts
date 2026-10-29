/**
 * format-inr.ts — compact Indian-rupee formatting for dashboard displays.
 *
 * The sales dashboard shows ₹ amounts that can range from a few hundred rupees up to crores.
 * Rendering full-digit values (e.g. `₹1,23,45,678`) overflows the tight mobile card layout, so
 * these helpers collapse large amounts to the Indian short scale (K / L / Cr) while keeping small
 * amounts exact.
 *
 *   formatInrCompact(582)        → '₹582'
 *   formatInrCompact(5200)       → '₹5.2K'
 *   formatInrCompact(580000)     → '₹5.8L'
 *   formatInrCompact(12300000)   → '₹1.23Cr'
 *   formatInrExact(12345678)     → '₹1,23,45,678'   (full en-IN grouping, for exact display)
 *
 * PURE formatting — no rounding of the underlying data, only of the displayed string.
 */

/** Trim a fixed-decimal string of a trailing `.0` (1-dp bands: K / L). `'5.0'→'5'`, `'5.2'→'5.2'`. */
function trimOneDp(s: string): string {
  return s.replace(/\.0$/, '');
}

/** Trim trailing zeros (and a bare trailing dot) from a 2-dp string (Cr band). `'1.20'→'1.2'`, `'1.00'→'1'`. */
function trimTwoDp(s: string): string {
  return s.replace(/\.?0+$/, '');
}

/**
 * Format a RUPEE amount (not paise) as a compact Indian-scale string with a ₹ prefix.
 *
 *   • `< 1,000`                → exact integer, no decimals  → `₹582`  (`₹0` for 0)
 *   • `1,000 – 99,999`         → thousands, 1 dp, trim `.0`  → `₹5.2K` / `₹58.2K` / `₹5K`
 *   • `1,00,000 – 99,99,999`   → lakhs, 1 dp, trim `.0`      → `₹5.8L` / `₹58.2L` / `₹1L`
 *   • `≥ 1,00,00,000`          → crores, 2 dp, trim zeros    → `₹1.23Cr` / `₹1.2Cr` / `₹1Cr`
 *
 * Negatives are prefixed with `-` (e.g. `-₹5.2K`). Non-finite / NaN → `₹0`.
 */
/** The compact magnitude body for a NON-negative amount — `582`, `5.2K`, `5.8L`, `1.23Cr`. */
function compactBody(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_00_000) return `${trimOneDp((n / 1_000).toFixed(1))}K`;
  if (n < 1_00_00_000) return `${trimOneDp((n / 1_00_000).toFixed(1))}L`;
  return `${trimTwoDp((n / 1_00_00_000).toFixed(2))}Cr`;
}

export function formatInrCompact(rupees: number): string {
  if (!Number.isFinite(rupees)) return '₹0';
  const sign = rupees < 0 ? '-' : '';
  return `${sign}₹${compactBody(Math.abs(rupees))}`;
}

/**
 * Same compact Indian scale as `formatInrCompact` but WITHOUT the ₹ prefix — for tight paired
 * displays like the Target Achievement card's `achieved/target` (where repeating ₹ on both sides
 * reads as congested). `582`, `5.2K`, `5.8L`, `1.23Cr`; negatives `-`-prefixed; non-finite → `0`.
 */
export function formatCompact(rupees: number): string {
  if (!Number.isFinite(rupees)) return '0';
  const sign = rupees < 0 ? '-' : '';
  return `${sign}${compactBody(Math.abs(rupees))}`;
}

/** Full-precision rupee display with Indian digit grouping — `₹1,23,45,678`. Non-finite / NaN → `₹0`. */
export function formatInrExact(rupees: number): string {
  if (!Number.isFinite(rupees)) return '₹0';
  return `₹${rupees.toLocaleString('en-IN')}`;
}

/**
 * True when a KPI's `unit` denotes Indian rupees — the signal that a KPI line should use the
 * compact ₹ formatting rather than its raw unit suffix. Volume/count units (`Litre`, `Unit`,
 * `outlets`, …) and an empty/unknown unit return false, so their displays are left untouched.
 */
export function isInrUnit(unit?: string | null): boolean {
  if (!unit) return false;
  const u = unit.trim().toLowerCase();
  return u === 'inr' || u === '₹' || u === 'rs' || u === 'rs.' || u === 'rupee' || u === 'rupees';
}
