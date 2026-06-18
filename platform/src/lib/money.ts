/**
 * Money utilities for the platform (frontend).
 *
 * Contract:
 *  - The API sends and receives all monetary values as integer paise.
 *  - Points are whole integers (a count, NOT money — no ×100 conversion).
 *  - Conversion rupees↔paise happens only at two human edges:
 *      1. Excel upload-in: user enters rupees → we convert to paise before POST.
 *      2. Display-out:     API returns paise → we convert to rupees for the UI.
 */

/**
 * Convert a rupee amount (from Excel / human input) to integer paise.
 * Uses Math.round to avoid floating-point drift.
 *
 * @example rupeesToPaise(100.5) → 10050
 */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/**
 * Convert paise (integer, from API response) to a rupee decimal for display.
 *
 * @example paiseToRupees(10050) → 100.5
 */
export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/**
 * Format a paise amount as an Indian-rupee string with 2 decimal places.
 * Suitable for human-readable display in the UI.
 *
 * @example formatINR(10050) → '₹100.50'
 * @example formatINR(100000) → '₹1,000.00'
 */
export function formatINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}
