/**
 * Money utilities — integer paise everywhere.
 *
 * Contract:
 *  - The database stores all monetary values as BIGINT paise.
 *  - Prisma returns those columns as JS `bigint`.
 *  - The API accepts and returns paise as plain JSON numbers (integer).
 *  - Points are whole integers (a count, NOT money — no ×100 conversion).
 *
 * Paise amounts are always well below Number.MAX_SAFE_INTEGER (2^53 − 1),
 * so wrapping `bigint` reads with Number() is lossless for all foreseeable
 * values (₹90 trillion would still be safe).
 */

/**
 * Convert a rupee amount (from Excel / human input) to integer paise.
 * Uses Math.round (round-half-up) to avoid floating-point drift.
 *
 * @example rupeesToPaise(100.5) → 10050
 */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/**
 * Convert paise (integer, from DB / API) to a rupee decimal for display.
 * Accepts `bigint` (Prisma column read) or `number`.
 *
 * @example paiseToRupees(10050n) → 100.5
 */
export function paiseToRupees(paise: number | bigint): number {
  return Number(paise) / 100;
}

/**
 * Cast a paise number to BigInt for writing into a Prisma BigInt column.
 * Always Math.round the input first to guard against any residual float.
 *
 * @example toPaiseBigInt(10050) → 10050n
 */
export function toPaiseBigInt(paise: number): bigint {
  return BigInt(Math.round(paise));
}

/**
 * Format a paise amount as an Indian-rupee string with 2 decimal places.
 * Suitable for human-readable notifications and email bodies.
 *
 * @example formatINR(10050n) → '₹100.50'
 * @example formatINR(100000) → '₹1,000.00'
 */
export function formatINR(paise: number | bigint): string {
  return `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}
