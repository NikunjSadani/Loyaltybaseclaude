/**
 * PointsComputeController — Points Compute Engine, Wave 1 (read-only compute + export route).
 *
 *   POST /v1/admin/points-compute/preview          body  { period, program?, kpiCode? }  → ComputePreview JSON
 *   GET  /v1/admin/points-compute/export           query { period, program?, kpiCode? }  → credits-upload xlsx
 *   GET  /v1/admin/points-compute/preview-report   query { period, program?, kpiCode? }  → full review xlsx (POINTS)
 *   GET  /v1/admin/points-compute/payout-report    query { period, program?, kpiCode? }  → payout report xlsx (report-only)
 *
 * READ-ONLY — computes + previews/exports; NO wallet write, NO CreditBatch create (that is Wave 2). The
 * `export` xlsx is in the EXACT format the existing credits upload accepts, so after offline client
 * approval the operator uploads it unchanged through the existing credits flow; `preview-report` is the
 * full human report to share for that approval.
 *
 * Auth: role floor @Roles (GIFSY_ADMIN + CLIENT_ADMIN — authoring/preview is client self-serve, §12 #5);
 * fine gate @RequirePermission('points_rules:read'). Tenant scope comes from @CurrentUser().clientId.
 */

import { Body, Controller, ForbiddenException, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SalesMonthClosedGuard } from '../sales-import/months/sales-month-closed.guard';
import { PointsComputeService } from './points-compute.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CommitComputeDto, PreviewComputeDto, SimulateComputeDto } from './dto/points-compute.dto';
import { ExportsService } from '../exports/exports.service';
import { POINTS_ENGINE_DISABLED_MESSAGE } from '../exports/kinds/batch2/points-compute.kinds';
import { HeavyOp } from '../common/heavy-op-limiter';

@Controller('admin/points-compute')
export class PointsComputeController {
  constructor(
    private readonly compute: PointsComputeService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly exports: ExportsService,
  ) {}

  /** POST /v1/admin/points-compute/preview — read-only compute preview for a (tenant × period). */
  @Post('preview')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  @HeavyOp()
  preview(@CurrentUser() user: JwtPayload, @Body() dto: PreviewComputeDto) {
    return this.compute.previewCompute(user, {
      period: dto.period,
      program: dto.program ?? null,
      kpiCode: dto.kpiCode ?? null,
    });
  }

  /**
   * POST /v1/admin/points-compute/commit — Wave 2 DIRECT-CREDIT: compute the run and create a
   * PENDING_CONFIRM CreditBatch from its OK rows (the operator then confirms it to move money, through
   * the existing credits flow). Double-gated in the service (engine enabled + Gifsy-set directCredit);
   * requires the SAME `credits:upload` entitlement as a manual batch upload. Idempotent per run.
   */
  @Post('commit')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('credits:upload')
  @UseGuards(SalesMonthClosedGuard) // D-1: 409 while the month is OPEN in Sales Import (inert unless features.salesImport)
  @HeavyOp()
  commit(@CurrentUser() user: JwtPayload, @Body() dto: CommitComputeDto) {
    return this.compute.commitCompute(user, {
      period: dto.period,
      program: dto.program ?? null,
      kpiCode: dto.kpiCode ?? null,
      expectedKey: dto.expectedKey ?? null,
    });
  }

  /**
   * POST /v1/admin/points-compute/simulate — PURE live simulation for the rule builder: validate a draft
   * config + evaluate it against one sample context → { valid, errors, outcome(trace) }. No DB/persistence/
   * money; available during authoring regardless of the engine flag. Authoring entitlement (points_rules:read).
   */
  @Post('simulate')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  simulate(@CurrentUser() user: JwtPayload, @Body() dto: SimulateComputeDto) {
    return this.compute.simulate(user, dto);
  }

  /**
   * GET /v1/admin/points-compute/export — OK rows as a credits-upload-format xlsx (→ offline approval → existing upload).
   * The 'points-credit-upload' export kind: the compute runs in the background worker (202 → Downloads page).
   */
  @Get('export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  @UseGuards(SalesMonthClosedGuard) // D-1: 409 while the month is OPEN in Sales Import (inert unless features.salesImport)
  async export(
    @CurrentUser() user: JwtPayload,
    @Query() q: PreviewComputeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The credit-upload file IS the creditable artifact (it uploads through the ordinary credits flow, which
    // knows nothing of the engine toggle), so withhold it when the engine is disabled. Read the flag UNCACHED
    // + fail-closed — same as the commit money-gate. Checked here (immediate 403) AND again when the file is built.
    const flags = await this.tenantSettings.getPointsEngineFlagsUncached(user.clientId);
    if (!flags.enabled) throw new ForbiddenException(POINTS_ENGINE_DISABLED_MESSAGE);
    return this.exports.respond(res, user, 'points-credit-upload', q);
  }

  /**
   * GET /v1/admin/points-compute/preview-report — full human review xlsx (share with the client offline).
   * The 'points-preview-report' export kind (prepared in the background).
   */
  @Get('preview-report')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  @UseGuards(SalesMonthClosedGuard) // D-1: 409 while the month is OPEN in Sales Import (inert unless features.salesImport)
  previewReport(@CurrentUser() user: JwtPayload, @Query() q: PreviewComputeDto, @Res({ passthrough: true }) res: Response) {
    return this.exports.respond(res, user, 'points-preview-report', q);
  }

  /**
   * GET /v1/admin/points-compute/payout-report — the PAYOUT report xlsx (share with the client offline).
   *
   * PAYOUT is COMPUTE-TO-REPORT only (owner directive 2026-10-21): the engine never credits or pays it,
   * so this route — like preview-report — produces a READ-ONLY report and carries NO engine fail-closed
   * gate (it mints no creditable artifact; the preview itself is allowed even when the engine is off).
   * The 'points-payout-report' export kind (prepared in the background).
   */
  @Get('payout-report')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  @UseGuards(SalesMonthClosedGuard) // D-1: 409 while the month is OPEN in Sales Import (inert unless features.salesImport)
  payoutReport(@CurrentUser() user: JwtPayload, @Query() q: PreviewComputeDto, @Res({ passthrough: true }) res: Response) {
    return this.exports.respond(res, user, 'points-payout-report', q);
  }
}