/**
 * money-format.ts — the ONE ₹ formatter for integer-paise money on the credits / payout / TDS screens.
 *
 *   formatInrPaise(123450)     → '₹1,234.50'
 *   formatInrPaise('80000')    → '₹800.00'
 *   formatInrPaise(-150)       → '-₹1.50'      (sign before the ₹)
 *   formatInrPaise(BigInt(5))  → '₹0.05'
 *
 * Always en-IN grouping and ALWAYS 2 decimals. Integer arithmetic only (BigInt) so huge paise values
 * (bigint-as-string from the API) never lose precision. Unparseable input → '₹0.00'.
 */

const ZERO = BigInt(0);
const HUNDRED = BigInt(100);

function toPaiseBigInt(paise: number | string | bigint | null | undefined): bigint | null {
  if (typeof paise === 'bigint') return paise;
  if (typeof paise === 'number') {
    if (!Number.isFinite(paise)) return null;
    return BigInt(Math.round(paise));
  }
  if (typeof paise === 'string') {
    const s = paise.trim();
    if (/^-?\d+$/.test(s)) return BigInt(s);
    const n = Number(s);
    return s !== '' && Number.isFinite(n) ? BigInt(Math.round(n)) : null;
  }
  return null;
}

export function formatInrPaise(paise: number | string | bigint | null | undefined): string {
  const v = toPaiseBigInt(paise);
  if (v === null) return '₹0.00';
  const neg = v < ZERO;
  const abs = neg ? -v : v;
  const rupees = abs / HUNDRED;
  const fraction = abs % HUNDRED;
  return `${neg ? '-' : ''}₹${rupees.toLocaleString('en-IN')}.${fraction.toString().padStart(2, '0')}`;
}
