/**
 * OWNER RULE (2026-11-26, all clients): a client must never see that e-vouchers are procured from Hubble.
 *
 *  - Every surface a CLIENT admin / client user / sales user / partner / vendor can open says "Via API"
 *    (or neutral words such as "the API provider") instead of "Hubble".
 *  - Every DOWNLOADED file (xlsx / csv exports, sheets) and every e-mailed report / digest says "Via API",
 *    whoever generated it — Gifsy staff included — because files and e-mails get forwarded to clients.
 *  - Only on-screen, Gifsy-only consoles may keep "Hubble".
 *
 * Presentation-layer only: stored values (voucherProvider 'Hubble', status-history notes, metadata keys,
 * enum / reason codes) are NEVER renamed — they are mapped here on the way out.
 */

/** The client-facing name of the API voucher fulfiller (= Hubble, known only to Gifsy). */
export const VIA_API = 'Via API';

const HAS_NAME = /hubble/i;

/** Does this text mention the fulfiller by name (any case)? */
export function mentionsFulfillerName(v: string): boolean {
  return HAS_NAME.test(v);
}

/** Exact platform-written texts → hand-written neutral words. */
const KNOWN: Record<string, string> = {
  'hubble': VIA_API,
  'hubble voucher issued': 'E-voucher issued via API',
  'hubble voucher processing': 'E-voucher being issued via API',
  'hubble reported failed': 'The API provider reported the voucher failed',
};

/**
 * Ordered rewrite rules for free text (prose, labels, codes). The last rule is a catch-all, so the result
 * never contains "hubble" in any case.
 */
const RULES: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  // Reason / status CODES: HUBBLE_INDETERMINATE → API_INDETERMINATE.
  [/HUBBLE/g, 'API'],
  // Identifiers inside text (hubbleNeedsReconcile → apiNeedsReconcile, noHubbleOrder → noApiOrder, hubble_x).
  [/hubble(?=[A-Z_])/g, 'api'],
  [/(?<=[a-z])Hubble(?=[A-Z])/g, 'Api'],
  // Labels.
  [/\(\s*Hubble\s*\)/gi, '(Via API)'],
  [/\bHubble\s*:/gi, 'Via API:'],
  [/\bHubble Money\b/gi, 'API'],
  // Possessives.
  [/(^|[.!?]\s+|[\n>•—–]\s*)Hubble['’]s\b/gi, (_m, pre: string) => `${pre}The API provider's`],
  [/\bHubble['’]s\b/gi, "the API provider's"],
  [/\bHubble didn['’]t\b/gi, "the API provider didn't"],
  // Prepositions: "Retry with Hubble" → "Retry via API", "sent to Hubble" → "sent via API".
  [/\b(?:with|to|by|from|at|on|in|via|through)\s+(?:the\s+)?Hubble\b/gi, 'via API'],
  // Articles: "a Hubble order" → "an API order", "the Hubble integration" → "the API integration".
  [/\ban?\s+Hubble\b/gi, (m) => (m[0] === 'A' ? 'An API' : 'an API')],
  [/\bthe\s+Hubble\b/gi, (m) => (m[0] === 'T' ? 'The API' : 'the API')],
  // Adjective use before a known noun: "Hubble voucher", "Hubble order", "Hubble-issued" → "API voucher", …
  [
    /\bHubble(?=[- ](?:vouchers?|orders?|status|statuses|account|products?|gift|brands?|integration|issuance|reference|reconcile|review|webhooks?|feature|credentials|money|issued|routed|handed|failures?|unreachable|enabled|amounts?|limits?|portal|range|minimum|maximum|outcome|flags?|code|codes|ref|refs|purchases?)\b)/gi,
    'API',
  ],
  // Sentence-initial subject: "Hubble reported …" → "The API provider reported …".
  [/(^|[.!?]\s+|[\n>•—–]\s*)Hubble\b(?=\s+[a-z])/g, (_m, pre: string) => `${pre}The API provider`],
  // Adjective / hyphen use: "Hubble voucher", "Hubble-issued", "non-Hubble" → "API voucher", …
  [/\bHubble(?=[- ])/gi, 'API'],
  // Anything left (a bare mention) → "Via API" — and the catch-all guarantees no trace remains.
  [/hubble/gi, VIA_API],
];

/**
 * Neutral version of a client-reachable / exported text: "Hubble" never survives (any case, any position).
 * Text without the name is returned unchanged (same reference), so this is safe on every string cell.
 */
export function neutralFulfillerText(v: string): string {
  if (!HAS_NAME.test(v)) return v;
  const known = KNOWN[v.trim().toLowerCase()];
  if (known) return known;
  let s = v;
  for (const [re, to] of RULES) s = s.replace(re, to as never);
  return s;
}


/** The wording a fulfiller-failure refund carries in the points ledger (partner passbook / statements). */
export const FULFILLER_REFUND_SUFFIX = '(voucher could not be issued)';

/**
 * The ONE platform-written ledger narration that named the fulfiller — `Refund <order> (Hubble failed)`
 * (rewards.service refundAndFailHubble, rows written before 2026-11-26) — in neutral words. Field-level and
 * exact: any other narration (uploaded / typed text) is returned unchanged.
 */
export function neutralRefundNarration<T extends string | null | undefined>(d: T): T {
  if (typeof d !== 'string') return d;
  return d.replace(/^(Refund \S+) \(Hubble failed\)$/, `$1 ${FULFILLER_REFUND_SUFFIX}`) as T;
}
