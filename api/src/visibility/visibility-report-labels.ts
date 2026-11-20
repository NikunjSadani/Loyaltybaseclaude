/**
 * Plain-English words for the Visibility (POSM) Excel reports (captures report + status report), so every sheet says
 * the same thing for the same state. Pure — no Nest / Prisma.
 */
import { IST_OFFSET_MIN } from '../common/ist-date';

/** Capture status → the words a client admin reads in the report. */
export const VISIBILITY_STATUS_WORDS: Record<string, string> = {
  SUBMITTED: 'Waiting for review',
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Needs re-take',
  REJECTED: 'Rejected',
};

/** The report's status words, in the order the About sheet lists them. */
export const VISIBILITY_STATUS_ORDER = ['APPROVED', 'SUBMITTED', 'CHANGES_REQUESTED', 'REJECTED'] as const;

export function visibilityStatusWords(status: string | null | undefined): string {
  if (!status) return '';
  return VISIBILITY_STATUS_WORDS[status] ?? status;
}

/** Reject-reason code → label (mirrors platform VISIBILITY_REJECT_REASON_LABELS). */
export const VISIBILITY_REASON_LABELS: Record<string, string> = {
  BLURRY: 'Photo is blurry / unclear',
  WRONG_OUTLET: 'Wrong outlet',
  POSM_NOT_VISIBLE: 'POSM not visible',
  GEO_MISMATCH: 'Location mismatch',
  DUPLICATE_PHOTO: 'Duplicate photo',
  OTHER: 'Other',
};

export function reasonCodeLabel(code: string | null | undefined): string {
  if (!code) return '';
  return VISIBILITY_REASON_LABELS[code] ?? code;
}

/** The reason text a reader sees: the reviewer's own words, else the reason code's label. */
export function reasonText(reason: string | null | undefined, code: string | null | undefined): string {
  const r = (reason ?? '').trim();
  return r || reasonCodeLabel(code);
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An instant as IST text "20 Nov 2026, 3:05 pm" (empty for null / invalid). */
export function istHumanDateTime(d: Date | string | null | undefined): string {
  if (!d) return '';
  const t = typeof d === 'string' ? Date.parse(d) : d.getTime();
  if (!Number.isFinite(t)) return '';
  const s = new Date(t + IST_OFFSET_MIN * 60_000);
  const h24 = s.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(s.getUTCMinutes()).padStart(2, '0');
  const dd = String(s.getUTCDate()).padStart(2, '0');
  return `${dd} ${MONTHS_SHORT[s.getUTCMonth()]} ${s.getUTCFullYear()}, ${h12}:${mm} ${h24 < 12 ? 'am' : 'pm'}`;
}

/** "November 2026" for a `YYYY-MM` key. */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const long = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${long[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** A fence verdict in words, with the distance (+ accuracy) when known: "Inside fence (34 m, ±20 m)". */
export function locationWords(
  verdict: 'inside' | 'outside' | 'unverifiable' | null | undefined,
  distanceMeters?: number | null,
  accuracyMeters?: number | null,
): string {
  if (!verdict) return '';
  const word = verdict === 'inside' ? 'Inside fence' : verdict === 'outside' ? 'Outside fence' : 'Unverifiable';
  const bits: string[] = [];
  if (distanceMeters != null && Number.isFinite(distanceMeters)) bits.push(`${Math.round(distanceMeters)} m`);
  if (accuracyMeters != null && Number.isFinite(accuracyMeters)) bits.push(`±${Math.round(accuracyMeters)} m`);
  return bits.length ? `${word} (${bits.join(', ')})` : word;
}
