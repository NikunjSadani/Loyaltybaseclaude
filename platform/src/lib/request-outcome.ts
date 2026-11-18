/**
 * Telling "the server said no" apart from "no answer arrived".
 *
 * A request can fail WITHOUT a definite server answer: the Next `/api/*` proxy or the Cloudflare Worker gave up waiting
 * (bare 500 / 502 / 504 / 524), the network dropped, or the gateway failed. The backend may still have done the work —
 * prod 2026-11-18: the sales-import apply was cut at 30 s by the proxy, the page said "Nothing was applied", and the
 * admin applied again, four times. So after such a failure a page must NOT say "nothing happened": it re-reads the
 * result where it can, and otherwise says plainly that the outcome is unknown and what to check before retrying.
 *
 * A 4xx (other than 408) is a definite refusal: the backend answered and changed nothing.
 */

/** Plain-words reason used when no reply arrived. */
export const NO_REPLY = 'the server didn’t reply in time';

/** True when the failure carries no definite answer from the backend (the action may or may not have happened). */
export function outcomeUnknown(r: { success?: boolean; error?: string; status?: number }): boolean {
  const s = r.status;
  if (s === undefined || s === 0) return true; // fetch threw / no response at all
  if (s === 408) return true;
  return s >= 500;
}

/** The error as a reason inside a sentence (trimmed, no trailing full stop), or `fallback` when it is empty. */
export function reasonOr(error: string | null | undefined, fallback: string): string {
  const s = String(error ?? '').trim().replace(/\.+$/, '').trim();
  return s || fallback;
}
