/**
 * Location gate for a visibility capture (tenant flag `features.requireLocation`, sales reps only) — pure, so it is
 * unit-testable. See platform/docs/plans/LOCATION-GATE.md and common/location-gate.helper.ts.
 *
 * Rule when the flag is ON (release-gate review + audit 2026-11-19):
 *   1. every location-tagged photo (CAMERA with `geoFenceRequired` or `geotag`) that the rep submits IN THIS REQUEST
 *      (present in the request, visible after validation, not carried forward) must carry a real fix taken within
 *      the freshness window (`capturedAt`, same window as KYC: ≤ 60 min old, ≤ 10 min "future");
 *   2. photos carried forward unchanged (approved photos on a partial re-capture, or earlier answers the server merges
 *      back in) NEVER cause a refusal;
 *   3. the request must carry at least ONE fresh fix: a new tagged photo's fix, a GPS_POINT value sent in this
 *      request, or the phone's submit-time `captureGeo` (new clients always send it) — each within the window;
 *   4. when none of those exists AND the form has no location field the phone could fill (no tagged photo, no GPS
 *      field), the refusal names the FORM problem — never "retake photos".
 * A "real fix" = finite, in-range lat/lng and not the 0,0 null-island default. Ages use the phone's `clientNow` when
 * it is within 24 h of the server clock (see isFreshFixTime). Returns the message, or null.
 */
import { fixTimeProblem, isFreshFixTime, isRealFix, LOCATION_REQUIRED_VISIBILITY_MESSAGE } from '../common/location-gate.helper';
import { applicableCameraFields, evaluateVisibleWhen, parseGpsPoint } from './visibility-form.helper';
import { readMediaValue, type VisibilityFormSchema } from './visibility-types';

export const VISIBILITY_FORM_HAS_NO_LOCATION_MESSAGE =
  'This form has no location field, so the capture has no location — ask Gifsy to add one. (Location is required for this programme.)';

const has = (o: Record<string, unknown> | undefined, k: string) =>
  !!o && Object.prototype.hasOwnProperty.call(o, k);

/** The fix's own timestamp (`capturedAt`, or `ts`), if it carries one. */
const fixTime = (g: unknown): unknown => {
  if (!g || typeof g !== 'object') return undefined;
  const o = g as Record<string, unknown>;
  return o.capturedAt ?? o.ts;
};

export function visibilityLocationRefusal(
  schema: VisibilityFormSchema,
  /** The validated (visible-fields-only), merged values that will be stored. */
  values: Record<string, unknown>,
  /** Field ids carried forward unchanged from the earlier version (approved photos). */
  carriedFieldIds: ReadonlySet<string>,
  /** What THIS request sent (before the merge). */
  requestValues: Record<string, unknown> | undefined,
  /** The phone's submit-time fix (optional, new clients). */
  captureGeo?: unknown,
  /**
   * `evalValues` = the EXACT map submit validation evaluated (raw / merged submitted values + the server outlet
   * context). When given, only the location-tagged photos that APPLY to this outlet need a fix (visible +
   * required-or-captured — prod bug 2026-11-19), and only VISIBLE GPS fields count as a fresh fix. The "form has no
   * location field" decision always looks at the whole form. Without it: every field (previous behaviour).
   */
  opts: { now?: Date; clientNow?: unknown; evalValues?: Record<string, unknown> } = {},
): string | null {
  const now = opts.now ?? new Date();
  const fresh = (g: unknown) => isFreshFixTime(fixTime(g), now, opts.clientNow);
  const fields = schema.fields ?? [];
  const isTagged = (f: { type: string; geoFenceRequired?: boolean; geotag?: boolean }) =>
    f.type === 'CAMERA' && (f.geoFenceRequired === true || f.geotag === true);
  const taggedAll = fields.filter(isTagged);
  // Which photos need a fix: only the applicable ones (visibility on the validation map, presence on the stored values).
  const tagged = opts.evalValues ? applicableCameraFields(schema, opts.evalValues, isTagged, values) : taggedAll;
  const gpsAll = fields.filter((f) => f.type === 'GPS_POINT');
  // Which GPS fields can supply the fresh fix: only those visible for this outlet (a hidden Geo Tag 2 never counts).
  const gpsPoints = opts.evalValues ? gpsAll.filter((f) => evaluateVisibleWhen(f, opts.evalValues!)) : gpsAll;

  // 1 + 2 — new tagged photos in this request must each carry a real, recent fix.
  const missing: string[] = [];
  const stale: string[] = [];
  const wrongTime: string[] = [];
  let freshPhotoFix = false;
  for (const f of tagged) {
    if (carriedFieldIds.has(f.id) || !has(requestValues, f.id) || !has(values, f.id)) continue;
    const media = readMediaValue(values[f.id]);
    if (!media.key) continue; // nothing submitted for it
    if (!isRealFix(media.geo)) missing.push(f.label || f.id);
    else if (!fresh(media.geo)) {
      (fixTimeProblem(fixTime(media.geo), now, opts.clientNow) === 'old' ? stale : wrongTime).push(f.label || f.id);
    }
    else freshPhotoFix = true;
  }
  if (missing.length > 0) {
    return `${LOCATION_REQUIRED_VISIBILITY_MESSAGE} No location on: ${missing.map((m) => `"${m}"`).join(', ')}.`;
  }
  if (stale.length > 0) {
    // Round 4 #7: same window wording as KYC (the server limit is 60 minutes).
    return `The location on ${stale.map((m) => `"${m}"`).join(', ')} is older than 60 minutes — retake ${stale.length === 1 ? 'that photo' : 'those photos'} at the outlet, then submit again.`;
  }
  if (wrongTime.length > 0) {
    return `The location on ${wrongTime.map((m) => `"${m}"`).join(', ')} has a wrong time — retake ${wrongTime.length === 1 ? 'that photo' : 'those photos'} at the outlet, then submit again.`;
  }

  // 3 — at least one fresh fix from this request.
  const freshGps = gpsPoints.some((f) => {
    if (!has(requestValues, f.id)) return false;
    const raw = requestValues![f.id];
    return isRealFix(parseGpsPoint(raw)) && fresh(typeof raw === 'string' ? safeJson(raw) : raw);
  });
  const freshSubmit = isRealFix(parseGpsPoint(captureGeo)) && fresh(captureGeo);
  if (freshPhotoFix || freshGps || freshSubmit) return null;

  // 4 — name the form problem when the form itself cannot produce a location.
  // Rule 4 looks at the WHOLE form (unfiltered): a form that has location fields never gets the "no location field"
  // message, even when none of them applies to this outlet.
  if (taggedAll.length === 0 && gpsAll.length === 0 && !isRealFix(parseGpsPoint(captureGeo))) {
    return VISIBILITY_FORM_HAS_NO_LOCATION_MESSAGE;
  }
  return LOCATION_REQUIRED_VISIBILITY_MESSAGE;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
