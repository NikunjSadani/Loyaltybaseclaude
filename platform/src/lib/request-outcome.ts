/**
 * Telling "the server said no" apart from "no clear answer arrived".
 *
 * A request can fail WITHOUT a definite server answer: the Next `/api/*` proxy or the Cloudflare Worker gave up waiting
 * (bare 500 / 504 / 524), a gateway failed (502 / 503), the network dropped, or a 2xx reply was cut off. The backend may
 * still have done the work — prod 2026-11-18: the sales-import apply was cut at 30 s by the proxy, the page said "Nothing
 * was applied", and the admin applied again, four times. So after such a failure a page must NOT say "nothing happened":
 * it looks the outcome up where it can, and otherwise says plainly that the outcome is unknown and what to check.
 *
 * A 4xx (other than 408) is a definite refusal: the backend answered and changed nothing.
 */

type Failed = { success?: boolean; error?: string; status?: number };

/** True when the failure carries no definite answer from the backend (the action may or may not have happened). */
export function outcomeUnknown(r: Failed): boolean {
  const s = r.status;
  if (s === undefined || s === 0) return true; // fetch threw / no response / a cut-off 2xx (api-client)
  if (s === 408) return true;
  return s >= 500;
}

/** The error as a reason inside a sentence (trimmed, no trailing full stop), or `fallback` when it is empty. */
export function reasonOr(error: string | null | undefined, fallback: string): string {
  const s = String(error ?? '').trim().replace(/\.+$/, '').trim();
  return s || fallback;
}

/**
 * Plain words for a failure with no definite answer — "didn't reply in time" ONLY for real timeouts (408 / 504 / 524);
 * an immediate 500 / 502 / 503 or an offline browser is said as what it is (audit M5).
 */
export function noAnswerReason(r: Failed): string {
  const s = r.status;
  if (s === 408 || s === 504 || s === 524) return 'the server didn’t reply in time';
  if (s === undefined || s === 0) {
    return /cut off/i.test(r.error ?? '') ? reasonOr(r.error, '') : 'the server could not be reached';
  }
  // A 503 that carries the server's own words (e.g. "The server is busy…" from the heavy-operation limiter) says them.
  if (s === 503 && !GENERIC_GATEWAY_TEXT.test((r.error ?? '').trim())) return `the server is busy: ${reasonOr(r.error, '')}`;
  return `the server didn’t give a clear answer (error ${s})`;
}

/** Status-line texts a proxy / gateway puts in an error body — not a reason worth showing. */
const GENERIC_GATEWAY_TEXT = /^(|service unavailable|internal server error|bad gateway|gateway time-?out|http \d{3})$/i;

/** The reason of ANY failure, never empty: the server's own words for a refusal, plain words for no clear answer. */
export function failureReason(r: Failed): string {
  return outcomeUnknown(r) ? noAnswerReason(r) : reasonOr(r.error, 'the server refused it without giving a reason');
}
