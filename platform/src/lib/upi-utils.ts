/**
 * UPI (Unified Payments Interface) utility functions.
 *
 * Pure functions — no DOM, no browser APIs.
 */

/**
 * Validates a UPI Virtual Payment Address (VPA).
 *
 * Format: `localpart@provider`
 *   - localpart : 2 or more alphanumeric / dot / hyphen / underscore characters
 *   - provider  : starts with a letter, followed by at least 1 more alphanumeric character
 *
 * Examples of valid VPAs: `9876543210@paytm`, `user@okicici`, `name.surname@ybl`
 */
export function isValidUpiId(upiId: string): boolean {
  if (!upiId) return false;
  return /^[a-zA-Z0-9._-]{2,}@[a-zA-Z][a-zA-Z0-9]{1,}$/.test(upiId);
}

/**
 * Attempts to extract a UPI VPA from QR code content.
 *
 * Handles two formats:
 *   1. UPI deep link  `upi://pay?pa=<vpa>&...`  → extracts the `pa` query parameter
 *   2. Raw VPA string `user@provider`            → returned as-is after trimming
 *
 * Returns `null` when no valid UPI ID can be found.
 */
export function parseUpiFromQr(content: string): string | null {
  if (!content) return null;

  // ── UPI deep link ─────────────────────────────────────────────────────────
  if (content.startsWith('upi://')) {
    const qsStart = content.indexOf('?');
    if (qsStart === -1) return null;
    try {
      const params = new URLSearchParams(content.slice(qsStart + 1));
      const pa = params.get('pa');
      return pa && isValidUpiId(pa) ? pa : null;
    } catch {
      return null;
    }
  }

  // ── Raw VPA ───────────────────────────────────────────────────────────────
  const trimmed = content.trim();
  return isValidUpiId(trimmed) ? trimmed : null;
}
