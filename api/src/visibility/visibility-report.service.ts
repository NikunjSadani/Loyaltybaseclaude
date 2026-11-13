import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import {
  TenantSettingsService,
  VisibilityConfigSettings,
} from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { currentWindowKey, isWindowClosed } from './visibility-window.helper';
import { isGifsyOperator } from '../common/tenant-scope';
import { VisibilityProgramScopeLike, visibilityProgramScope, withVisibilityProgramWhere } from './visibility-scope.helper';

/**
 * VisibilityReportService — Visibility (POSM) coverage reporting + export (Stream B,
 * design D15). Coverage per WINDOW: denominator = addressable in-scope outlets (the
 * program-health `addressableWhere` mirror + outletType.code ∈ scope); numerator =
 * distinct outlets with an APPROVED capture at that window. Exposes the GIFSY report,
 * the CLIENT_ADMIN read-only tenant report (same shape). The xlsx captures export is the
 * `visibility-captures` export kind (exports/kinds/batch1/visibility-captures.ts).
 */
@Injectable()
export class VisibilityReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /** 403 unless the tenant's Visibility master switch is on (also used by the captures export endpoint). */
  async assertEnabled(clientId: string): Promise<void> {
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
    programCfg?: VisibilityProgramScopeLike | null,
  ): Prisma.OutletWhereInput {
    // APPLIES-TO (D9/D12): the optional programs/subPrograms narrowing is merged here, the ONE
    // builder both the denominator AND the numerator use — so they always move together
    // (numerator ⊆ denominator invariant). Unscoped config → the exact pre-scope where.
    return withVisibilityProgramWhere(
      {
        clientId,
        deletedAt: null,
        deactivatedAt: null,
        // Exclude NOT_INTERESTED (declined) AND PARKED (admin-removed from pipeline) from the
        // visibility universe. notIn drops NULLs → the {null} branch keeps normal outlets.
        OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
        outletType: { code: { in: outletScope } },
      },
      programCfg,
    );
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
            where: this.addressableInScopeWhere(clientId, config.outletScope, config),
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
        outlet: this.addressableInScopeWhere(clientId, config.outletScope, config),
      },
      _count: { _all: true },
    });
    const countOf = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
    const approved = countOf('APPROVED');
    const pending = countOf('SUBMITTED');
    // CHANGES_REQUESTED (per-photo re-open) is treated like the old whole-capture REJECTED for
    // coverage: not satisfied, rep must act. Folded into the rejected bucket so it is neither
    // counted as satisfied nor double-counted as "missed".
    const rejected = countOf('REJECTED') + countOf('CHANGES_REQUESTED');
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
    // APPLIES-TO: surface the program / sub-program narrowing for the "Scope:" caption — ADDITIVE
    // and ONLY when non-empty, so an unscoped tenant's (Deoleo's) response is byte-identical.
    const programScope = visibilityProgramScope(config);

    return {
      windowKey: key,
      windowClosed: closed,
      frequencyPerMonth: freq,
      outletScope: config.outletScope,
      ...(programScope.programs.length ? { programs: programScope.programs } : {}),
      ...(programScope.subPrograms.length ? { subPrograms: programScope.subPrograms } : {}),
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
}
