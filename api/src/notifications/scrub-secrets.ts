/**
 * Keep caller-flagged secrets (a voucher code / gift-card PIN / the combined "code | PIN" value) out
 * of anything stored or logged about a failed send (MessageDeliveryReceipt.failureReason — shown to
 * CLIENT_ADMIN — and app logs).
 *
 * ALL-OR-NOTHING: if ANY secret is found in the text, the WHOLE text is replaced with
 * SCRUBBED_PROVIDER_ERROR. Partial masking is deliberately NOT done — masking a short PIN in place
 * leaves its surroundings (and a re-encoded copy elsewhere in the text) readable, which leaks it.
 *
 * A secret matches as a TOKEN only: bounded on both sides by a non-alphanumeric character or the
 * string edge (so the PIN "4829" does not match inside "148290"). Each secret is also matched in its
 * JSON-escaped form (a provider echoing a JSON body) and its URL-encoded forms (`%20` and `+` for
 * spaces). Matching is case-insensitive. Blank secrets are ignored. No match → text unchanged.
 *
 * Accepts ANY input: a string as-is; null / undefined → ''; an Error → String(error); anything else
 * → JSON.stringify (never throws — falls back to String(), then '').
 */
export const SCRUBBED_PROVIDER_ERROR = 'Provider error (details withheld — the message contained voucher data)';

function toText(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) {
    try {
      return String(input);
    } catch {
      return '';
    }
  }
  try {
    const json = JSON.stringify(input);
    if (typeof json === 'string') return json;
  } catch {
    /* circular / BigInt — fall through */
  }
  try {
    return String(input);
  } catch {
    return '';
  }
}

/** Every encoded form a secret may appear in. */
function variantsOf(secret: string): string[] {
  const out = new Set<string>();
  for (const s of [secret, secret.trim()]) {
    if (s.trim() === '') continue;
    out.add(s);
    out.add(JSON.stringify(s).slice(1, -1)); // JSON-escaped (quotes, backslashes, \n, \t, \u…)
    try {
      const enc = encodeURIComponent(s);
      out.add(enc);
      out.add(enc.replace(/%20/g, '+')); // application/x-www-form-urlencoded
    } catch {
      /* lone surrogate — no URL form */
    }
  }
  return [...out].filter((v) => v.trim() !== '');
}

const isAlnum = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** True when `needle` occurs in `hay` bounded by non-alphanumerics / string edges (both lower-cased). */
function containsToken(hay: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at > 0 ? hay[at - 1] : undefined;
    const after = hay[at + needle.length];
    // A boundary is only required where the secret itself starts / ends with an alphanumeric.
    const okBefore = !isAlnum(needle[0]) || !isAlnum(before);
    const okAfter = !isAlnum(needle[needle.length - 1]) || !isAlnum(after);
    if (okBefore && okAfter) return true;
    from = at + 1;
  }
}

/** True when any non-blank secret (in any encoded form) occurs as a token in the text. */
export function containsSecret(text: string, secrets: readonly unknown[] | null | undefined): boolean {
  if (!secrets?.length || !text) return false;
  const hay = text.toLowerCase();
  for (const s of secrets) {
    if (typeof s !== 'string' || s.trim() === '') continue;
    for (const v of variantsOf(s)) if (containsToken(hay, v.toLowerCase())) return true;
  }
  return false;
}

export function scrubSecrets(input: unknown, secrets?: readonly unknown[] | null): string {
  const text = toText(input);
  return containsSecret(text, secrets) ? SCRUBBED_PROVIDER_ERROR : text;
}
