/**
 * Visibility (POSM) report — kind `visibility-captures`, served by `GET /v1/visibility/report/export[?month=YYYY-MM]
 * [&windowKey=YYYY-MM-Pn]` (Gifsy + CLIENT_ADMIN). Redesigned 2026-11-20 (owner-approved, PLATFORM-WIDE): a MONTHLY,
 * plain-English workbook a client admin can read without help.
 *
 * Scope: one IST month (default = the request's IST month) or one window of it (old `windowKey` param, kept). Imported
 * old-app history is included in its month (Source = "Imported (old app)").
 *
 * Sheets (streamed in this order — the writer holds one sheet at a time):
 *   1. Visibility      — one row per capture (outlet × window): outlet, status in words, rep + manager, dates,
 *                        location check, reviewer, overall remark, then per CAMERA field (header = the field's LABEL)
 *                        a clickable photo link + decision + reason + reviewer + time + location.
 *   2. Review history  — one row per submitted version per photo (VisibilityCaptureSubmission + its review snapshot).
 *   3. Not captured    — in-scope outlets (the SAME rule as the report tiles) with no capture for a window of the scope:
 *                        "Not captured yet" while the window is open (IST), else "Missed".
 *   4. About           — what each status / column means, scope, generated-at, counts (= the Visibility sheet).
 *
 * Photo links are ABSOLUTE on the tenant's primary portal host (`pickTenantDomain` → `tenantPortalLink`, the ticket
 * e-mail rule: never a staging host in prod; fallback `<slug>.gifsy.in`) to the authenticated viewer page
 * `/visibility/photo?key=…` (platform app/visibility/photo) — a page navigation, so the normal sign-in / session renewal
 * applies; the image itself is still served by the role-gated media endpoint.
 *
 * Paging: captures ≤ 2,000 per page, keyset on (windowKey, outletCode, id); per page ONE query each for duplicate
 * hashes, reference geo and reviewer names (cached across pages). The tenant's sales directory (names, designations,
 * reporting chain) is read ONCE. No N+1.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { istMonthKey } from '../../../common/ist-date';
import type { XlsxCell } from '../../../common/xlsx-stream';
import { TenantService } from '../../../tenant/tenant.service';
import { TenantSettingsService } from '../../../tenant/tenant-settings.service';
import { pickTenantDomain, tenantPortalLink } from '../../../tickets/ticket-link';
import { firstActiveApproverId } from '../../../sales/sales-hierarchy-access.helper';
import {
  evaluateVisibleWhen,
  outletContextValues,
  readMediaValue,
  readPhotoReviews,
  type FormField,
  type PhotoReview,
} from '../../../visibility/visibility-form.helper';
import {
  classifyPhotoFence,
  evaluatePhotoFence,
  haversineMeters,
  outletMasterFencePolicy,
  type PhotoFenceStatus,
} from '../../../visibility/geo-fence.helper';
import { windowsForMonth } from '../../../visibility/visibility-window.helper';
import { visibilityReportScopeError, windowPhase, windowRangeUtc } from '../../../visibility/visibility-report-scope';
import { visibilityAddressableOutletWhere } from '../../../visibility/visibility-report.service';
import {
  VISIBILITY_STATUS_ORDER,
  VISIBILITY_STATUS_WORDS,
  istHumanDateTime,
  locationWords,
  monthLabel,
  reasonCodeLabel,
  reasonText,
  visibilityStatusWords,
} from '../../../visibility/visibility-report-labels';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import { BATCH1_PAGE_SIZE, optionalString, rawObject, utcDateKey } from './common';

export interface VisibilityCapturesParams {
  /** `YYYY-MM` (IST). Absent (and no windowKey) = the request's IST month. */
  month?: string;
  /** One window `YYYY-MM-Pn` of a month (backward-compatible param). */
  windowKey?: string;
  /** Server-set origin (only used for photo links in a LOCAL environment). */
  requestOrigin?: string;
}

/** The fixed columns of the "Visibility" sheet (per-photo groups follow). */
export const VISIBILITY_REPORT_BASE_HEADERS = [
  'Outlet Code', 'Outlet Name', 'Outlet Type', 'Programme', 'Sub-programme', 'City', 'State', 'Window', 'Source',
  'Status', 'Captured by', 'Rep code', 'Rep designation', 'Manager', 'Captured on', 'Submitted on', 'Re-takes',
  'Location check', 'Duplicate photo', 'Reviewed by', 'Reviewed on', 'Overall remark',
] as const;

/** Per CAMERA field: `<Label> – <suffix>`. */
export const VISIBILITY_PHOTO_SUFFIXES = ['Photo', 'Decision', 'Reason', 'Reviewed by', 'Reviewed on', 'Location'] as const;

export const VISIBILITY_HISTORY_HEADERS = [
  'Outlet Code', 'Outlet Name', 'Window', 'Version', 'Submitted on', 'Photo', 'Photo link', 'Decision', 'Reason',
  'Reviewed by', 'Reviewed on',
] as const;

export const VISIBILITY_NOT_CAPTURED_HEADERS = [
  'Outlet Code', 'Outlet Name', 'Outlet Type', 'Programme', 'Sub-programme', 'City', 'State', 'Assigned rep',
  'Rep code', 'Manager', 'Window', 'Status',
] as const;

export const SOURCE_IMPORTED = 'Imported (old app)';
export const SOURCE_PORTAL = 'Portal app';

/** Imported old-app photos were re-hosted under this key segment (BAJAJ-PROD-OUTLET-IMPORT §8). */
const IMPORTED_KEY_MARKER = '/vendor-import/';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const WINDOW_RE = /^(\d{4}-(?:0[1-9]|1[0-2]))-P[1-4]$/;

/**
 * Excel's hyperlink limit is ~65,530 per worksheet; beyond this many a sheet gets the URL as plain text instead (and the
 * About sheet says so). Mutable object so a spec can lower it.
 */
export const VISIBILITY_LINK_LIMIT = { perSheet: 60_000 };

export const NOT_TRACKED_MESSAGE = "Not tracked for imported months — the old app's records only include approved visits";

/** The in-app path of the photo viewer page for a stored object key. */
export function visibilityPhotoPath(key: string): string {
  return `/visibility/photo?key=${encodeURIComponent(key)}`;
}

type Schema = { fields?: FormField[] } | undefined;
type PhotoColumn = { fieldId: string; label: string };

const cameraFields = (s: Schema): FormField[] =>
  (s?.fields ?? [])
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f && f.type === 'CAMERA' && typeof f.id === 'string')
    .sort((a, b) => (a.f.order ?? a.i) - (b.f.order ?? b.i) || a.i - b.i)
    .map(({ f }) => f);

/**
 * The per-photo column groups: the union of CAMERA fields across the form versions used by the scope, ordered by the
 * CURRENT form (fields no longer on it follow, newest version first); header = the field's label (current form's
 * wording, else the newest version's). Repeated labels get " (2)", " (3)" so every header is unique. No captures →
 * the current form's photos.
 */
export function planPhotoColumns(current: Schema, usedNewestFirst: Schema[]): PhotoColumn[] {
  const used = new Map<string, FormField>();
  for (const s of usedNewestFirst) for (const f of cameraFields(s)) if (!used.has(f.id)) used.set(f.id, f);
  const order: FormField[] = [];
  const seen = new Set<string>();
  const currentFields = cameraFields(current);
  for (const f of currentFields) {
    if (usedNewestFirst.length === 0 || used.has(f.id)) {
      order.push(f);
      seen.add(f.id);
    }
  }
  for (const [id, f] of used) if (!seen.has(id)) order.push(f);
  const labelOf = new Map(currentFields.map((f) => [f.id, f.label]));
  const counts = new Map<string, number>();
  return order.map((f) => {
    const base = String(labelOf.get(f.id) ?? f.label ?? '').trim() || 'Photo';
    const n = (counts.get(base.toLowerCase()) ?? 0) + 1;
    counts.set(base.toLowerCase(), n);
    return { fieldId: f.id, label: n === 1 ? base : `${base} (${n})` };
  });
}

/** Ids (of the given page) whose photo hash also appears on a DIFFERENT capture of the tenant. */
async function duplicateCaptureIds(ctx: ExportRunContext, captureIds: string[]): Promise<Set<string>> {
  const dup = new Set<string>();
  if (captureIds.length === 0) return dup;
  const own = await ctx.prisma.visibilityImageHash.findMany({
    where: { clientId: ctx.clientId, captureId: { in: captureIds } },
    select: { hash: true },
  });
  const hashes = [...new Set(own.map((h) => h.hash))];
  if (hashes.length === 0) return dup;
  const sharing = await ctx.prisma.visibilityImageHash.findMany({
    where: { clientId: ctx.clientId, hash: { in: hashes } },
    select: { hash: true, captureId: true },
  });
  const byHash = new Map<string, Set<string>>();
  for (const h of sharing) byHash.set(h.hash, (byHash.get(h.hash) ?? new Set<string>()).add(h.captureId));
  const inPage = new Set(captureIds);
  for (const ids of byHash.values()) if (ids.size > 1) for (const id of ids) if (inPage.has(id)) dup.add(id);
  return dup;
}

/**
 * Reference geo per partner — the latest APPROVED KYC board-photo geo (the SAME source the capture-time fence uses on
 * a non-outlet-master tenant). Partners with none are absent (→ photos read "Unverifiable").
 */
async function referenceGeoByPartnerId(ctx: ExportRunContext, partnerIds: string[]): Promise<Map<string, { lat: number; lng: number }>> {
  const map = new Map<string, { lat: number; lng: number }>();
  const ids = [...new Set(partnerIds.filter((p): p is string => !!p))];
  if (ids.length === 0) return map;
  const partners = await ctx.prisma.channelPartner.findMany({
    where: { id: { in: ids }, clientId: ctx.clientId },
    select: {
      id: true,
      kycSubmissions: {
        where: { status: 'APPROVED', boardPhotoLat: { not: null }, boardPhotoLng: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { boardPhotoLat: true, boardPhotoLng: true },
      },
    },
  });
  for (const p of partners) {
    const sub = p.kycSubmissions?.[0];
    if (sub && sub.boardPhotoLat != null && sub.boardPhotoLng != null) {
      map.set(p.id, { lat: Number(sub.boardPhotoLat), lng: Number(sub.boardPhotoLng) });
    }
  }
  return map;
}

/** The tenant's sales people, read once: names, codes, designations and the reporting chain. */
async function loadSalesDirectory(ctx: ExportRunContext) {
  const rows = await ctx.prisma.salesUser.findMany({
    where: { clientId: ctx.clientId },
    select: {
      id: true,
      reportingToId: true,
      isActive: true,
      deletedAt: true,
      employeeCode: true,
      user: { select: { name: true } },
      hierarchyLevel: { select: { name: true } },
    },
  });
  const list = Array.isArray(rows) ? rows : [];
  const byId = new Map(list.map((r) => [r.id, r]));
  const nodes = list.map((r) => ({ id: r.id, reportingToId: r.reportingToId, isActive: r.isActive, deletedAt: r.deletedAt }));
  const managerCache = new Map<string, string>();
  return {
    person(id: string | null | undefined) {
      const r = id ? byId.get(id) : undefined;
      return r
        ? { name: r.user?.name ?? '', code: r.employeeCode ?? '', designation: r.hierarchyLevel?.name ?? '' }
        : { name: '', code: '', designation: '' };
    },
    /** "Name (Designation)" of the first ACTIVE manager up the chain (vacant levels skipped), or ''. */
    manager(id: string | null | undefined): string {
      if (!id) return '';
      const hit = managerCache.get(id);
      if (hit !== undefined) return hit;
      const mid = firstActiveApproverId(id, nodes);
      const m = mid ? byId.get(mid) : undefined;
      const name = m?.user?.name ?? '';
      const text = m ? (m.hierarchyLevel?.name ? `${name} (${m.hierarchyLevel.name})` : name) : '';
      managerCache.set(id, text);
      return text;
    },
  };
}

/** User id → name, batched per page and cached across the export. */
function userNameCache(ctx: ExportRunContext) {
  const cache = new Map<string, string>();
  return {
    async load(ids: Iterable<string | null | undefined>) {
      const missing = [...new Set([...ids].filter((i): i is string => !!i && !cache.has(i)))];
      if (missing.length === 0) return;
      const users = await ctx.prisma.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } });
      for (const id of missing) cache.set(id, '');
      for (const u of users) cache.set(u.id, u.name ?? '');
    },
    name: (id: string | null | undefined) => (id ? cache.get(id) ?? '' : ''),
  };
}

const asValues = (v: Prisma.JsonValue | null | undefined): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function isImported(values: Record<string, unknown>): boolean {
  for (const v of Object.values(values)) {
    const { key } = readMediaValue(v);
    if (key && key.includes(IMPORTED_KEY_MARKER)) return true;
  }
  return false;
}

/** The review with the latest reviewedAt (ties: the later entry), or null. */
function latestReview(reviews: Record<string, PhotoReview>): PhotoReview | null {
  let best: PhotoReview | null = null;
  let bestT = -Infinity;
  for (const r of Object.values(reviews)) {
    const t = Date.parse(r.reviewedAt);
    const tt = Number.isFinite(t) ? t : -Infinity;
    if (!best || tt >= bestT) {
      best = r;
      bestT = tt;
    }
  }
  return best;
}

const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function decisionWord(status: 'APPROVED' | 'REJECTED'): string {
  return status === 'APPROVED' ? 'Approved' : 'Rejected';
}

/**
 * The scope's month + the capture windows to read + the windows an outlet is expected to cover (Not-captured sheet).
 * A month reads every possible window key P1..P4 (imported months and frequency changes never drop a capture).
 */
function resolveScope(params: VisibilityCapturesParams, now: Date) {
  if (params.windowKey) return { month: params.windowKey.slice(0, 7), readWindows: [params.windowKey] };
  const month = params.month ?? istMonthKey(now);
  return { month, readWindows: [1, 2, 3, 4].map((n) => `${month}-P${n}`) };
}

/**
 * The windows an in-scope outlet was expected to cover in a PORTAL month: the tenant's frequency (today's — the
 * frequency history is not stored) plus any other window that actually has portal captures that month (an older
 * frequency). One window asked for -> just that window.
 */
function expectedWindowsFor(params: VisibilityCapturesParams, month: string, freq: number, portalWindowsSeen: Set<string>): string[] {
  if (params.windowKey) return [params.windowKey];
  let byFreq: string[];
  try {
    byFreq = windowsForMonth(month, freq);
  } catch {
    byFreq = [`${month}-P1`];
  }
  return [...new Set([...byFreq, ...portalWindowsSeen])].sort();
}

async function runVisibilityCaptures(
  ctx: ExportRunContext,
  params: VisibilityCapturesParams,
  out: Parameters<ExportKindDef<VisibilityCapturesParams>['run']>[2],
): Promise<{ rowCount: number }> {
  const { prisma, clientId } = ctx;
  const tenant = ctx.moduleRef.get(TenantService, { strict: false });
  if (!(await tenant.resolveVisibilityEnabled(clientId))) {
    throw new ForbiddenException('Visibility is not enabled for this tenant.');
  }
  const settings = ctx.moduleRef.get(TenantSettingsService, { strict: false });
  const cfg = (await settings.getEffectiveSettings(clientId)).visibilityConfig;
  const radiusMeters = cfg.geoFence.radiusMeters;
  const freq = cfg.frequencyPerMonth ?? 1;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { features: true } });
  const outletMasterGeo = ((client?.features ?? {}) as Record<string, unknown>).outletMasterGeo === true;
  const scope = resolveScope(params, ctx.now);
  // Same 400s as the endpoint (worker re-check): no future month; no window the frequency doesn't have.
  const windowHasCaptures = params.windowKey
    ? (await prisma.visibilityCapture.count({ where: { clientId, windowKey: params.windowKey } })) > 0
    : false;
  const scopeErr = visibilityReportScopeError(params, freq, ctx.now, windowHasCaptures);
  if (scopeErr) throw new BadRequestException(scopeErr);
  const base: Prisma.VisibilityCaptureWhereInput = { clientId, windowKey: { in: scope.readWindows } };
  // Portal go-live = the first month with any capture taken in this portal (a rep is recorded). Months before it are
  // imported old-app history, which only holds approved visits -> no "Not captured" list for them.
  const firstPortal = await prisma.visibilityCapture.findFirst({
    where: { clientId, submittedBySalesUserId: { not: null } },
    orderBy: [{ windowKey: 'asc' }],
    select: { windowKey: true },
  });
  const goLiveMonth = firstPortal?.windowKey ? firstPortal.windowKey.slice(0, 7) : null;

  // ── Photo links: the tenant's primary portal host ──
  const domainRows = await prisma.clientDomain.findMany({ where: { clientId }, select: { domain: true, isPrimary: true } });
  const picked = pickTenantDomain(Array.isArray(domainRows) ? domainRows : [], clientId);
  const linkFor = (key: string) =>
    tenantPortalLink({
      callerOrigin: params.requestOrigin ?? '',
      tenantPrimaryDomain: picked.domain,
      clientId,
      path: visibilityPhotoPath(key),
    });
  /** Per-sheet link writer: real hyperlinks up to the Excel limit, then the URL as text (counted for About). */
  const linkWriter = () => {
    let links = 0;
    let asText = 0;
    return {
      cell(key: string): XlsxCell {
        const target = linkFor(key);
        if (links < VISIBILITY_LINK_LIMIT.perSheet) {
          links++;
          return { __hyperlink: true, text: 'Open photo', target };
        }
        asText++;
        return target;
      },
      get asText() {
        return asText;
      },
    };
  };
  const mainLinks = linkWriter();
  const historyLinks = linkWriter();
  const linkHost = (() => {
    try {
      return new URL(linkFor('x')).host;
    } catch {
      return '';
    }
  })();

  // ── Column plan: CAMERA fields of the form versions in scope, ordered by the current form ──
  const schemaByVersion = new Map<number, Schema>();
  const loadVersions = async (versions: number[]) => {
    const missing = [...new Set(versions)].filter((v) => !schemaByVersion.has(v));
    if (missing.length === 0) return;
    const snaps = await prisma.visibilityFormVersion.findMany({
      where: { clientId, version: { in: missing } },
      select: { version: true, formSchema: true },
    });
    for (const v of missing) schemaByVersion.set(v, undefined);
    for (const s of snaps) schemaByVersion.set(s.version, s.formSchema as unknown as Schema);
  };
  const usedVersions = (
    await prisma.visibilityCapture.findMany({ where: base, distinct: ['formVersion'], select: { formVersion: true } })
  ).map((r) => r.formVersion);
  await loadVersions(usedVersions);
  const currentForm = await prisma.visibilityForm.findUnique({ where: { clientId }, select: { formSchema: true } });
  const columns = planPhotoColumns(
    (currentForm?.formSchema ?? undefined) as unknown as Schema,
    [...usedVersions].sort((a, b) => b - a).map((v) => schemaByVersion.get(v)),
  );
  const labelByField = new Map(columns.map((c) => [c.fieldId, c.label]));

  const people = await loadSalesDirectory(ctx);
  const users = userNameCache(ctx);

  // ── Sheet 1: Visibility ──
  const headers = [
    ...VISIBILITY_REPORT_BASE_HEADERS,
    ...columns.flatMap((c) => VISIBILITY_PHOTO_SUFFIXES.map((s) => `${c.label} – ${s}`)),
  ];
  const main = await out.addSheet('Visibility', headers);
  const statusCounts = new Map<string, number>();
  let importedCount = 0;
  const portalWindowsSeen = new Set<string>();
  let after: { windowKey: string; outletCode: string; id: string } | null = null;

  for (;;) {
    const where: Prisma.VisibilityCaptureWhereInput = after
      ? {
          AND: [
            base,
            {
              OR: [
                { windowKey: { gt: after.windowKey } },
                { windowKey: after.windowKey, outletCode: { gt: after.outletCode } },
                { windowKey: after.windowKey, outletCode: after.outletCode, id: { gt: after.id } },
              ],
            },
          ],
        }
      : base;
    const captures = await prisma.visibilityCapture.findMany({
      where,
      select: {
        id: true,
        outletId: true,
        outletCode: true,
        outletName: true,
        windowKey: true,
        status: true,
        geoFenceOk: true,
        distanceMeters: true,
        captureAccuracy: true,
        capturedAt: true,
        receivedAt: true,
        rejectionReasonCode: true,
        rejectionReason: true,
        formValues: true,
        formVersion: true,
        currentVersion: true,
        photoReviews: true,
        approvedByUserId: true,
        reviewedAt: true,
        submittedBySalesUserId: true,
        outlet: {
          select: {
            name: true,
            city: true,
            state: true,
            programName: true,
            programCategory: true,
            partnerId: true,
            latitude: true,
            longitude: true,
            outletType: { select: { name: true } },
          },
        },
      },
      orderBy: [{ windowKey: 'asc' }, { outletCode: 'asc' }, { id: 'asc' }],
      take: BATCH1_PAGE_SIZE,
    });
    if (captures.length === 0) break;
    const last = captures[captures.length - 1];
    after = { windowKey: last.windowKey, outletCode: last.outletCode, id: last.id };

    await loadVersions(captures.map((c) => c.formVersion));
    const dup = await duplicateCaptureIds(ctx, captures.map((c) => c.id));
    const refByPartner = outletMasterGeo
      ? new Map<string, { lat: number; lng: number }>()
      : await referenceGeoByPartnerId(ctx, captures.map((c) => c.outlet?.partnerId ?? ''));
    const reviewsById = new Map(captures.map((c) => [c.id, readPhotoReviews(c.photoReviews)]));
    await users.load(
      captures.flatMap((c) => [c.approvedByUserId, ...Object.values(reviewsById.get(c.id) ?? {}).map((r) => r.reviewedByUserId)]),
    );

    for (const c of captures) {
      const values = asValues(c.formValues);
      const schema = schemaByVersion.get(c.formVersion);
      const fieldById = new Map(cameraFields(schema).map((f) => [f.id, f]));
      const evalValues = { ...values, ...outletContextValues({ programCategory: c.outlet?.programCategory }) };
      const reviews = reviewsById.get(c.id) ?? {};
      const imported = isImported(values);
      if (imported) importedCount++;
      else portalWindowsSeen.add(c.windowKey);
      statusCounts.set(c.status, (statusCounts.get(c.status) ?? 0) + 1);
      // Review info must belong to the CURRENT version: a review older than this version's submission is a decision
      // carried forward from an earlier version (re-take flow) — never shown as the visit's reviewer.
      const submittedAtMs = c.receivedAt.getTime();
      const isFresh = (iso: string | Date | null | undefined) => {
        if (imported) return true;
        const t = iso instanceof Date ? iso.getTime() : iso ? Date.parse(iso) : NaN;
        return !(Number.isFinite(t) && t < submittedAtMs);
      };
      const capturedReviewer = c.status !== 'SUBMITTED' && isFresh(c.reviewedAt);

      // Per-photo fence policy for this outlet.
      const policy = outletMasterGeo
        ? outletMasterFencePolicy({ latitude: c.outlet?.latitude, longitude: c.outlet?.longitude })
        : null;
      const ref = !outletMasterGeo && c.outlet?.partnerId ? refByPartner.get(c.outlet.partnerId) ?? null : null;
      const photoLocation = (f: FormField | undefined, geo: ReturnType<typeof readMediaValue>['geo']): string => {
        if (imported && !geo) return 'Not recorded (old app)';
        if (policy) {
          if (f?.geoFenceRequired !== true) return '';
          if (!geo) return locationWords('unverifiable');
          const { status } = classifyPhotoFence(geo, policy);
          const nullIsland = geo.lat === 0 && geo.lng === 0;
          const d = policy.reference && !nullIsland ? haversineMeters(geo, policy.reference) : null;
          return locationWords(status, d, num(geo.accuracy));
        }
        if (!geo) return '';
        const status: PhotoFenceStatus = evaluatePhotoFence(geo, ref, radiusMeters);
        return locationWords(status, ref ? haversineMeters(geo, ref) : null, num(geo.accuracy));
      };

      const rejectedParts: string[] = [];
      const photoCells: XlsxCell[] = [];
      for (const col of columns) {
        const f = fieldById.get(col.fieldId);
        const media = readMediaValue(values[col.fieldId]);
        if (!media.key) {
          const applies = !!f && evaluateVisibleWhen(f, evalValues);
          photoCells.push('', applies ? '' : 'Not applicable', '', '', '', '');
          continue;
        }
        const r = reviews[col.fieldId];
        let decision = 'Pending';
        let reason = '';
        let by = '';
        let on = '';
        if (r) {
          decision = decisionWord(r.status);
          if (r.status === 'APPROVED' && !isFresh(r.reviewedAt)) decision = 'Approved (earlier version)';
          if (r.status === 'REJECTED') reason = reasonText(r.reason, r.reasonCode);
          by = users.name(r.reviewedByUserId);
          on = istHumanDateTime(r.reviewedAt);
        } else if (c.status === 'APPROVED' || c.status === 'REJECTED') {
          // Whole-capture decision without a per-photo entry (imported history / pre-per-photo reviews).
          decision = c.status === 'APPROVED' ? 'Approved' : 'Rejected';
          if (c.status === 'REJECTED') reason = reasonText(c.rejectionReason, c.rejectionReasonCode);
          by = users.name(c.approvedByUserId);
          on = istHumanDateTime(c.reviewedAt);
        }
        if (decision === 'Rejected') rejectedParts.push(`${col.label}: ${reason || 'no reason given'}`);
        photoCells.push(mainLinks.cell(media.key), decision, reason, by, on, photoLocation(f, media.geo));
      }

      // Capture-level reviewer = the latest per-photo review OF THIS VERSION, else the whole-capture reviewer.
      const lr = latestReview(Object.fromEntries(Object.entries(reviews).filter(([, r]) => isFresh(r.reviewedAt))));
      const reviewedBy = lr ? users.name(lr.reviewedByUserId) : capturedReviewer ? users.name(c.approvedByUserId) : '';
      const reviewedOn = lr ? istHumanDateTime(lr.reviewedAt) : capturedReviewer ? istHumanDateTime(c.reviewedAt) : '';

      let remark = '';
      if (c.status === 'REJECTED' && (c.rejectionReason || c.rejectionReasonCode)) {
        const label = reasonCodeLabel(c.rejectionReasonCode);
        const text = (c.rejectionReason ?? '').trim();
        remark = label && text ? `${label}: ${text}` : label || text;
      } else if (rejectedParts.length > 0) {
        remark = `Re-take needed: ${rejectedParts.join('; ')}`;
      }

      const distance = num(c.distanceMeters);
      const accuracy = num(c.captureAccuracy);
      const location =
        imported && c.geoFenceOk === null && distance == null
          ? 'Not recorded (old app)'
          : locationWords(c.geoFenceOk === null ? 'unverifiable' : c.geoFenceOk ? 'inside' : 'outside', distance, accuracy);
      const rep = people.person(c.submittedBySalesUserId);

      await main.addRow([
        c.outletCode,
        c.outlet?.name ?? c.outletName,
        c.outlet?.outletType?.name ?? '',
        c.outlet?.programName ?? '',
        c.outlet?.programCategory ?? '',
        c.outlet?.city ?? '',
        c.outlet?.state ?? '',
        c.windowKey,
        imported ? SOURCE_IMPORTED : SOURCE_PORTAL,
        visibilityStatusWords(c.status),
        rep.name,
        rep.code,
        rep.designation,
        people.manager(c.submittedBySalesUserId),
        istHumanDateTime(c.capturedAt),
        istHumanDateTime(c.receivedAt),
        Math.max((c.currentVersion ?? 1) - 1, 0),
        location,
        dup.has(c.id) ? 'Yes' : 'No',
        reviewedBy,
        reviewedOn,
        remark,
        ...photoCells,
      ]);
    }
    if (captures.length < BATCH1_PAGE_SIZE) break;
  }
  const mainRows = main.rowCount;

  // ── Sheet 2: Review history (one row per submitted version per photo) ──
  const history = await out.addSheet('Review history', VISIBILITY_HISTORY_HEADERS);
  const subBase: Prisma.VisibilityCaptureSubmissionWhereInput = { clientId, windowKey: { in: scope.readWindows } };
  let subAfter: { windowKey: string; captureId: string; version: number } | null = null;
  for (;;) {
    const subs = await prisma.visibilityCaptureSubmission.findMany({
      where: subAfter
        ? {
            AND: [
              subBase,
              {
                OR: [
                  { windowKey: { gt: subAfter.windowKey } },
                  { windowKey: subAfter.windowKey, captureId: { gt: subAfter.captureId } },
                  { windowKey: subAfter.windowKey, captureId: subAfter.captureId, version: { gt: subAfter.version } },
                ],
              },
            ],
          }
        : subBase,
      select: {
        captureId: true,
        windowKey: true,
        version: true,
        formValues: true,
        photoReviews: true,
        formVersion: true,
        createdAt: true,
        capture: {
          select: {
            outletCode: true,
            outletName: true,
            outlet: { select: { name: true } },
            currentVersion: true,
            status: true,
            approvedByUserId: true,
            reviewedAt: true,
            rejectionReason: true,
            rejectionReasonCode: true,
          },
        },
      },
      orderBy: [{ windowKey: 'asc' }, { captureId: 'asc' }, { version: 'asc' }],
      take: BATCH1_PAGE_SIZE,
    });
    if (subs.length === 0) break;
    const lastSub = subs[subs.length - 1];
    subAfter = { windowKey: lastSub.windowKey, captureId: lastSub.captureId, version: lastSub.version };
    await loadVersions(subs.map((s) => s.formVersion));
    const snapById: Array<Record<string, PhotoReview>> = subs.map((s) => readPhotoReviews(s.photoReviews));
    await users.load(
      subs.flatMap((s, i) => [s.capture?.approvedByUserId, ...Object.values(snapById[i]).map((r) => r.reviewedByUserId)]),
    );
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      const values = asValues(s.formValues);
      const snap = snapById[i];
      const isCurrent = s.capture?.currentVersion === s.version;
      for (const f of cameraFields(schemaByVersion.get(s.formVersion))) {
        const media = readMediaValue(values[f.id]);
        if (!media.key) continue;
        const r = snap[f.id];
        let decision = 'Pending';
        let reason = '';
        let by = '';
        let on = '';
        if (r) {
          decision = decisionWord(r.status);
          if (r.status === 'REJECTED') reason = reasonText(r.reason, r.reasonCode);
          by = users.name(r.reviewedByUserId);
          on = istHumanDateTime(r.reviewedAt);
        } else if (isCurrent && (s.capture?.status === 'APPROVED' || s.capture?.status === 'REJECTED')) {
          decision = s.capture.status === 'APPROVED' ? 'Approved' : 'Rejected';
          if (s.capture.status === 'REJECTED') reason = reasonText(s.capture.rejectionReason, s.capture.rejectionReasonCode);
          by = users.name(s.capture.approvedByUserId);
          on = istHumanDateTime(s.capture.reviewedAt);
        } else if (!isCurrent) {
          decision = 'Not recorded';
        }
        await history.addRow([
          s.capture?.outletCode ?? '',
          s.capture?.outlet?.name ?? s.capture?.outletName ?? '',
          s.windowKey,
          s.version,
          istHumanDateTime(s.createdAt),
          labelByField.get(f.id) ?? f.label ?? f.id,
          historyLinks.cell(media.key),
          decision,
          reason,
          by,
          on,
        ]);
      }
    }
    if (subs.length < BATCH1_PAGE_SIZE) break;
  }
  const historyRows = history.rowCount;

  // ── Sheet 3: Not captured (in-scope outlets × expected windows with no capture) ──
  const notCaptured = await out.addSheet('Not captured', VISIBILITY_NOT_CAPTURED_HEADERS);
  // Imported months (before the portal go-live — or, with no portal capture yet, a month holding imported history):
  // the old app only exported APPROVED visits, so "no capture" there means nothing → one explanatory row, no list.
  const notTracked = goLiveMonth ? scope.month < goLiveMonth : importedCount > 0;
  const expectedWindows = notTracked ? [] : expectedWindowsFor(params, scope.month, freq, portalWindowsSeen);
  const windowInfo = new Map(
    expectedWindows.map((w) => [w, { ...windowRangeUtc(w, freq), phase: windowPhase(w, freq, ctx.now) }] as const),
  );
  let notYet = 0;
  let missed = 0;
  let notStarted = 0;
  if (notTracked) {
    await notCaptured.addRow([NOT_TRACKED_MESSAGE, '', '', '', '', '', '', '', '', '', params.windowKey ?? '', 'Not tracked']);
  } else if (cfg.outletScope.length > 0 && expectedWindows.length > 0) {
    // Outlets that existed during the period: created before its end, not deactivated before it began (today's
    // outlet type / programme are used — their history is not kept). Checked again per window below.
    const infos = [...windowInfo.values()];
    const activeDuring = {
      start: new Date(Math.min(...infos.map((i) => i.start.getTime()))),
      end: new Date(Math.max(...infos.map((i) => i.end.getTime()))),
    };
    const inScope = visibilityAddressableOutletWhere(clientId, cfg.outletScope, cfg, activeDuring);
    let oAfter: { outletCode: string; id: string } | null = null;
    for (;;) {
      const outlets = await prisma.outlet.findMany({
        where: oAfter
          ? {
              AND: [
                inScope,
                { OR: [{ outletCode: { gt: oAfter.outletCode } }, { outletCode: oAfter.outletCode, id: { gt: oAfter.id } }] },
              ],
            }
          : inScope,
        select: {
          id: true,
          outletCode: true,
          name: true,
          city: true,
          state: true,
          programName: true,
          programCategory: true,
          createdAt: true,
          deactivatedAt: true,
          outletType: { select: { name: true } },
        },
        orderBy: [{ outletCode: 'asc' }, { id: 'asc' }],
        take: BATCH1_PAGE_SIZE,
      });
      if (outlets.length === 0) break;
      const lastO = outlets[outlets.length - 1];
      oAfter = { outletCode: lastO.outletCode, id: lastO.id };
      const ids = outlets.map((o) => o.id);
      const have = await prisma.visibilityCapture.findMany({
        where: { clientId, outletId: { in: ids }, windowKey: { in: expectedWindows } },
        select: { outletId: true, windowKey: true },
      });
      const haveSet = new Set(have.map((h) => `${h.outletId}|${h.windowKey}`));
      // Only ACTIVE, non-deleted reps.
      const assignments = await prisma.salesUserAssignment.findMany({
        where: { unassignedAt: null, outletId: { in: ids }, salesUser: { clientId, deletedAt: null, isActive: true } },
        select: { outletId: true, salesUserId: true },
        orderBy: [{ assignedAt: 'desc' }, { id: 'asc' }],
      });
      const repsByOutlet = new Map<string, string[]>();
      for (const a of assignments) {
        if (!a.outletId) continue;
        const list = repsByOutlet.get(a.outletId) ?? [];
        if (!list.includes(a.salesUserId)) list.push(a.salesUserId);
        repsByOutlet.set(a.outletId, list);
      }
      for (const o of outlets) {
        const reps = repsByOutlet.get(o.id) ?? [];
        const repPeople = reps.map((id) => people.person(id));
        const managers = [...new Set(reps.map((id) => people.manager(id)).filter(Boolean))];
        for (const w of expectedWindows) {
          if (haveSet.has(`${o.id}|${w}`)) continue;
          const info = windowInfo.get(w)!;
          const created = o.createdAt ? new Date(o.createdAt).getTime() : 0;
          if (created >= info.end.getTime()) continue; // the outlet did not exist yet in that window
          if (info.phase === 'closed') {
            if (o.deactivatedAt && new Date(o.deactivatedAt).getTime() <= info.start.getTime()) continue;
          } else if (o.deactivatedAt) {
            continue; // an open / future window only expects outlets that are active today
          }
          const status = info.phase === 'closed' ? 'Missed' : info.phase === 'open' ? 'Not captured yet' : 'Not started';
          if (info.phase === 'closed') missed++;
          else if (info.phase === 'open') notYet++;
          else notStarted++;
          await notCaptured.addRow([
            o.outletCode,
            o.name,
            o.outletType?.name ?? '',
            o.programName ?? '',
            o.programCategory ?? '',
            o.city ?? '',
            o.state ?? '',
            repPeople.map((p) => p.name).filter(Boolean).join(', '),
            repPeople.map((p) => p.code).filter(Boolean).join(', '),
            managers.join(', '),
            w,
            status,
          ]);
        }
      }
      if (outlets.length < BATCH1_PAGE_SIZE) break;
    }
  }

  // ── Sheet 4: About ──
  const about = await out.addSheet('About', ['Item', 'Details']);
  const scopeText = params.windowKey ? `Window ${params.windowKey} (${monthLabel(scope.month)})` : `${monthLabel(scope.month)} — every window of the month`;
  const aboutRows: Array<[string, string | number]> = [
    ['Report', 'Visibility (POSM) report'],
    ['Covers', scopeText],
    ['Generated on', `${istHumanDateTime(ctx.now)} (India time)`],
    ['Visits in the Visibility sheet', mainRows],
    ...VISIBILITY_STATUS_ORDER.map((s): [string, number] => [`  ${VISIBILITY_STATUS_WORDS[s]}`, statusCounts.get(s) ?? 0]),
    ['  of which imported from the old app', importedCount],
    ['Rows in the Review history sheet', historyRows],
    ...(notTracked
      ? ([['Not captured', 'Not tracked for this month (imported old-app history — see NOT CAPTURED below)']] as Array<[string, string]>)
      : ([
          ['Not captured yet (window still open)', notYet],
          ['Missed (window closed, no capture)', missed],
          ['Not started (window has not begun)', notStarted],
        ] as Array<[string, number]>)),
    ['', ''],
    ['STATUS', ''],
    ['Waiting for review', 'The rep has submitted the photos; nobody has decided on every photo yet.'],
    ['Approved', 'Every required photo was approved. The visit counts as done for that window.'],
    ['Needs re-take', 'At least one photo was rejected. The rep must re-take it; the reason is in "Overall remark" and in the photo\'s own Reason column.'],
    ['Rejected', 'The whole visit was rejected by the reviewer. The rep must capture it again.'],
    ['Not captured yet / Missed / Not started', 'Not captured sheet: an in-scope outlet with no visit for the window — "Not captured yet" while the window is open (India time), "Missed" once it has closed, "Not started" when the window has not begun yet.'],
    ['', ''],
    ['COLUMNS', ''],
    ['Source', `"${SOURCE_PORTAL}" = captured in this portal. "${SOURCE_IMPORTED}" = history brought over from the previous app (no rep, location or review history was recorded there).`],
    ['Captured by / Rep code / Rep designation', 'The sales rep who submitted the visit.'],
    ['Manager', 'The rep\'s first active manager up the reporting chain (vacant positions are skipped), shown as "Name (Designation)".'],
    ['Captured on / Submitted on', 'When the photo was taken on the phone / when it reached the server (India time).'],
    ['Re-takes', 'How many times the rep re-submitted this visit after a rejection.'],
    ['Location check', 'Whether the phone was inside the outlet\'s geo-fence: Inside fence / Outside fence / Unverifiable (no usable location), with the distance from the outlet and the phone\'s GPS accuracy.'],
    ['Duplicate photo', '"Yes" when the same photo was also used on another visit.'],
    ['Reviewed by / Reviewed on', 'The person who made the latest review decision on the CURRENT version of this visit, and when (blank while the latest submission is still waiting for review).'],
    ['Overall remark', 'The reviewer\'s reason when the whole visit was rejected; otherwise each rejected photo with its reason.'],
    ['<Photo> – Photo', 'A clickable "Open photo" link (see PHOTO LINKS below).'],
    ['<Photo> – Decision', 'Approved / Rejected / Pending (not reviewed yet) / Approved (earlier version) (approved before the latest re-take and kept) / Not applicable (this photo was not required for the outlet). Blank = no photo was taken.'],
    ['<Photo> – Reason / Reviewed by / Reviewed on', 'The rejection reason, who decided on this photo and when.'],
    ['<Photo> – Location', 'Where this photo was taken relative to the outlet\'s geo-fence.'],
    ['', ''],
    ['PHOTO LINKS', `Each link opens the photo in the portal${linkHost ? ` (${linkHost})` : ''}. You must be signed in with an account that may view visibility photos; if you are not signed in, the portal asks you to sign in and then opens the photo. The link never works for anyone outside the programme.`],
    ...(picked.note ? ([['Photo link address', picked.note]] as Array<[string, string]>) : []),
    ...(mainLinks.asText + historyLinks.asText > 0
      ? ([[
          'PHOTO LINK LIMIT',
          `Excel allows about 65,000 links per sheet. The first ${VISIBILITY_LINK_LIMIT.perSheet} photos of a sheet are clickable; the remaining ${mainLinks.asText} (Visibility) and ${historyLinks.asText} (Review history) show the full photo address as text — copy it into the browser. Export one window to get every link clickable.`,
        ]] as Array<[string, string]>)
      : []),
    ['REVIEW HISTORY', 'One row per submitted version per photo, with the decision recorded on that version. "Not recorded" = an older version whose decision was not kept. Full who/when history for whole-visit rejections is recorded from the next release onwards.'],
    [
      'NOT CAPTURED',
      notTracked
        ? `This month is imported old-app history${goLiveMonth ? ` (the portal went live in ${monthLabel(goLiveMonth)})` : ''}. The old app only sent approved visits, so missing visits cannot be told apart from rejected ones — the sheet is not filled for imported months.`
        : cfg.outletScope.length === 0
          ? 'No outlet types are in the Visibility scope yet, so no outlet is listed as not captured.'
          : "Outlets in the Visibility scope (same rule as the report screen) that existed during the window: created before the window ended and not deactivated before it began. Outlet type and programme are today's values. Only active assigned reps are shown.",
    ],
  ];
  for (const r of aboutRows) await about.addRow(r);

  return { rowCount: mainRows + historyRows + notCaptured.rowCount };
}

/**
 * Heavy rule: one window → light (streamed now); a whole month (the default) → Downloads page (Bajaj ~6.5k outlets ×
 * windows + history + not-captured). Access mirrors the endpoint: @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN') +
 * @RequirePermission('visibility:read'); the Visibility master switch is checked by the endpoint and again in run.
 */
export const VISIBILITY_CAPTURES_KIND: ExportKindDef<VisibilityCapturesParams> = {
  kind: 'visibility-captures',
  label: 'Visibility report',
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'visibility:read' },
  parseParams(raw) {
    const r = rawObject(raw);
    const windowKey = optionalString(r, 'windowKey')?.trim() || undefined;
    const month = optionalString(r, 'month')?.trim() || undefined;
    const requestOrigin = optionalString(r, 'requestOrigin')?.trim() || undefined;
    if (windowKey && !WINDOW_RE.test(windowKey)) throw new BadRequestException('windowKey must look like 2026-11-P1');
    if (month && !MONTH_RE.test(month)) throw new BadRequestException('month must look like 2026-11');
    const futureErr = visibilityReportScopeError({ month, windowKey }, 4, new Date(), true); // future-month check only
    if (futureErr) throw new BadRequestException(futureErr);
    if (windowKey && month && windowKey.slice(0, 7) !== month) {
      throw new BadRequestException('windowKey must be a window of the chosen month');
    }
    return {
      ...(month ? { month } : {}),
      ...(windowKey ? { windowKey } : {}),
      ...(requestOrigin ? { requestOrigin } : {}),
    };
  },
  isHeavy: (p) => !p.windowKey,
  describeParams: (p) => (p.windowKey ? `Window ${p.windowKey}` : p.month ? monthLabel(p.month) : 'This month'),
  fileName: (p, now) => `visibility_report_${p.windowKey ?? p.month ?? istMonthKey(now)}_${utcDateKey(now)}.xlsx`,
  run: runVisibilityCaptures,
};
