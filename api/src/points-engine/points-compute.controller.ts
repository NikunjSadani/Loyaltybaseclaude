/**
 * PointsComputeController — Points Compute Engine, Wave 1 (read-only compute + export route).
 *
 *   POST /v1/admin/points-compute/preview          body  { period, program?, kpiCode? }  → ComputePreview JSON
 *   GET  /v1/admin/points-compute/export           query { period, program?, kpiCode? }  → credits-upload xlsx
 *   GET  /v1/admin/points-compute/preview-report   query { period, program?, kpiCode? }  → full review xlsx
 *
 * READ-ONLY — computes + previews/exports; NO wallet write, NO CreditBatch create (that is Wave 2). The
 * `export` xlsx is in the EXACT format the existing credits upload accepts, so after offline client
 * approval the operator uploads it unchanged through the existing credits flow; `preview-report` is the
 * full human report to share for that approval.
 *
 * Auth: role floor @Roles (GIFSY_ADMIN + CLIENT_ADMIN — authoring/preview is client self-serve, §12 #5);
 * fine gate @RequirePermission('points_rules:read'). Tenant scope comes from @CurrentUser().clientId.
 */

import { Body, Controller, ForbiddenException, Get, Post, Query, StreamableFile } from '@nestjs/common';
import { PointsComputeService } from './points-compute.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CommitComputeDto, PreviewComputeDto, SimulateComputeDto } from './dto/points-compute.dto';
import { buildCreditUploadXlsx, buildPreviewReportXlsx } from './points-compute-export.helper';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller('admin/points-compute')
export class PointsComputeController {
  constructor(
    private readonly compute: PointsComputeService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /** POST /v1/admin/points-compute/preview — read-only compute preview for a (tenant × period). */
  @Post('preview')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
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

  /** GET /v1/admin/points-compute/export — OK rows as a credits-upload-format xlsx (→ offline approval → existing upload). */
  @Get('export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  async export(@CurrentUser() user: JwtPayload, @Query() q: PreviewComputeDto): Promise<StreamableFile> {
    // The credit-upload file IS the creditable artifact (it uploads through the ordinary credits flow, which
    // knows nothing of the engine toggle), so withhold it when the engine is disabled. Read the flag UNCACHED
    // + fail-closed — same as the commit money-gate — so a Gifsy "turn it off" takes effect immediately
    // across the fleet (the cached getEffectiveSettings used for preview display could lag up to the TTL).
    const flags = await this.tenantSettings.getPointsEngineFlagsUncached(user.clientId);
    if (!flags.enabled) {
      throw new ForbiddenException(
        'The points engine is disabled for this tenant — enable it in settings before exporting a credit-upload file.',
      );
    }
    const preview = await this.compute.previewCompute(user, {
      period: q.period,
      program: q.program ?? null,
      kpiCode: q.kpiCode ?? null,
    });
    return new StreamableFile(buildCreditUploadXlsx(preview), {
      type: XLSX_MIME,
      disposition: `attachment; filename="points-credit-upload-${preview.period}.xlsx"`,
    });
  }

  /** GET /v1/admin/points-compute/preview-report — full human review xlsx (share with the client offline). */
  @Get('preview-report')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  async previewReport(@CurrentUser() user: JwtPayload, @Query() q: PreviewComputeDto): Promise<StreamableFile> {
    const preview = await this.compute.previewCompute(user, {
      period: q.period,
      program: q.program ?? null,
      kpiCode: q.kpiCode ?? null,
    });
    return new StreamableFile(buildPreviewReportXlsx(preview), {
      type: XLSX_MIME,
      disposition: `attachment; filename="points-preview-${preview.period}.xlsx"`,
    });
  }
}
