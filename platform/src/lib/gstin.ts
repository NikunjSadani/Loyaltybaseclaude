/**
 * GSTIN (Goods and Services Tax Identification Number) helpers.
 *
 * Pure functions — no DOM, no browser APIs.
 *
 * A GSTIN is exactly 15 characters:
 *   [0-1]   2-digit state code            ([0-9]{2})
 *   [2-6]   PAN first 5 (entity letters)  ([A-Z]{5})
 *   [7-10]  PAN middle 4 digits           ([0-9]{4})
 *   [11]    PAN last letter               ([A-Z]{1})
 *   [12]    entity / registration number  ([1-9A-Z]{1})
 *   [13]    fixed 'Z'                      (Z)
 *   [14]    checksum char                 ([0-9A-Z]{1})
 *
 * The embedded PAN is characters [2..11] (the 10 chars after the state code).
 */

/** Canonical GSTIN format regex (does NOT verify the checksum digit). */
export const GSTIN_REGEX =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** Full length of a valid GSTIN. */
export const GSTIN_LENGTH = 15;

/** Index range (inclusive of start, exclusive of end) of the embedded PAN. */
export const GSTIN_PAN_START = 2;
export const GSTIN_PAN_END = 12;

/**
 * Returns true when `s` is a structurally-valid 15-char GSTIN.
 * A blank / undefined value is NOT valid (callers treat blank as "optional, no error").
 */
export function isValidGstin(s: string | null | undefined): boolean {
  if (!s) return false;
  return GSTIN_REGEX.test(s);
}

/**
 * Extracts the embedded 10-character PAN from a GSTIN (characters [2..11]).
 *
 * Works as soon as the string is long enough (length >= 12) so the PAN can be
 * auto-filled while the user is still typing the GSTIN. Returns '' if there
 * aren't yet enough characters to contain a full PAN.
 */
export function panFromGstin(s: string | null | undefined): string {
  if (!s || s.length < GSTIN_PAN_END) return '';
  return s.slice(GSTIN_PAN_START, GSTIN_PAN_END);
}
