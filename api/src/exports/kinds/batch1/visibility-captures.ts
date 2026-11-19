/**
 * Visibility (POSM) captures export as a background export — kind `visibility-captures`, served by
 * `GET /v1/visibility/report/export[?windowKey=]` (moved from VisibilityReportService.exportCaptures). Output is
 * cell-for-cell the old file (parity spec: visibility-captures.spec.ts).
 *
 * Per page of ≤ 2,000 captures (keyset on windowKey, outletCode, id):
 *  - the page's captures;
 *  - the duplicate-photo flag from the page's OWN image hashes (+ the other captures sharing those hashes) — was every
 *    `visibilityImageHash` row of the tenant (~62k) even for a one-window export;
 *  - form-version snapshots, cached by version for the whole export;
 *  - the reference board geo of the page's outlets.
 */
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { istDateTimeCell } from '../../../common/ist-date';
import { TenantService } from '../../../tenant/tenant.service';
import { TenantSettingsService } from '../../../tenant/tenant-settings.service';
import { readMediaValue } from '../../../visibility/visibility-form.helper';
import {
  classifyPhotoFence,
  evaluatePhotoFence,
  haversineMeters,
  outletMasterFencePolicy,
  type PhotoFencePolicy,
} from '../../../visibility/geo-fence.helper';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import { BATCH1_PAGE_SIZE, optionalString, rawObject, utcDateKey } from './common';

export interface VisibilityCapturesParams {
  /** A window (`YYYY-MM-Pn`), or undefined = every capture of the tenant. */
  windowKey?: string;
}

export const VISIBILITY_CAPTURES_HEADERS = [
  'Outlet Code', 'Outlet Name', 'Window', 'Status', 'Rep', 'Geo-fence OK', 'Distance (m)', 'Captured At',
  'Received At', 'Accuracy (m)', 'Duplicate Photo', 'Reject Reason', 'Reject Detail', 'Photos', 'Photo Geo',
  'Photo Distance (m)', 'Photo Status',
] as const;

type FormSchema = { fields?: Array<{ id: string; type: string; geoFenceRequired?: boolean }> };
type Photo = { link: string; geo: string; distance: string; status: string };

/**
 * Per-photo export data for one capture's CAMERA fields: the auth-gated media view path, `lat, lng (±Nm)` when the value
 * carries geo, the metres from the outlet reference geo, and the shared photo-fence verdict. A photo without geo yields
 * empty geo/distance/status.
 */
function capturePhotos(
  formValues: Prisma.JsonValue | null,
  schema: FormSchema | undefined,
  reference: { lat: number; lng: number } | null,
  radiusMeters: number,
): Photo[] {
  if (!formValues || typeof formValues !== 'object') return [];
  if (!schema?.fields) return [];
  const vals = formValues as Record<string, unknown>;
  const photos: Photo[] = [];
  for (const f of schema.fields) {
    if (f.type !== 'CAMERA') continue;
    const { key, geo } = readMediaValue(vals[f.id]);
    if (!key) continue;
    const link = `/v1/visibility/captures/media?key=${encodeURIComponent(key)}`;
    if (geo) {
      const acc = geo.accuracy != null ? ` (±${Math.round(geo.accuracy)}m)` : '';
      const status = evaluatePhotoFence(geo, reference, radiusMeters);
      const distance = reference != null ? String(Math.round(haversineMeters(geo, reference) * 100) / 100) : '';
      photos.push({ link, geo: `${geo.lat}, ${geo.lng}${acc}`, distance, status });
    } else {
      photos.push({ link, geo: '', distance: '', status: '' });
    }
  }
  return photos;
}

/**
 * Outlet-master tenants (Bajaj, features.outletMasterGeo): per-photo status / distance with the capture verdict's OWN
 * policy (geo-fence.helper — outlet-master coordinates guarded by isUsableReference, forced 200 m, accuracy buffer,
 * 0,0 = unverifiable). Only stored photos of FENCE fields get a status / distance (the verdict fences nothing else;
 * hidden or empty slots are never stored, so they never appear). Other stored photos keep their link + geo only.
 */
function capturePhotosOutletMaster(
  formValues: Prisma.JsonValue | null,
  schema: FormSchema | undefined,
  policy: PhotoFencePolicy,
): Photo[] {
  if (!formValues || typeof formValues !== 'object') return [];
  if (!schema?.fields) return [];
  const vals = formValues as Record<string, unknown>;
  const photos: Photo[] = [];
  for (const f of schema.fields) {
    if (f.type !== 'CAMERA') continue;
    const { key, geo } = readMediaValue(vals[f.id]);
    if (!key) continue;
    const link = `/v1/visibility/captures/media?key=${encodeURIComponent(key)}`;
    if (!geo) {
      photos.push({ link, geo: '', distance: '', status: f.geoFenceRequired === true ? 'unverifiable' : '' });
      continue;
    }
    const acc = geo.accuracy != null ? ` (±${Math.round(geo.accuracy)}m)` : '';
    if (f.geoFenceRequired !== true) {
      photos.push({ link, geo: `${geo.lat}, ${geo.lng}${acc}`, distance: '', status: '' });
      continue;
    }
    const { status } = classifyPhotoFence(geo, policy);
    const nullIsland = geo.lat === 0 && geo.lng === 0;
    const distance =
      policy.reference != null && !nullIsland ? String(Math.round(haversineMeters(geo, policy.reference) * 100) / 100) : '';
    photos.push({ link, geo: `${geo.lat}, ${geo.lng}${acc}`, distance, status });
  }
  return photos;
}

/** Outlet-master coordinates of the page's outlets (outlet-master tenants only). */
async function outletMasterPolicyByOutletId(ctx: ExportRunContext, outletIds: string[]): Promise<Map<string, PhotoFencePolicy>> {
  const map = new Map<string, PhotoFencePolicy>();
  const ids = [...new Set(outletIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return map;
  const outlets = await ctx.prisma.outlet.findMany({
    where: { id: { in: ids }, clientId: ctx.clientId },
    select: { id: true, latitude: true, longitude: true },
  });
  for (const o of outlets) map.set(o.id, outletMasterFencePolicy(o));
  return map;
}

/**
 * Reference geo per outlet — the outlet owner-partner's latest APPROVED KYC board-photo geo (the SAME source the
 * capture-time fence uses). Outlets with no partner / no approved board geo are absent (→ photos read 'unverifiable').
 */
async function referenceGeoByOutletId(
  ctx: ExportRunContext,
  outletIds: string[],
): Promise<Map<string, { lat: number; lng: number }>> {
  const map = new Map<string, { lat: number; lng: number }>();
  const ids = [...new Set(outletIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return map;
  const outlets = await ctx.prisma.outlet.findMany({
    where: { id: { in: ids }, clientId: ctx.clientId },
    select: { id: true, partnerId: true },
  });
  const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter((p): p is string => !!p))];
  if (partnerIds.length === 0) return map;
  const partners = await ctx.prisma.channelPartner.findMany({
    where: { id: { in: partnerIds }, clientId: ctx.clientId },
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
  const geoByPartner = new Map<string, { lat: number; lng: number }>();
  for (const p of partners) {
    const sub = p.kycSubmissions?.[0];
    if (sub && sub.boardPhotoLat != null && sub.boardPhotoLng != null) {
      geoByPartner.set(p.id, { lat: Number(sub.boardPhotoLat), lng: Number(sub.boardPhotoLng) });
    }
  }
  for (const o of outlets) {
    const g = o.partnerId ? geoByPartner.get(o.partnerId) : undefined;
    if (g) map.set(o.id, g);
  }
  return map;
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
  const captureIdsByHash = new Map<string, Set<string>>();
  for (const h of sharing) {
    const s = captureIdsByHash.get(h.hash) ?? new Set<string>();
    s.add(h.captureId);
    captureIdsByHash.set(h.hash, s);
  }
  const inPage = new Set(captureIds);
  for (const ids of captureIdsByHash.values()) {
    if (ids.size > 1) for (const id of ids) if (inPage.has(id)) dup.add(id);
  }
  return dup;
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
  const radiusMeters = (await settings.getEffectiveSettings(clientId)).visibilityConfig.geoFence.radiusMeters;
  // Outlet-master tenants use the capture verdict's own per-photo policy; every other tenant is byte-identical.
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { features: true } });
  const outletMasterGeo = ((client?.features ?? {}) as Record<string, unknown>).outletMasterGeo === true;

  const sheet = await out.addSheet('Captures', VISIBILITY_CAPTURES_HEADERS);
  const schemaByVersion = new Map<number, FormSchema | undefined>();
  const base: Prisma.VisibilityCaptureWhereInput = { clientId };
  if (params.windowKey) base.windowKey = params.windowKey;
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
        submittedBy: { select: { employeeCode: true } },
      },
      orderBy: [{ windowKey: 'asc' }, { outletCode: 'asc' }, { id: 'asc' }],
      take: BATCH1_PAGE_SIZE,
    });
    if (captures.length === 0) break;
    const last = captures[captures.length - 1];
    after = { windowKey: last.windowKey, outletCode: last.outletCode, id: last.id };

    const dup = await duplicateCaptureIds(ctx, captures.map((c) => c.id));
    const missingVersions = [...new Set(captures.map((c) => c.formVersion))].filter((v) => !schemaByVersion.has(v));
    if (missingVersions.length > 0) {
      const snaps = await prisma.visibilityFormVersion.findMany({
        where: { clientId, version: { in: missingVersions } },
        select: { version: true, formSchema: true },
      });
      for (const v of missingVersions) schemaByVersion.set(v, undefined);
      for (const s of snaps) schemaByVersion.set(s.version, s.formSchema as unknown as FormSchema);
    }
    const referenceByOutletId = outletMasterGeo
      ? new Map<string, { lat: number; lng: number }>()
      : await referenceGeoByOutletId(ctx, captures.map((c) => c.outletId));
    const policyByOutletId = outletMasterGeo
      ? await outletMasterPolicyByOutletId(ctx, captures.map((c) => c.outletId))
      : new Map<string, PhotoFencePolicy>();

    for (const c of captures) {
      const photos = outletMasterGeo
        ? capturePhotosOutletMaster(
            c.formValues,
            schemaByVersion.get(c.formVersion),
            policyByOutletId.get(c.outletId) ?? outletMasterFencePolicy({}),
          )
        : capturePhotos(
            c.formValues,
            schemaByVersion.get(c.formVersion),
            referenceByOutletId.get(c.outletId) ?? null,
            radiusMeters,
          );
      await sheet.addRow([
        c.outletCode,
        c.outletName,
        c.windowKey,
        c.status,
        c.submittedBy?.employeeCode ?? '',
        c.geoFenceOk === null ? 'UNVERIFIABLE' : c.geoFenceOk ? 'YES' : 'NO',
        c.distanceMeters != null ? String(c.distanceMeters) : '',
        c.capturedAt ? istDateTimeCell(c.capturedAt) : '',
        istDateTimeCell(c.receivedAt),
        c.captureAccuracy != null ? String(c.captureAccuracy) : '',
        dup.has(c.id) ? 'YES' : '',
        c.rejectionReasonCode ?? '',
        c.rejectionReason ?? '',
        photos.map((p) => p.link).join(' | '),
        photos.map((p) => p.geo).join(' | '),
        photos.map((p) => p.distance).join(' | '),
        photos.map((p) => p.status).join(' | '),
      ]);
    }
    if (captures.length < BATCH1_PAGE_SIZE) break;
  }

  // No captures → one all-blank row, as the old builder did.
  if (sheet.rowCount === 0) await sheet.addRow(VISIBILITY_CAPTURES_HEADERS.map(() => ''));
  return { rowCount: sheet.rowCount };
}

/**
 * Heavy rule: no window ("all captures" — 51k rows incl. form JSON for Bajaj; the audit's certain-OOM case) → heavy;
 * one window (part of one month) → light, streamed instantly.
 * Access mirrors the endpoint: @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN') + @RequirePermission('visibility:read'); the tenant's
 * Visibility master switch is checked by the endpoint (403 before any file) and again inside run (worker).
 */
export const VISIBILITY_CAPTURES_KIND: ExportKindDef<VisibilityCapturesParams> = {
  kind: 'visibility-captures',
  label: 'Visibility captures',
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'visibility:read' },
  parseParams(raw) {
    const windowKey = optionalString(rawObject(raw), 'windowKey');
    // Old rule: a blank / whitespace-only window means "all"; a real one is used as given.
    return windowKey && windowKey.trim() ? { windowKey } : {};
  },
  isHeavy: (p) => !p.windowKey,
  describeParams: (p) => (p.windowKey ? `Window ${p.windowKey}` : 'All windows'),
  fileName: (p, now) => `visibility_captures_${p.windowKey ?? 'all'}_${utcDateKey(now)}.xlsx`,
  run: runVisibilityCaptures,
};
