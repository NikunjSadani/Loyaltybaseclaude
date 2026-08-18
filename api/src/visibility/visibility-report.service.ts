import { ForbiddenException, Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import {
  TenantSettingsService,
  VisibilityConfigSettings,
} from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { buildXlsx } from '../common/xlsx';
import { currentWindowKey, isWindowClosed } from './visibility-window.helper';
import { readMediaValue } from './visibility-form.helper';
import { evaluatePhotoFence, haversineMeters } from './geo-fence.helper';
import { isGifsyOperator } from '../common/tenant-scope';

/**
 * VisibilityReportService — Visibility (POSM) coverage reporting + export (Stream B,
 * design D15). Coverage per WINDOW: denominator = addressable in-scope outlets (the
 * program-health `addressableWhere` mirror + outletType.code ∈ scope); numerator =
 * distinct outlets with an APPROVED capture at that window. Exposes the GIFSY report,
 * the CLIENT_ADMIN read-only tenant report (same shape), and an xlsx export with
 * auth-gated media links.
 */
@Injectable()
export class VisibilityReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  private async assertEnabled(clientId: string): Promise<void> {
    if (!(await this.tenant.resolveVisibilityEnabled(clientId))) {
      throw new ForbiddenException('Visibility is not enabled for this tenant.');
    }
  }

  private async getConfig(clientId: string): Promise<VisibilityConfigSettings> {
    return (await this.tenantSettings.getEffectiveSettings(clientId)).visibilityConfig;
  }

  /**
   * The addressable-universe `where` for visibility coverage — mirrors the program-health
   * dashboard `addressableWhere` (NOT `isActive:true`; the kycIntent `not` OR-wrapped so
   * NULL-intent outlets survive) INTERSECTED with the configured outlet-type scope.
   */
  private addressableInScopeWhere(
    clientId: string,
    outletScope: string[],
  ): Prisma.OutletWhereInput {
    return {
      clientId,
      deletedAt: null,
      deactivatedAt: null,
      // Exclude NOT_INTERESTED (declined) AND PARKED (admin-removed from pipeline) from the
      // visibility universe. notIn drops NULLs → the {null} branch keeps normal outlets.
      OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
      outletType: { code: { in: outletScope } },
    };
  }

  /** Shared coverage computation for a given window (or the current window). */
  private async computeCoverage(clientId: string, windowKey?: string) {
    const config = await this.getConfig(clientId);
    const now = new Date();
    const freq = config.frequencyPerMonth;
    const key = windowKey && windowKey.trim() ? windowKey : currentWindowKey(now, freq);

    const denominator =
      config.outletScope.length === 0
        ? 0
        : await this.prisma.outlet.count({
            where: this.addressableInScopeWhere(clientId, config.outletScope),
          });

    // M2 — the status buckets MUST be intersected with the SAME addressable∩scope outlet
    // set as the denominator (via the `outlet` relation filter). Without it, an APPROVED
    // capture for a deactivated / out-of-scope / not-interested outlet would count toward
    // the numerator over a denominator that excludes it → coveragePct > 100 / wrong missed.
    const grouped = await this.prisma.visibilityCapture.groupBy({
      by: ['status'],
      where: {
        clientId,
        windowKey: key,
        outlet: this.addressableInScopeWhere(clientId, config.outletScope),
      },
      _count: { _all: true },
    });
    const countOf = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
    const approved = countOf('APPROVED');
    const pending = countOf('SUBMITTED');
    const rejected = countOf('REJECTED');
    // No capture at all = denominator minus every outlet that has any capture row this window
    // (one row per outlet/window by the unique). "missed" once the window has closed.
    const withCapture = approved + pending + rejected;
    const noCapture = Math.max(denominator - withCapture, 0);
    const closed = (() => {
      try {
        return isWindowClosed(key, now, freq);
      } catch {
        return false;
      }
    })();
    const coveragePct = denominator > 0 ? Math.round((approved / denominator) * 1000) / 10 : 0;

    return {
      windowKey: key,
      windowClosed: closed,
      frequencyPerMonth: freq,
      outletScope: config.outletScope,
      summary: {
        denominator,
        captured: approved,
        pending,
        rejected,
        missed: noCapture,
        coveragePct,
      },
    };
  }

  /** GIFSY admin coverage report for a window (default = current). */
  async gifsyReport(user: JwtPayload, windowKey?: string) {
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    if (!isGifsyOperator(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');
    await this.assertEnabled(user.clientId);
    return this.computeCoverage(user.clientId, windowKey);
  }

  /** CLIENT_ADMIN read-only coverage report (same shape as the GIFSY report). */
  async tenantReport(user: JwtPayload, windowKey?: string) {
    await this.assertEnabled(user.clientId);
    return this.computeCoverage(user.clientId, windowKey);
  }

  /**
   * Excel export of captures (a window, or all when omitted). Each media field renders
   * as an auth-gated view link (D15). Columns: outletCode/outletName/window/status/rep/
   * geoFenceOk/distanceMeters/capturedAt/accuracy/dupFlag/reason (+ photo links).
   */
  async exportCaptures(user: JwtPayload, windowKey?: string): Promise<StreamableFile> {
    await this.assertEnabled(user.clientId);
    const clientId = user.clientId;

    const where: Prisma.VisibilityCaptureWhereInput = { clientId };
    if (windowKey && windowKey.trim()) where.windowKey = windowKey;

    const captures = await this.prisma.visibilityCapture.findMany({
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
      orderBy: [{ windowKey: 'asc' }, { outletCode: 'asc' }],
    });

    // Which captures carry a photo that appears on a DIFFERENT capture (dup flag).
    const dupCaptureIds = await this.duplicateCaptureIds(clientId, captures.map((c) => c.id));

    // M5 — batch the DISTINCT form-version snapshots ONCE (was findUnique per row = N+1).
    const versions = [...new Set(captures.map((c) => c.formVersion))];
    const snaps =
      versions.length > 0
        ? await this.prisma.visibilityFormVersion.findMany({
            where: { clientId, version: { in: versions } },
            select: { version: true, formSchema: true },
          })
        : [];
    const schemaByVersion = new Map<number, { fields?: Array<{ id: string; type: string }> }>();
    for (const s of snaps) {
      schemaByVersion.set(s.version, s.formSchema as unknown as { fields?: Array<{ id: string; type: string }> });
    }

    // Per-photo geotag: resolve the tenant fence radius + each outlet's reference geo (the
    // SAME source the aggregate fence uses) so each photo gets its own geo/distance/status.
    const config = await this.getConfig(clientId);
    const radiusMeters = config.geoFence.radiusMeters;
    const referenceByOutletId = await this.referenceGeoByOutletId(
      clientId,
      captures.map((c) => c.outletId),
    );

    // Media view links per capture — resolve each form snapshot's CAMERA field keys.
    const rows: Record<string, unknown>[] = [];
    for (const c of captures) {
      const reference = referenceByOutletId.get(c.outletId) ?? null;
      const photos = this.capturePhotos(
        c.formValues,
        schemaByVersion.get(c.formVersion),
        reference,
        radiusMeters,
      );
      rows.push({
        'Outlet Code': c.outletCode,
        'Outlet Name': c.outletName,
        Window: c.windowKey,
        Status: c.status,
        Rep: c.submittedBy?.employeeCode ?? '',
        'Geo-fence OK': c.geoFenceOk === null ? 'UNVERIFIABLE' : c.geoFenceOk ? 'YES' : 'NO',
        'Distance (m)': c.distanceMeters != null ? String(c.distanceMeters) : '',
        'Captured At': c.capturedAt ? c.capturedAt.toISOString() : '',
        'Received At': c.receivedAt.toISOString(),
        'Accuracy (m)': c.captureAccuracy != null ? String(c.captureAccuracy) : '',
        'Duplicate Photo': dupCaptureIds.has(c.id) ? 'YES' : '',
        'Reject Reason': c.rejectionReasonCode ?? '',
        'Reject Detail': c.rejectionReason ?? '',
        Photos: photos.map((p) => p.link).join(' | '),
        // Per-photo geotag columns (empty per photo when a photo carries no geo → a
        // legacy bare-string capture reads exactly as before, just an empty cell).
        'Photo Geo': photos.map((p) => p.geo).join(' | '),
        'Photo Distance (m)': photos.map((p) => p.distance).join(' | '),
        'Photo Status': photos.map((p) => p.status).join(' | '),
      });
    }

    // buildXlsx derives the header from the first row's keys — guarantee a header even
    // when there are no captures.
    const sheetRows =
      rows.length > 0
        ? rows
        : [
            {
              'Outlet Code': '',
              'Outlet Name': '',
              Window: '',
              Status: '',
              Rep: '',
              'Geo-fence OK': '',
              'Distance (m)': '',
              'Captured At': '',
              'Received At': '',
              'Accuracy (m)': '',
              'Duplicate Photo': '',
              'Reject Reason': '',
              'Reject Detail': '',
              Photos: '',
              'Photo Geo': '',
              'Photo Distance (m)': '',
              'Photo Status': '',
            },
          ];

    const buffer = buildXlsx([{ name: 'Captures', rows: sheetRows }]);
    const suffix = windowKey && windowKey.trim() ? windowKey : 'all';
    const filename = `visibility_captures_${suffix}_${new Date().toISOString().split('T')[0]}.xlsx`;
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /** Capture ids (within the given set) whose photo hash appears on a different capture. */
  private async duplicateCaptureIds(clientId: string, captureIds: string[]): Promise<Set<string>> {
    if (captureIds.length === 0) return new Set();
    const hashes = await this.prisma.visibilityImageHash.findMany({
      where: { clientId },
      select: { hash: true, captureId: true },
    });
    const captureIdsByHash = new Map<string, Set<string>>();
    for (const h of hashes) {
      const s = captureIdsByHash.get(h.hash) ?? new Set<string>();
      s.add(h.captureId);
      captureIdsByHash.set(h.hash, s);
    }
    const inSet = new Set(captureIds);
    const dup = new Set<string>();
    for (const [, ids] of captureIdsByHash) {
      if (ids.size > 1) for (const id of ids) if (inSet.has(id)) dup.add(id);
    }
    return dup;
  }

  /**
   * Per-photo export data for one capture's CAMERA fields, using a pre-fetched form-version
   * snapshot (M5 — the snapshots are batched once by the caller, so this is pure/synchronous
   * with no per-row DB read). Each photo carries:
   *   - link      — the auth-gated media view path.
   *   - geo       — `lat, lng (±Nm)` when the value is `{ key, geo }`, else '' (bare-string key).
   *   - distance  — metres from the outlet reference geo (haversine), '' when either is absent.
   *   - status    — inside / outside / unverifiable via the shared `evaluatePhotoFence`.
   * A photo with no per-photo geo yields empty geo/distance/status (renders as before).
   */
  private capturePhotos(
    formValues: Prisma.JsonValue | null,
    schema: { fields?: Array<{ id: string; type: string }> } | undefined,
    reference: { lat: number; lng: number } | null,
    radiusMeters: number,
  ): Array<{ link: string; geo: string; distance: string; status: string }> {
    if (!formValues || typeof formValues !== 'object') return [];
    if (!schema?.fields) return [];
    const vals = formValues as Record<string, unknown>;
    const photos: Array<{ link: string; geo: string; distance: string; status: string }> = [];
    for (const f of schema.fields) {
      if (f.type !== 'CAMERA') continue;
      const { key, geo } = readMediaValue(vals[f.id]);
      if (!key) continue;
      const link = `/v1/visibility/captures/media?key=${encodeURIComponent(key)}`;
      if (geo) {
        const acc = geo.accuracy != null ? ` (±${Math.round(geo.accuracy)}m)` : '';
        const geoStr = `${geo.lat}, ${geo.lng}${acc}`;
        const status = evaluatePhotoFence(geo, reference, radiusMeters);
        const distance =
          reference != null
            ? String(Math.round(haversineMeters(geo, reference) * 100) / 100)
            : '';
        photos.push({ link, geo: geoStr, distance, status });
      } else {
        photos.push({ link, geo: '', distance: '', status: '' });
      }
    }
    return photos;
  }

  /**
   * Batch-resolve each outlet's reference geo (outletId → {lat,lng}) — the SAME source the
   * aggregate capture-time fence uses: the outlet owner-partner's latest APPROVED KYC
   * board-photo geo (`Outlet.partnerId` → ChannelPartner.kycSubmissions.boardPhotoLat/Lng).
   * Two batched queries (outlets, then partners) — no per-row N+1. Outlets with no partner
   * or no approved board geo are simply absent from the map (→ photos read 'unverifiable').
   */
  private async referenceGeoByOutletId(
    clientId: string,
    outletIds: string[],
  ): Promise<Map<string, { lat: number; lng: number }>> {
    const map = new Map<string, { lat: number; lng: number }>();
    const ids = [...new Set(outletIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return map;

    const outlets = await this.prisma.outlet.findMany({
      where: { id: { in: ids }, clientId },
      select: { id: true, partnerId: true },
    });
    const partnerIds = [
      ...new Set(outlets.map((o) => o.partnerId).filter((p): p is string => !!p)),
    ];
    if (partnerIds.length === 0) return map;

    const partners = await this.prisma.channelPartner.findMany({
      where: { id: { in: partnerIds }, clientId },
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
}
