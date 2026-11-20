/**
 * Redemption report — free text (status-history notes, cancel reasons) is typed by operators / vendors and can carry
 * provider error text, so it is NEVER exported raw:
 *   • a reason the platform itself writes is mapped to fixed plain words (KNOWN_REASONS / KNOWN_PREFIXES);
 *   • anything else is exported REDACTED: links, e-mails, PANs, hyphen-grouped codes (ABCD-1234), digit runs of 7+
 *     (phones, card numbers) and letter+digit runs of 8+ (voucher codes / PINs) become "[removed]".
 */
/** = rewards.service HUBBLE_NO_ORDER_REFUND_REASON (copied to keep this pure module light; a spec asserts equality). */
export const HUBBLE_NO_ORDER_REASON_TEXT = 'Hubble confirmed no order for this reference — refunded';

export const REDACTED = '[removed]';

/** Exact platform-written texts → plain words. */
const KNOWN_REASONS: Record<string, string> = {
  'Superseded — OTP not completed': 'OTP not completed — replaced by a newer order',
  'OTP could not be sent': 'OTP could not be sent',
  'Hubble voucher issued': 'E-voucher issued',
  'Hubble voucher processing': 'E-voucher being issued',
  [HUBBLE_NO_ORDER_REASON_TEXT]: 'E-voucher provider had no order — points refunded',
};

/** Platform-written prefixes whose tail is provider error text → fixed words only (the tail is dropped). */
const KNOWN_PREFIXES: Array<[RegExp, string]> = [
  [/^Hubble failed\b/i, 'E-voucher could not be issued — points refunded'],
  [/^Hubble issuance failed\b/i, 'E-voucher could not be issued'],
];

const PATTERNS: RegExp[] = [
  /\bhttps?:\/\/\S+/gi, // links (may carry tokens / codes)
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, // e-mail
  /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi, // PAN
  /\b(?=[A-Z0-9-]*\d)[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+\b/gi, // grouped codes: ABCD-1234, 1234-5678-9012
  /\+?\d(?:[\s-]?\d){6,}/g, // 7+ digits (phones, card numbers), spaces / hyphens allowed
  /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}\b/gi, // letter+digit runs of 8+ (voucher codes / PINs)
];

/** Redact one free-text value (no mapping). Empty → ''. */
export function redactFreeText(v: string | null | undefined): string {
  let s = (v ?? '').trim();
  if (!s) return '';
  for (const re of PATTERNS) s = s.replace(re, REDACTED);
  return s.replace(/(\[removed\][\s,;:/-]*){2,}/g, `${REDACTED} `).trim();
}

/** A platform reason in plain words, else the redacted text. Empty → ''. */
export function safeReasonText(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  if (!s) return '';
  if (KNOWN_REASONS[s]) return KNOWN_REASONS[s];
  for (const [re, words] of KNOWN_PREFIXES) if (re.test(s)) return words;
  return redactFreeText(s);
}
