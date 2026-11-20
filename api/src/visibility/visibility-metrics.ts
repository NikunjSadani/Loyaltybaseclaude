/**
 * visibility-metrics.ts — THE shared definitions behind every Visibility (POSM) number: the report screen,
 * the admin "Pending Visibility Approvals" tile, the Operations "Visibility Program Funnel" and the Daily Ops
 * Digest. VISIBILITY-POSM-DESIGN.md §"Metrics (month-wise)" is the written contract; this file is its code.
 *
 *   - Everything is MONTH-WISE: a month `YYYY-MM` (default = the current IST month) selects every window
 *     `YYYY-MM-Pn` of that month. Imported old-app captures carry `windowKey = <their month>-P1`, so they
 *     count in their own month like any other capture (no separate view).
 *   - In scope = visibilityUniverseWhere (visibility-scope.helper) — one rule for every surface.
 *   - The unit is an OUTLET-WINDOW ("visit due"): one per in-scope outlet per window of the month
 *     (frequency 1 → one per outlet). Each has exactly one plain status (PLAIN_STATUS_LABEL).
 *
 * Pure helpers are exported for unit tests; the prisma loaders take the client explicitly (no DI) so the
 * dashboards / digest / report can share them without cross-module wiring.
 */
import { Prisma, VisibilityCaptureStatus } from '@prisma/client';
import { istMonthKey } from '../common/ist-date';
import { isWindowClosed, windowsForMonth } from './visibility-window.helper';
import { visibilityUniverseWhere, VisibilityProgramScopeLike } from './visibility-scope.helper';
import {
  MEDIA_FIELD_TYPES,
  readMediaValue,
  readPhotoReviews,
  VisibilityFormSchema,
} from './visibility-types';
import { classifyPhotoFence, outletMasterFencePolicy, PhotoFencePolicy } from './geo-fence.helper';

// ─────────────────────────────────────────────────────────────────────────────
// Plain statuses (owner decision 2026-11-20)
// ─────────────────────────────────────────────────────────────────────────────

export const PLAIN_STATUSES = ['WAITING', 'APPROVED', 'NEEDS_RETAKE', 'REJECTED', 'NOT_CAPTURED', 'MISSED'] as const;
export type PlainStatus = (typeof PLAIN_STATUSES)[number];

/** The words shown to people. Keep in sync with platform/src/lib/visibility-report.ts (FE mirror). */
export const PLAIN_STATUS_LABEL: Record<PlainStatus, string> = {
  WAITING: 'Waiting for review',
  APPROVED: 'Approved',
  NEEDS_RETAKE: 'Needs re-take',
  REJECTED: 'Rejected',
  NOT_CAPTURED: 'Not captured yet',
  MISSED: 'Missed',
};

/**
 * One outlet-window's plain status. A capture row wins (SUBMITTED → Waiting for review, CHANGES_REQUESTED →
 * Needs re-take). No capture: "Not captured yet" while the window is open (or not started), "Missed" ONLY
 * once the window has closed.
 */
export function plainStatusOf(status: VisibilityCaptureStatus | null | undefined, windowClosed: boolean): PlainStatus {
  switch (status) {
    case 'SUBMITTED':
      return 'WAITING';
    case 'APPROVED':
      return 'APPROVED';
    case 'CHANGES_REQUESTED':
      return 'NEEDS_RETAKE';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return windowClosed ? 'MISSED' : 'NOT_CAPTURED';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Month + windows
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The month to report: a valid `YYYY-MM`, else the current IST month. Throws on a malformed non-empty value. */
export function resolveMonth(input: unknown, now: Date): string {
  if (input === undefined || input === null || (typeof input === 'string' && input.trim() === '')) {
    return istMonthKey(now);
  }
  const m = typeof input === 'string' ? input.trim() : '';
  if (!MONTH_RE.test(m)) throw new Error(`Invalid month "${String(input)}" — expected YYYY-MM`);
  return m;
}

/** Every window of `month` at the CURRENT frequency, with its open/closed state (IST). */
export function monthWindows(month: string, freq: number, now: Date): Array<{ key: string; closed: boolean }> {
  return windowsForMonth(month, freq).map((key) => ({ key, closed: isWindowClosed(key, now, freq) }));
}

/** Capture `where` for every window of a month (index-friendly prefix match on (clientId, windowKey)). */
export function monthCaptureWhere(clientId: string, month: string): Prisma.VisibilityCaptureWhereInput {
  return { clientId, windowKey: { startsWith: `${month}-P` } };
}

type ScopeConfig = VisibilityProgramScopeLike & { outletScope: ReadonlyArray<string> };

/** Read client for the loaders (PrismaService or a transaction client). */
type MetricsPrisma = Pick<
  Prisma.TransactionClient,
  'visibilityCapture' | 'visibilityImageHash' | 'visibilityFormVersion' | 'visibilityForm' | 'outlet' | 'kycSubmission' | 'client'
>;

// ─────────────────────────────────────────────────────────────────────────────
// Status counts for a month (tile / funnel / digest)
// ─────────────────────────────────────────────────────────────────────────────

export interface MonthStatusCounts {
  month: string;
  /** Captures for in-scope outlets in this month, any status ("Submitted" on the funnel). */
  submitted: number;
  waiting: number;
  needsRetake: number;
  approved: number;
  rejected: number;
}

/** Fold a status groupBy into the plain buckets. Pure. */
export function foldStatusCounts(
  month: string,
  rows: Array<{ status: VisibilityCaptureStatus | string; _count: { _all: number } }>,
): MonthStatusCounts {
  const of = (s: string) => rows.filter((r) => r.status === s).reduce((n, r) => n + r._count._all, 0);
  const waiting = of('SUBMITTED');
  const needsRetake = of('CHANGES_REQUESTED');
  const approved = of('APPROVED');
  const rejected = of('REJECTED');
  return { month, submitted: waiting + needsRetake + approved + rejected, waiting, needsRetake, approved, rejected };
}

/**
 * Status counts of a month's captures for IN-SCOPE outlets. An empty outletScope → all zeros (no query).
 * `extraOutlet` narrows further (e.g. the admin dashboard's program filter) — ANDed with the in-scope rule.
 */
export async function loadMonthStatusCounts(
  prisma: Pick<MetricsPrisma, 'visibilityCapture'>,
  clientId: string,
  config: ScopeConfig,
  month: string,
  extraOutlet?: Prisma.OutletWhereInput,
): Promise<MonthStatusCounts> {
  if (!config.outletScope?.length) return foldStatusCounts(month, []);
  const universe = visibilityUniverseWhere(clientId, config);
  const rows = await prisma.visibilityCapture.groupBy({
    by: ['status'],
    where: { ...monthCaptureWhere(clientId, month), outlet: extraOutlet ? { AND: [universe, extraOutlet] } : universe },
    _count: { _all: true },
  });
  return foldStatusCounts(month, rows as Array<{ status: VisibilityCaptureStatus; _count: { _all: number } }>);
}

/**
 * Approval rate = Approved ÷ (Approved + Needs re-take + Rejected) — the share of this month's captures that
 * a reviewer has decided on and that ended up approved. Captures still "Waiting for review" are NOT in the
 * denominator (no decision yet). null when nothing has been decided (never a fabricated 0 / 100).
 */
export function approvalRatePct(c: Pick<MonthStatusCounts, 'approved' | 'needsRetake' | 'rejected'>): number | null {
  const reviewed = c.approved + c.needsRetake + c.rejected;
  if (reviewed <= 0) return null;
  return Math.round((c.approved / reviewed) * 1000) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fraud flags: duplicate photo / photo outside the fence
// ─────────────────────────────────────────────────────────────────────────────

export type FlagReason = 'DUPLICATE_PHOTO' | 'OUTSIDE_FENCE';
export const FLAG_REASON_LABEL: Record<FlagReason, string> = {
  DUPLICATE_PHOTO: 'Duplicate photo',
  OUTSIDE_FENCE: 'Photo outside the outlet fence',
};

/**
 * The CAMERA fields of a capture whose photo is OUTSIDE the fence under `policy` — the reviewer's per-photo
 * badge rule (visibility-review.service extractMedia): every fence-required CAMERA field holding a photo,
 * classified by the shared classifyPhotoFence. Unverifiable (no fix / no reference) is NOT outside. Pure.
 */
export function outsideFenceFields(
  formValues: unknown,
  schema: VisibilityFormSchema | null,
  policy: PhotoFencePolicy,
): string[] {
  if (!schema || !formValues || typeof formValues !== 'object' || Array.isArray(formValues)) return [];
  const vals = formValues as Record<string, unknown>;
  const out: string[] = [];
  for (const f of schema.fields ?? []) {
    if (!MEDIA_FIELD_TYPES.has(f.type) || f.geoFenceRequired !== true) continue;
    const { key, geo } = readMediaValue(vals[f.id]);
    if (!key) continue;
    if (classifyPhotoFence(geo ?? null, policy).status === 'outside') out.push(f.label || f.id);
  }
  return out;
}

export interface FlaggedCapture {
  captureId: string;
  outletId: string;
  outletCode: string;
  outletName: string;
  windowKey: string;
  status: PlainStatus;
  reasons: FlagReason[];
  /** Other captures sharing a photo with this one (outlet code + window). */
  duplicateOf: Array<{ outletCode: string; windowKey: string }>;
  /** Photo labels found outside the fence. */
  outsidePhotos: string[];
}

export interface FraudFlagResult {
  month: string;
  submitted: number;
  flagged: number;
  duplicate: number;
  outsideFence: number;
  /** flagged ÷ submitted × 100 (1 dp); null when nothing was submitted. */
  flagRatePct: number | null;
  rows: FlaggedCapture[];
}

const CHUNK = 5000;
function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Flagged = a capture of the month (in-scope outlet) with
 *   (a) a DUPLICATE photo — any of its VisibilityImageHash values is shared with ANOTHER capture of this tenant
 *       (any outlet, any window), or
 *   (b) a photo OUTSIDE THE FENCE — the stored aggregate verdict geoFenceOk === false, OR any fence-required
 *       photo classified 'outside' today under the reviewer's per-photo policy (outlet-master tenants: the outlet
 *       coordinates + 200 m + accuracy buffer; others: the latest APPROVED KYC board-photo geo + the configured
 *       radius). Computed regardless of whether the fence is switched on (a far-away photo is suspicious either way).
 * A capture with both reasons counts ONCE in `flagged`. Imported old-app captures have no hashes and no photo
 * geo, so they are never flagged (unverifiable ≠ outside).
 */
export async function loadFraudFlags(
  prisma: MetricsPrisma,
  clientId: string,
  config: ScopeConfig & { geoFence: { radiusMeters: number } },
  month: string,
  now: Date,
  freq: number,
): Promise<FraudFlagResult> {
  const empty: FraudFlagResult = {
    month, submitted: 0, flagged: 0, duplicate: 0, outsideFence: 0, flagRatePct: null, rows: [],
  };
  if (!config.outletScope?.length) return empty;

  const captures = await prisma.visibilityCapture.findMany({
    where: { ...monthCaptureWhere(clientId, month), outlet: visibilityUniverseWhere(clientId, config) },
    select: {
      id: true, outletId: true, outletCode: true, outletName: true, windowKey: true, status: true,
      formVersion: true, formValues: true, geoFenceOk: true,
      outlet: { select: { latitude: true, longitude: true, partnerId: true } },
    },
  });
  if (captures.length === 0) return empty;
  const ids = captures.map((c) => c.id);

  // (a) duplicates — this month's hashes, then every OTHER capture holding the same hash.
  const ownHashes: Array<{ captureId: string; hash: string }> = [];
  for (const part of chunks(ids)) {
    ownHashes.push(
      ...(await prisma.visibilityImageHash.findMany({
        where: { clientId, captureId: { in: part } },
        select: { captureId: true, hash: true },
      })),
    );
  }
  const hashList = [...new Set(ownHashes.map((h) => h.hash).filter((h) => typeof h === 'string' && h.length > 0))];
  const holders = new Map<string, Array<{ captureId: string; outletCode: string; windowKey: string }>>();
  for (const part of chunks(hashList)) {
    const rows = await prisma.visibilityImageHash.findMany({
      where: { clientId, hash: { in: part } },
      select: { hash: true, captureId: true, capture: { select: { outletCode: true, windowKey: true } } },
    });
    for (const r of rows) {
      const list = holders.get(r.hash) ?? [];
      list.push({ captureId: r.captureId, outletCode: r.capture?.outletCode ?? '', windowKey: r.capture?.windowKey ?? '' });
      holders.set(r.hash, list);
    }
  }
  const dupOf = new Map<string, Map<string, { outletCode: string; windowKey: string }>>();
  for (const h of ownHashes) {
    for (const other of holders.get(h.hash) ?? []) {
      if (other.captureId === h.captureId) continue;
      const m = dupOf.get(h.captureId) ?? new Map();
      m.set(other.captureId, { outletCode: other.outletCode, windowKey: other.windowKey });
      dupOf.set(h.captureId, m);
    }
  }

  // (b) outside the fence — the reviewer's per-photo policy, resolved in bulk.
  const schemas = await loadFormSchemas(prisma, clientId, [...new Set(captures.map((c) => c.formVersion))]);
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { features: true } });
  const outletMaster = (client?.features as Record<string, unknown> | null)?.outletMasterGeo === true;
  const boardRef = outletMaster
    ? new Map<string, { lat: number; lng: number }>()
    : await loadBoardPhotoRefs(prisma, clientId, [...new Set(captures.map((c) => c.outlet?.partnerId).filter((p): p is string => !!p))]);

  const rows: FlaggedCapture[] = [];
  let duplicate = 0;
  let outsideFence = 0;
  for (const c of captures) {
    const policy: PhotoFencePolicy = outletMaster
      ? outletMasterFencePolicy(c.outlet ?? {})
      : {
          reference: (c.outlet?.partnerId && boardRef.get(c.outlet.partnerId)) || null,
          radiusMeters: config.geoFence.radiusMeters,
          accuracyBuffer: false,
        };
    const outsidePhotos = outsideFenceFields(c.formValues, schemas.get(c.formVersion) ?? null, policy);
    const isOutside = c.geoFenceOk === false || outsidePhotos.length > 0;
    const dups = [...(dupOf.get(c.id)?.values() ?? [])];
    const reasons: FlagReason[] = [];
    if (dups.length) { reasons.push('DUPLICATE_PHOTO'); duplicate += 1; }
    if (isOutside) { reasons.push('OUTSIDE_FENCE'); outsideFence += 1; }
    if (!reasons.length) continue;
    let closed = false;
    try { closed = isWindowClosed(c.windowKey, now, freq); } catch { closed = true; }
    rows.push({
      captureId: c.id,
      outletId: c.outletId,
      outletCode: c.outletCode,
      outletName: c.outletName,
      windowKey: c.windowKey,
      status: plainStatusOf(c.status, closed),
      reasons,
      duplicateOf: dups,
      outsidePhotos,
    });
  }
  rows.sort((a, b) => a.outletCode.localeCompare(b.outletCode) || a.windowKey.localeCompare(b.windowKey));
  const submitted = captures.length;
  return {
    month,
    submitted,
    flagged: rows.length,
    duplicate,
    outsideFence,
    flagRatePct: submitted > 0 ? Math.round((rows.length / submitted) * 1000) / 10 : null,
    rows,
  };
}

/** formVersion → schema (the version snapshot; the current form as the fallback, as the reviewer does). */
async function loadFormSchemas(
  prisma: Pick<MetricsPrisma, 'visibilityFormVersion' | 'visibilityForm'>,
  clientId: string,
  versions: number[],
): Promise<Map<number, VisibilityFormSchema | null>> {
  const out = new Map<number, VisibilityFormSchema | null>();
  if (!versions.length) return out;
  const snaps = await prisma.visibilityFormVersion.findMany({
    where: { clientId, version: { in: versions } },
    select: { version: true, formSchema: true },
  });
  for (const s of snaps) out.set(s.version, s.formSchema as unknown as VisibilityFormSchema);
  if (versions.some((v) => !out.has(v))) {
    const current = await prisma.visibilityForm.findUnique({ where: { clientId }, select: { formSchema: true } });
    const schema = current ? (current.formSchema as unknown as VisibilityFormSchema) : null;
    for (const v of versions) if (!out.has(v)) out.set(v, schema);
  }
  return out;
}

/** partnerId → latest APPROVED KYC board-photo geo (the non-outlet-master fence reference). */
async function loadBoardPhotoRefs(
  prisma: Pick<MetricsPrisma, 'kycSubmission'>,
  clientId: string,
  partnerIds: string[],
): Promise<Map<string, { lat: number; lng: number }>> {
  const out = new Map<string, { lat: number; lng: number }>();
  for (const part of chunks(partnerIds)) {
    const subs = await prisma.kycSubmission.findMany({
      where: {
        partnerId: { in: part },
        partner: { clientId },
        status: 'APPROVED',
        boardPhotoLat: { not: null },
        boardPhotoLng: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { partnerId: true, boardPhotoLat: true, boardPhotoLng: true },
    });
    for (const s of subs) {
      if (!s.partnerId || out.has(s.partnerId) || s.boardPhotoLat == null || s.boardPhotoLng == null) continue;
      out.set(s.partnerId, { lat: Number(s.boardPhotoLat), lng: Number(s.boardPhotoLng) });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review ACTIONS in a time window (Daily Ops Digest)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewActionCounts {
  /** Review decisions made in the window (one per capture per decision instant). */
  actions: number;
  /** Decisions that only approved photos. */
  approved: number;
  /** Decisions that rejected at least one photo (a re-take request or a whole-capture rejection). */
  rejected: number;
  /** Photos approved / rejected by those decisions. */
  photosApproved: number;
  photosRejected: number;
}

export interface ReviewTraceCapture {
  id: string;
  status: VisibilityCaptureStatus | string;
  reviewedAt: Date | null;
  photoReviews: unknown;
  submissions?: Array<{ photoReviews: unknown }>;
}

/**
 * Count review ACTIONS whose instant falls in [startMs, endMs). Reconstructed from the review trail that
 * survives a resubmission: the live capture's photoReviews AND every submission version's photoReviews snapshot
 * (persistReview mirrors the map onto the version it reviewed, so a rejection followed by a same-day resubmit is
 * still found on the old version). One photo decision = (captureId, fieldId, reviewedAt), deduped across versions
 * (an approved photo carried into the next version keeps its reviewedAt). One ACTION = (captureId, reviewedAt):
 * an approve-all / reject-all writes every photo with the same instant. A capture with NO photo decisions (legacy
 * single-unit) falls back to its whole-capture reviewedAt + current status.
 *
 * TODO(visibility-review-events): when the append-only review-events table lands (parallel Track — review history),
 * count its rows in the window instead of reconstructing from JSON snapshots; keep this as the fallback for
 * pre-table history.
 */
export function countReviewActions(captures: ReviewTraceCapture[], startMs: number, endMs: number): ReviewActionCounts {
  const res: ReviewActionCounts = { actions: 0, approved: 0, rejected: 0, photosApproved: 0, photosRejected: 0 };
  const inWin = (ms: number) => Number.isFinite(ms) && ms >= startMs && ms < endMs;
  for (const c of captures) {
    const decisions = new Map<string, 'APPROVED' | 'REJECTED'>(); // `${fieldId}|${iso}` → status
    let anyDecision = false;
    for (const snap of [c.photoReviews, ...(c.submissions ?? []).map((s) => s.photoReviews)]) {
      for (const [fieldId, r] of Object.entries(readPhotoReviews(snap))) {
        anyDecision = true;
        const ms = Date.parse(r.reviewedAt);
        if (!inWin(ms)) continue;
        decisions.set(`${fieldId}|${new Date(ms).toISOString()}`, r.status);
      }
    }
    if (!anyDecision) {
      // Legacy / no-photo capture: the whole-capture decision only.
      const ms = c.reviewedAt ? c.reviewedAt.getTime() : NaN;
      if (inWin(ms) && (c.status === 'APPROVED' || c.status === 'REJECTED' || c.status === 'CHANGES_REQUESTED')) {
        res.actions += 1;
        if (c.status === 'APPROVED') res.approved += 1;
        else res.rejected += 1;
      }
      continue;
    }
    const byInstant = new Map<string, { approved: number; rejected: number }>();
    for (const [k, status] of decisions) {
      const iso = k.slice(k.indexOf('|') + 1);
      const agg = byInstant.get(iso) ?? { approved: 0, rejected: 0 };
      if (status === 'APPROVED') { agg.approved += 1; res.photosApproved += 1; } else { agg.rejected += 1; res.photosRejected += 1; }
      byInstant.set(iso, agg);
    }
    for (const agg of byInstant.values()) {
      res.actions += 1;
      if (agg.rejected > 0) res.rejected += 1;
      else res.approved += 1;
    }
  }
  return res;
}

/**
 * Load the captures that could carry a review action in [start, end) and count them. A review always updates the
 * capture row, so `updatedAt >= start` is a safe superset (a later resubmit also bumps it — still a superset).
 */
export async function loadReviewActions(
  prisma: Pick<MetricsPrisma, 'visibilityCapture'>,
  clientId: string,
  start: Date,
  end: Date,
): Promise<ReviewActionCounts> {
  const rows = await prisma.visibilityCapture.findMany({
    where: { clientId, updatedAt: { gte: start } },
    select: { id: true, status: true, reviewedAt: true, photoReviews: true, submissions: { select: { photoReviews: true } } },
  });
  return countReviewActions(rows as ReviewTraceCapture[], start.getTime(), end.getTime());
}
