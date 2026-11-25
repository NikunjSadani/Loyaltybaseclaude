/**
 * Sales photo view (owner 2026-11-24) — pure helpers that turn ONE capture's CURRENT version into the photo list a
 * sales manager sees in the sales app (outlet Visibility card + the Visibility screen's "View photos").
 *
 * TENANT-SCOPED: only used when the tenant's `visibilityConfig.salesPhotoViewLevels` lists the caller's sales level
 * (empty / absent = OFF — every response stays exactly as before). Never returns GPS coordinates: only the per-photo
 * in-fence / outside / unverifiable word for a fence-required photo. Pure — no Nest / Prisma.
 */
import { Prisma } from '@prisma/client';
import { classifyPhotoFence, PhotoFencePolicy, PhotoFenceStatus } from './geo-fence.helper';
import { readMediaValue, readPhotoReviews, VisibilityFormSchema } from './visibility-types';
import { reasonText } from './visibility-report-labels';

/** One photo's review state in the plain sales words: Approved / Needs re-take / Waiting. */
export type SalesPhotoStatus = 'approved' | 'needs_retake' | 'pending';

export interface SalesCapturePhoto {
  fieldId: string;
  /** The form field label (also the image's alt text). */
  label: string;
  /** Stored object key — read through the auth-gated media stream (viewPath), never a public URL. */
  mediaKey: string;
  /** Auth-gated stream path (`/v1/visibility/captures/media?key=…`), exactly what the admin review queue renders. */
  viewPath: string;
  status: SalesPhotoStatus;
  /** Why THIS photo needs a re-take (per-photo review); null otherwise — a whole-capture reason is `captureReason`. */
  reason: string | null;
  /**
   * When THIS photo was taken: its own shutter time when tagged, else when the version that first held this photo was
   * submitted (a photo carried forward from v1 keeps its v1 time), else the capture's submit time.
   */
  capturedAt: string | null;
  /** Who submitted the version that first held this photo (a carried-forward photo keeps its original submitter). */
  takenBy: string | null;
  /** Fence-required photos only: inside / outside / unverifiable — never the coordinates. */
  fenceStatus?: PhotoFenceStatus;
}

export interface SalesCapturePhotos {
  captureId: string;
  windowKey: string;
  /** The CURRENT version (older versions are never returned). */
  version: number;
  status: string;
  /** Name of the sales user who submitted the current version (null when unknown / removed). */
  submittedBy: string | null;
  /** When the current version was submitted (server time, ISO). */
  submittedAt: string | null;
  /** A whole-capture rejection reason, shown ONCE (null for per-photo reviews / no rejection). */
  captureReason: string | null;
  /** The window has closed — a photo never reviewed reads "Not reviewed" instead of "Waiting". */
  windowClosed: boolean;
  photos: SalesCapturePhoto[];
}

/** The capture columns buildSalesCapturePhotos reads (selected by the capture service). */
export interface SalesPhotoCaptureRow {
  id: string;
  windowKey: string;
  status: string;
  currentVersion: number;
  formValues: Prisma.JsonValue | null;
  photoReviews: Prisma.JsonValue | null;
  rejectionReason: string | null;
  rejectionReasonCode: string | null;
  receivedAt: Date | null;
  submittedBySalesUserId?: string | null;
  submittedBy?: { user?: { name?: string | null } | null } | null;
}

/** One stored version (submission) of a capture — used to find when / by whom each photo was first submitted. */
export interface SalesPhotoSubmissionRow {
  version: number;
  formValues: Prisma.JsonValue | null;
  createdAt: Date | null;
  submittedBy?: { user?: { name?: string | null } | null } | null;
}

/** Prisma `select` for the columns above — shared by every sales photo read so they never drift. */
export const SALES_PHOTO_CAPTURE_SELECT = {
  id: true,
  outletId: true,
  windowKey: true,
  status: true,
  currentVersion: true,
  formVersion: true,
  formValues: true,
  photoReviews: true,
  rejectionReason: true,
  rejectionReasonCode: true,
  receivedAt: true,
  submittedBySalesUserId: true,
  submittedBy: { select: { user: { select: { name: true } } } },
} as const;

const iso = (d: Date | null | undefined): string | null =>
  d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : null;

/** A photo-tag time as ISO (string / epoch), else null. */
function tagTime(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const nameOf = (s: { user?: { name?: string | null } | null } | null | undefined): string | null =>
  s?.user?.name?.trim() || null;

/** True when a form field of this schema could hold a photo needing a fence word (cheap pre-check). */
export function schemaHasFencePhoto(schema: VisibilityFormSchema | null | undefined): boolean {
  return (schema?.fields ?? []).some((f) => f.type === 'CAMERA' && f.geoFenceRequired === true);
}

/**
 * The capture's CURRENT photos for a sales viewer. Per photo: the per-photo review wins (APPROVED → approved,
 * REJECTED → needs re-take with its reason); with no per-photo review the whole-capture decision applies (APPROVED →
 * approved, REJECTED → needs re-take, its reason given ONCE as `captureReason`); otherwise pending.
 * `fencePolicy` null → no fence word. `submissions` (any order) date / attribute each photo to the version that first
 * held it.
 */
export function buildSalesCapturePhotos(
  capture: SalesPhotoCaptureRow,
  schema: VisibilityFormSchema | null,
  fencePolicy: PhotoFencePolicy | null,
  opts: { windowClosed?: boolean; submissions?: SalesPhotoSubmissionRow[] } = {},
): SalesCapturePhotos {
  const values =
    capture.formValues && typeof capture.formValues === 'object' && !Array.isArray(capture.formValues)
      ? (capture.formValues as Record<string, unknown>)
      : {};
  const reviews = readPhotoReviews(capture.photoReviews);
  const submittedAt = iso(capture.receivedAt);
  const submittedBy = nameOf(capture.submittedBy);
  const versions = [...(opts.submissions ?? [])].sort((a, b) => a.version - b.version);
  const wholeReject = capture.status === 'REJECTED';
  const photos: SalesCapturePhoto[] = [];
  for (const f of schema?.fields ?? []) {
    if (f.type !== 'CAMERA') continue;
    const { key, geo } = readMediaValue(values[f.id]);
    if (!key) continue;
    const review = reviews[f.id];
    let status: SalesPhotoStatus = 'pending';
    let reason: string | null = null;
    if (review?.status === 'APPROVED') status = 'approved';
    else if (review?.status === 'REJECTED') {
      status = 'needs_retake';
      reason = reasonText(review.reason, review.reasonCode) || null;
    } else if (capture.status === 'APPROVED') status = 'approved';
    else if (wholeReject) status = 'needs_retake';
    // The first stored version holding this exact photo (carried-forward photos keep their original time / submitter).
    const first = versions.find((s) => {
      const v = s.formValues && typeof s.formValues === 'object' && !Array.isArray(s.formValues)
        ? (s.formValues as Record<string, unknown>)
        : {};
      return readMediaValue(v[f.id]).key === key;
    });
    const photo: SalesCapturePhoto = {
      fieldId: f.id,
      label: f.label,
      mediaKey: key,
      // `c` = this capture: the media check reads that one row (primary key) instead of scanning the month.
      viewPath: `/v1/visibility/captures/media?key=${encodeURIComponent(key)}&c=${encodeURIComponent(capture.id)}`,
      status,
      reason,
      capturedAt: tagTime(geo?.capturedAt) ?? iso(first?.createdAt) ?? submittedAt,
      takenBy: first ? nameOf(first.submittedBy) : submittedBy,
    };
    if (f.geoFenceRequired === true && fencePolicy) {
      photo.fenceStatus = classifyPhotoFence(geo ?? null, fencePolicy).status;
    }
    photos.push(photo);
  }
  return {
    captureId: capture.id,
    windowKey: capture.windowKey,
    version: capture.currentVersion,
    status: capture.status,
    submittedBy,
    submittedAt,
    captureReason: wholeReject ? reasonText(capture.rejectionReason, capture.rejectionReasonCode) || null : null,
    windowClosed: opts.windowClosed === true,
    photos,
  };
}

/**
 * Prisma `OR` filters matching a capture whose formValues holds `key` in any of the given CAMERA field ids — both
 * stored shapes: a bare key string, or `{ key, geo }`. Exact match (never a substring).
 */
export function mediaKeyRefWhere(fieldIds: string[], key: string): Array<{ formValues: { path: string[]; equals: string } }> {
  const out: Array<{ formValues: { path: string[]; equals: string } }> = [];
  for (const id of fieldIds) {
    out.push({ formValues: { path: [id], equals: key } });
    out.push({ formValues: { path: [id, 'key'], equals: key } });
  }
  return out;
}

/** True when this exact key sits in one of the CAMERA fields of a stored formValues blob. */
export function formValuesHoldKey(formValues: Prisma.JsonValue | null, fieldIds: string[], key: string): boolean {
  if (!formValues || typeof formValues !== 'object' || Array.isArray(formValues)) return false;
  const v = formValues as Record<string, unknown>;
  return fieldIds.some((id) => readMediaValue(v[id]).key === key);
}

/**
 * The `<YYYY-MM>` upload month of an OWNER-foldered sales upload of `userSegment` (`u/<userId>`) in tenant `clientId`:
 * `visibility-media/<clientId>/u/<userId>/<YYYY-MM>/…` → 'YYYY-MM'; null for any other key (old format, another user,
 * sample image, vendor import).
 */
export function ownUploadMonth(key: string, clientId: string, userSegment: string): string | null {
  const prefix = `visibility-media/${clientId}/${userSegment}/`;
  if (!key.startsWith(prefix)) return null;
  const m = /^(\d{4}-\d{2})\//.exec(key.slice(prefix.length));
  return m ? m[1] : null;
}
