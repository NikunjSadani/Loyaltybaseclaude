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
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden - Gifsy Admin only');
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

    // Media view links per capture — resolve each form snapshot's CAMERA field keys.
    const rows: Record<string, unknown>[] = [];
    for (const c of captures) {
      const photos = this.captureMediaLinks(c.formValues, schemaByVersion.get(c.formVersion));
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
        Photos: photos.join(' | '),
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
   * Auth-gated media view links for one capture's CAMERA fields, using a pre-fetched
   * form-version snapshot (M5 — the snapshots are batched once by the caller, so this is
   * pure/synchronous with no per-row DB read).
   */
  private captureMediaLinks(
    formValues: Prisma.JsonValue | null,
    schema: { fields?: Array<{ id: string; type: string }> } | undefined,
  ): string[] {
    if (!formValues || typeof formValues !== 'object') return [];
    if (!schema?.fields) return [];
    const vals = formValues as Record<string, unknown>;
    const links: string[] = [];
    for (const f of schema.fields) {
      if (f.type !== 'CAMERA') continue;
      const key = vals[f.id];
      if (typeof key === 'string' && key) {
        links.push(`/v1/visibility/captures/media?key=${encodeURIComponent(key)}`);
      }
    }
    return links;
  }
}
