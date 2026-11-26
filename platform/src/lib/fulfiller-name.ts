/**
 * FE MIRROR of api/src/common/fulfiller-name.ts — keep the two in step (a spec in each pins the rules).
 */
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

/** An object KEY with the name swapped (hubbleNeedsReconcile → apiNeedsReconcile, HUBBLE_X → API_X). */
export function neutralFulfillerKey(k: string): string {
  if (!HAS_NAME.test(k)) return k;
  return k
    .replace(/HUBBLE/g, 'API')
    .replace(/Hubble/g, 'Api')
    .replace(/hubble/gi, 'api');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep copy of a JSON-ish response with every string VALUE neutralised; with `keys: true` object KEYS too.
 * Only plain objects and arrays are walked — Dates, BigInts, Buffers, Decimals, class instances (e.g. a
 * StreamableFile) are returned as-is. Values without the name keep their reference (cheap on big lists).
 */
export function neutralFulfillerDeep<T>(value: T, opts: { keys?: boolean } = {}): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return neutralFulfillerText(v);
    if (depth > 64) return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x, depth + 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    if (isPlainObject(v)) {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const nk = opts.keys ? neutralFulfillerKey(k) : k;
        const y = walk(x, depth + 1);
        if (nk !== k || y !== x) changed = true;
        out[nk] = y;
      }
      return changed ? out : v;
    }
    return v;
  };
  return walk(value, 0) as T;
}

/**
 * Neutral version of an HTML e-mail body: the TEXT between tags and every attribute value are neutralised
 * (a forwarded e-mail's source is readable too); only link targets (href / src / action) are left untouched
 * so a link is never broken.
 */
const LINK_ATTRS: ReadonlySet<string> = new Set(['href', 'src', 'action', 'srcset']);
export function neutralFulfillerHtml(html: string): string {
  if (!HAS_NAME.test(html)) return html;
  return html
    .split(/(<[^>]*>)/)
    .map((part) =>
      part.startsWith('<')
        ? part.replace(
            /(\s([\w:-]+)\s*=\s*)(["'])(.*?)\3/g,
            (m, pre: string, name: string, q: string, val: string) =>
              LINK_ATTRS.has(name.toLowerCase()) ? m : `${pre}${q}${neutralFulfillerText(val)}${q}`,
          )
        : neutralFulfillerText(part),
    )
    .join('');
}
