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

import { Body, Controller, Get, Post, Query, StreamableFile } from '@nestjs/common';
import { PointsComputeService } from './points-compute.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PreviewComputeDto } from './dto/points-compute.dto';
import { buildCreditUploadXlsx, buildPreviewReportXlsx } from './points-compute-export.helper';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller('admin/points-compute')
export class PointsComputeController {
  constructor(private readonly compute: PointsComputeService) {}

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

  /** GET /v1/admin/points-compute/export — OK rows as a credits-upload-format xlsx (→ offline approval → existing upload). */
  @Get('export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('points_rules:read')
  async export(@CurrentUser() user: JwtPayload, @Query() q: PreviewComputeDto): Promise<StreamableFile> {
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
