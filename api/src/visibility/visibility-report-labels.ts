/**
 * Plain-English words for the Visibility (POSM) Excel reports (captures report + status report), so every sheet says
 * the same thing for the same state. Pure — no Nest / Prisma.
 */
import { IST_OFFSET_MIN } from '../common/ist-date';

/**
 * THE plain status words of Visibility — every API surface (Excel report, status report, report screen, dashboards,
 * digest) uses these. The platform mirror is `VISIBILITY_STATUS_WORDS` in platform/src/lib/visibility-types.ts
 * (same strings; a test on each side pins them).
 */
export const VISIBILITY_WORDS = {
  WAITING: 'Waiting for review',
  APPROVED: 'Approved',
  NEEDS_RETAKE: 'Needs re-take',
  REJECTED: 'Rejected',
  /** A re-take request / rejection left when the window closed — a resubmit is refused, so it is final. */
  CLOSED_NOT_APPROVED: 'Not approved — window closed',
  NOT_CAPTURED: 'Not captured yet',
  MISSED: 'Missed',
  NOT_STARTED: 'Not started',
  NOT_TRACKED: 'Not tracked for imported months',
  /** A closed window partly on the old app (it only sent approved visits) with no capture — never "Missed". */
  PART_OLD_APP: 'No approved record — part of this window was on the old app',
} as const;

/** Capture status code → words (open window). */
export const VISIBILITY_STATUS_WORDS: Record<string, string> = {
  SUBMITTED: VISIBILITY_WORDS.WAITING,
  APPROVED: VISIBILITY_WORDS.APPROVED,
  CHANGES_REQUESTED: VISIBILITY_WORDS.NEEDS_RETAKE,
  REJECTED: VISIBILITY_WORDS.REJECTED,
};

/** The capture status words, in the order the Excel About sheet counts them. */
export const VISIBILITY_STATUS_ORDER = [
  VISIBILITY_WORDS.APPROVED,
  VISIBILITY_WORDS.WAITING,
  VISIBILITY_WORDS.NEEDS_RETAKE,
  VISIBILITY_WORDS.REJECTED,
  VISIBILITY_WORDS.CLOSED_NOT_APPROVED,
] as const;

/**
 * A capture's words. `windowClosed`: a CHANGES_REQUESTED / REJECTED capture whose window has closed can no longer be
 * resubmitted → "Not approved — window closed" (same rule as visibility-metrics plainStatusOf).
 */
export function visibilityStatusWords(status: string | null | undefined, opts: { windowClosed?: boolean } = {}): string {
  if (!status) return '';
  if (opts.windowClosed && (status === 'CHANGES_REQUESTED' || status === 'REJECTED')) return VISIBILITY_WORDS.CLOSED_NOT_APPROVED;
  return VISIBILITY_STATUS_WORDS[status] ?? status;
}

/** Reject-reason code → label (mirrors platform VISIBILITY_REJECT_REASON_LABELS). */
export const VISIBILITY_REASON_LABELS: Record<string, string> = {
  BLURRY: 'Photo is blurry / unclear',
  WRONG_OUTLET: 'Wrong outlet',
  POSM_NOT_VISIBLE: 'POSM not visible',
  GEO_MISMATCH: 'Location mismatch',
  DUPLICATE_PHOTO: 'Duplicate photo',
  INCORRECT_POSM: 'Incorrect POSM',
  MOBILE_SCREEN_PHOTO: 'Photo of a mobile screen',
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
