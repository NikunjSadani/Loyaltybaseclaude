/**
 * visibility-metrics.ts — THE shared definitions behind every Visibility (POSM) number: the report screen,
 * the admin "Pending Visibility Approvals" tile, the Operations "Visibility Program Funnel" and the Daily Ops
 * Digest. VISIBILITY-POSM-DESIGN.md §17 is the written contract; this file is its code.
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
import { istDateKey, istMonthKey } from '../common/ist-date';
import { isWindowClosed, windowsForMonth } from './visibility-window.helper';
import { visibilityUniverseWhere, VisibilityProgramScopeLike } from './visibility-scope.helper';
import {
  MEDIA_FIELD_TYPES,
  readMediaValue,
  readPhotoReviews,
  VisibilityFormSchema,
} from './visibility-types';
import { classifyPhotoFence, outletMasterFencePolicy, PhotoFencePolicy } from './geo-fence.helper';
import { VISIBILITY_WORDS } from './visibility-report-labels';

// ─────────────────────────────────────────────────────────────────────────────
// Plain statuses (owner decision 2026-11-20)
// ─────────────────────────────────────────────────────────────────────────────

export const PLAIN_STATUSES = [
  'WAITING',
  'APPROVED',
  'NEEDS_RETAKE',
  'REJECTED',
  'CLOSED_NOT_APPROVED',
  'NOT_CAPTURED',
  'MISSED',
  'NOT_TRACKED',
  'PART_OLD_APP',
] as const;
export type PlainStatus = (typeof PLAIN_STATUSES)[number];

/** The words shown to people — from the ONE API word list (visibility-report-labels VISIBILITY_WORDS). */
export const PLAIN_STATUS_LABEL: Record<PlainStatus, string> = {
  WAITING: VISIBILITY_WORDS.WAITING,
  APPROVED: VISIBILITY_WORDS.APPROVED,
  NEEDS_RETAKE: VISIBILITY_WORDS.NEEDS_RETAKE,
  REJECTED: VISIBILITY_WORDS.REJECTED,
  CLOSED_NOT_APPROVED: VISIBILITY_WORDS.CLOSED_NOT_APPROVED,
  NOT_CAPTURED: VISIBILITY_WORDS.NOT_CAPTURED,
  MISSED: VISIBILITY_WORDS.MISSED,
  NOT_TRACKED: VISIBILITY_WORDS.NOT_TRACKED,
  PART_OLD_APP: VISIBILITY_WORDS.PART_OLD_APP,
};

/**
 * One outlet-window's plain status. A capture row wins:
 *   SUBMITTED → Waiting for review (whatever the window — Gifsy can still review it);
 *   CHANGES_REQUESTED / REJECTED → "Needs re-take" / "Rejected" ONLY while the window is open (the rep can still
 *   resubmit); once the window has closed a resubmit is refused (visibility-capture.service resubmitCapture), so
 *   it is final: "Not approved — window closed" — never counted as waiting on reps.
 * No capture: "Not captured yet" while the window is open (or not started), "Missed" ONLY once the window has
 * closed — except (visibility-portal-go-live): in an IMPORTED month / a window that ended before the portal went
 * live (`importedMonth`), where the old app kept only approved visits, a missing capture is "Not tracked"; and in a
 * closed window that was PARTLY on the old app (`partOldApp`), it is "No approved record — part of this window was on
 * the old app" — never "Missed".
 */
export function plainStatusOf(
  status: VisibilityCaptureStatus | null | undefined,
  windowClosed: boolean,
  importedMonth = false,
  partOldApp = false,
): PlainStatus {
  switch (status) {
    case 'SUBMITTED':
      return 'WAITING';
    case 'APPROVED':
      return 'APPROVED';
    case 'CHANGES_REQUESTED':
      return windowClosed ? 'CLOSED_NOT_APPROVED' : 'NEEDS_RETAKE';
    case 'REJECTED':
      return windowClosed ? 'CLOSED_NOT_APPROVED' : 'REJECTED';
    default:
      if (importedMonth) return 'NOT_TRACKED';
      if (windowClosed && partOldApp) return 'PART_OLD_APP';
      return windowClosed ? 'MISSED' : 'NOT_CAPTURED';
  }
}

/** isWindowClosed that never throws (a key the current frequency does not have → treated as closed). */
export function windowClosedSafe(windowKey: string, now: Date, freq: number): boolean {
  try {
    return isWindowClosed(windowKey, now, freq);
  } catch {
    return true;
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
  /** This month's captures "Waiting for review". */
  waiting: number;
  /** CHANGES_REQUESTED in a window that is still OPEN — the rep can re-take. */
  needsRetake: number;
  approved: number;
  /** Whole-capture REJECTED in a window that is still OPEN — the rep can capture again. */
  rejected: number;
  /** CHANGES_REQUESTED / REJECTED in a CLOSED window — final, no resubmit possible ("Not approved — window closed"). */
  closedNotApproved: number;
  /** needsRetake + rejected — the only captures still waiting on reps. */
  waitingOnReps: number;
  /**
   * Gifsy's WHOLE review queue: every in-scope capture still "Waiting for review", ANY month (a capture submitted
   * last month and not reviewed yet is still work to do). Never limited to `month`.
   */
  waitingAllMonths: number;
  /** Of waitingAllMonths: captures from months BEFORE `month`. */
  waitingEarlierMonths: number;
}

type StatusWindowRow = { status: VisibilityCaptureStatus | string; windowKey?: string; _count: { _all: number } };

/**
 * Fold a (status, windowKey) groupBy of ONE month into the plain buckets. `closedOf(windowKey)` says whether the
 * window has closed (rows without a windowKey are treated as open). `waitingRows` = the all-month SUBMITTED groupBy
 * by windowKey (defaults to this month's waiting only). Pure.
 */
export function foldStatusCounts(
  month: string,
  rows: StatusWindowRow[],
  closedOf: (windowKey: string) => boolean = () => false,
  waitingRows?: Array<{ windowKey: string; _count: { _all: number } }>,
): MonthStatusCounts {
  const res: MonthStatusCounts = {
    month, submitted: 0, waiting: 0, needsRetake: 0, approved: 0, rejected: 0, closedNotApproved: 0,
    waitingOnReps: 0, waitingAllMonths: 0, waitingEarlierMonths: 0,
  };
  for (const r of rows) {
    const n = r._count._all;
    const closed = r.windowKey ? closedOf(r.windowKey) : false;
    switch (r.status) {
      case 'SUBMITTED': res.waiting += n; break;
      case 'APPROVED': res.approved += n; break;
      case 'CHANGES_REQUESTED': if (closed) res.closedNotApproved += n; else res.needsRetake += n; break;
      case 'REJECTED': if (closed) res.closedNotApproved += n; else res.rejected += n; break;
      default: continue;
    }
    res.submitted += n;
  }
  res.waitingOnReps = res.needsRetake + res.rejected;
  if (waitingRows) {
    for (const r of waitingRows) {
      res.waitingAllMonths += r._count._all;
      if (r.windowKey.slice(0, 7) < month) res.waitingEarlierMonths += r._count._all;
    }
  } else {
    res.waitingAllMonths = res.waiting;
  }
  return res;
}

/**
 * Status counts of a month's captures for IN-SCOPE outlets, plus Gifsy's whole "Waiting for review" queue across
 * every month. An empty outletScope → all zeros (no query). `extraOutlet` narrows further (e.g. the admin
 * dashboard's program filter) — ANDed with the in-scope rule. `now` / `freq` decide which windows have closed.
 */
export async function loadMonthStatusCounts(
  prisma: Pick<MetricsPrisma, 'visibilityCapture'>,
  clientId: string,
  config: ScopeConfig,
  month: string,
  opts: { now: Date; freq: number; extraOutlet?: Prisma.OutletWhereInput },
): Promise<MonthStatusCounts> {
  if (!config.outletScope?.length) return foldStatusCounts(month, [], undefined, []);
  const universe = visibilityUniverseWhere(clientId, config);
  const outlet = opts.extraOutlet ? { AND: [universe, opts.extraOutlet] } : universe;
  const rows = await prisma.visibilityCapture.groupBy({
    by: ['status', 'windowKey'],
    where: { ...monthCaptureWhere(clientId, month), outlet },
    _count: { _all: true },
  });
  // Gifsy's queue is month-independent: every capture still waiting, whichever month it belongs to.
  const waitingRows = await prisma.visibilityCapture.groupBy({
    by: ['windowKey'],
    where: { clientId, status: 'SUBMITTED', outlet },
    _count: { _all: true },
  });
  return foldStatusCounts(
    month,
    rows as unknown as StatusWindowRow[],
    (wk) => windowClosedSafe(wk, opts.now, opts.freq),
    waitingRows as unknown as Array<{ windowKey: string; _count: { _all: number } }>,
  );
}

/**
 * Approval rate = Approved ÷ every DECIDED capture (Approved + Needs re-take + Rejected + Not approved — window
 * closed) — the share of this month's captures that a reviewer has decided on and that ended up approved. Captures
 * still "Waiting for review" are NOT in the denominator (no decision yet). null when nothing has been decided
 * (never a fabricated 0 / 100).
 */
export function approvalRatePct(
  c: Pick<MonthStatusCounts, 'approved' | 'needsRetake' | 'rejected'> & { closedNotApproved?: number },
): number | null {
  const reviewed = c.approved + c.needsRetake + c.rejected + (c.closedNotApproved ?? 0);
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
  /** Other captures sharing a photo with this one (outlet code + window) — at most DUPLICATE_LIST_CAP listed. */
  duplicateOf: Array<{ outletCode: string; windowKey: string }>;
  /** How many other captures share a photo with this one (the full figure; duplicateOf may list fewer). */
  duplicateCount: number;
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

/** Max other captures listed per flagged capture (the count is always complete — duplicateCount). */
export const DUPLICATE_LIST_CAP = 10;

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
  // hash → the DISTINCT captures holding it (a capture with the same photo in two fields counts once).
  const holders = new Map<string, Map<string, { outletCode: string; windowKey: string }>>();
  for (const part of chunks(hashList)) {
    const rows = await prisma.visibilityImageHash.findMany({
      where: { clientId, hash: { in: part } },
      select: { hash: true, captureId: true, capture: { select: { outletCode: true, windowKey: true } } },
    });
    for (const r of rows) {
      const m = holders.get(r.hash) ?? new Map<string, { outletCode: string; windowKey: string }>();
      m.set(r.captureId, { outletCode: r.capture?.outletCode ?? '', windowKey: r.capture?.windowKey ?? '' });
      holders.set(r.hash, m);
    }
  }
  // Linear in the number of hash rows: each capture lists at most DUPLICATE_LIST_CAP of the others sharing a photo
  // (a hash shared by N captures would otherwise build N×N entries), and `duplicateCount` keeps the full figure.
  const dupOf = new Map<string, Map<string, { outletCode: string; windowKey: string }>>();
  const dupCount = new Map<string, number>();
  for (const h of ownHashes) {
    const list = holders.get(h.hash);
    if (!list) continue;
    const others = list.size - (list.has(h.captureId) ? 1 : 0);
    if (others <= 0) continue;
    dupCount.set(h.captureId, Math.max(dupCount.get(h.captureId) ?? 0, others));
    const m = dupOf.get(h.captureId) ?? new Map<string, { outletCode: string; windowKey: string }>();
    for (const [otherId, other] of list) {
      if (m.size >= DUPLICATE_LIST_CAP) break;
      if (otherId === h.captureId) continue;
      m.set(otherId, other);
    }
    dupOf.set(h.captureId, m);
  }
  // A capture with several shared hashes: the distinct listed others may exceed the per-hash max.
  for (const [id, m] of dupOf) dupCount.set(id, Math.max(dupCount.get(id) ?? 0, m.size));

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
    rows.push({
      captureId: c.id,
      outletId: c.outletId,
      outletCode: c.outletCode,
      outletName: c.outletName,
      windowKey: c.windowKey,
      status: plainStatusOf(c.status, windowClosedSafe(c.windowKey, now, freq)),
      reasons,
      duplicateOf: dups,
      duplicateCount: dups.length ? dupCount.get(c.id) ?? dups.length : 0,
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
  /**
   * Reviews done in the window: ONE per capture per IST day — that day's FINAL outcome (several clicks on the same
   * capture the same day, e.g. approve photo 1 then reject photo 2, count once).
   */
  actions: number;
  /** Of `actions`: the day ended with every photo decided that day approved. */
  approved: number;
  /** Of `actions`: the day ended with at least one photo sent back (re-take) or the whole capture rejected. */
  rejected: number;
  /** Photos whose final decision that day was approved / rejected. */
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
 * Count reviews done in [startMs, endMs) — ONE per capture per IST day, by that day's FINAL outcome. Reconstructed
 * from the review trail that survives a resubmission: the live capture's photoReviews AND every submission version's
 * photoReviews snapshot (persistReview mirrors the map onto the version it reviewed, so a rejection followed by a
 * same-day resubmit is still found on the old version). One photo decision = (captureId, fieldId, reviewedAt),
 * deduped across versions (an approved photo carried into the next version keeps its reviewedAt). Per capture and
 * IST day, each photo's LAST decision that day wins; the day's outcome is "sent back / rejected" when any of those
 * is REJECTED, else "approved". A capture with NO photo decisions (legacy single-unit) falls back to its
 * whole-capture reviewedAt + current status.
 *
 * TODO(visibility-review-events): when the append-only review-events table lands (parallel Track — review history),
 * count its rows in the window instead of reconstructing from JSON snapshots; keep this as the fallback for
 * pre-table history.
 */
export function countReviewActions(captures: ReviewTraceCapture[], startMs: number, endMs: number): ReviewActionCounts {
  const res: ReviewActionCounts = { actions: 0, approved: 0, rejected: 0, photosApproved: 0, photosRejected: 0 };
  const inWin = (ms: number) => Number.isFinite(ms) && ms >= startMs && ms < endMs;
  for (const c of captures) {
    // IST day → fieldId → that photo's LAST decision that day.
    const byDay = new Map<string, Map<string, { ms: number; status: 'APPROVED' | 'REJECTED' }>>();
    let anyDecision = false;
    for (const snap of [c.photoReviews, ...(c.submissions ?? []).map((s) => s.photoReviews)]) {
      for (const [fieldId, r] of Object.entries(readPhotoReviews(snap))) {
        anyDecision = true;
        const ms = Date.parse(r.reviewedAt);
        if (!inWin(ms)) continue;
        const day = istDateKey(new Date(ms));
        const fields = byDay.get(day) ?? new Map<string, { ms: number; status: 'APPROVED' | 'REJECTED' }>();
        const prev = fields.get(fieldId);
        if (!prev || ms > prev.ms) fields.set(fieldId, { ms, status: r.status });
        byDay.set(day, fields);
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
    for (const fields of byDay.values()) {
      let rejected = 0;
      for (const d of fields.values()) {
        if (d.status === 'APPROVED') res.photosApproved += 1;
        else { res.photosRejected += 1; rejected += 1; }
      }
      res.actions += 1;
      if (rejected > 0) res.rejected += 1;
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
