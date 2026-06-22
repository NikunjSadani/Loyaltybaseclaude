/**
 * TargetsController — P4 Stream T.
 *
 * Routes (all under /v1/admin):
 *
 *   KpiDef CRUD (admin-only):
 *     GET    /v1/admin/kpis                    list tenant KPIs
 *     POST   /v1/admin/kpis                    upsert a KPI by (clientId, code)
 *     DELETE /v1/admin/kpis/:id                delete a KPI
 *     POST   /v1/admin/kpis/seed-defaults      seed Deoleo default KPIs (no-op if any exist)
 *
 *   Targets:
 *     GET    /v1/admin/targets/template        download .xlsx template (query: months=YYYY-MM,…)
 *     POST   /v1/admin/targets/upload          multipart xlsx upload → verbatim write
 *     GET    /v1/admin/targets/batches         list upload batches
 *     GET    /v1/admin/targets                 list target rows (query: month=YYYY-MM)
 *
 *   Achievements:
 *     POST   /v1/admin/achievements/upload     multipart xlsx upload → verbatim write (OutletSalesRecord)
 *     GET    /v1/admin/achievements/batches    list SalesUploadBatch records
 *     GET    /v1/admin/achievements            list OutletSalesRecord rows (query: month=YYYY-MM)
 *     GET    /v1/admin/achievements/pace       target + achievement + pace per outlet × KPI (query: month=YYYY-MM)
 *
 * Thin adapter: auth + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission. StreamableFile is passed through the global interceptor unwrapped.
 */

import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Body,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { TargetsService } from './targets.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  ListKpisQueryDto,
  UpsertKpiDefDto,
  TemplateQueryDto,
  ListBatchesQueryDto,
  ListTargetsQueryDto,
  ListAchievementBatchesQueryDto,
  ListAchievementsQueryDto,
  PaceQueryDto,
  AchievementTemplateQueryDto,
} from './dto/targets.dto';

// ─── KPI CRUD ─────────────────────────────────────────────────────────────────

@Controller('admin/kpis')
export class KpisController {
  constructor(private readonly targets: TargetsService) {}

  /** GET /v1/admin/kpis — list tenant KPIs (optionally filter to enabled only). */
  @Get()
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  listKpis(@CurrentUser() user: JwtPayload, @Query() q: ListKpisQueryDto) {
    return this.targets.listKpis(user, q);
  }

  /**
   * POST /v1/admin/kpis/seed-defaults
   * Must come BEFORE the generic POST / to avoid matching 'seed-defaults' as a body
   * and before the @Body() route which also uses POST /.
   * Placed at a distinct URL so there is no routing ambiguity.
   */
  @Post('seed-defaults')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:manage_config')
  seedDefaults(@CurrentUser() user: JwtPayload) {
    return this.targets.seedDeoleoKpis(user);
  }

  /** POST /v1/admin/kpis — upsert a KPI (create if missing, update if exists). */
  @Post()
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:manage_config')
  upsertKpi(@CurrentUser() user: JwtPayload, @Body() dto: UpsertKpiDefDto) {
    return this.targets.upsertKpi(user, dto);
  }

  /**
   * POST /v1/admin/kpis/:id/set-primary
   * Make this KPI the SINGLE primary for the tenant — choosing a primary MOVES it.
   * Mirrors upsertKpi's guards.
   */
  @Post(':id/set-primary')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:manage_config')
  setPrimary(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.targets.setPrimary(user, id);
  }

  /** DELETE /v1/admin/kpis/:id — remove a KPI definition. */
  @Delete(':id')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:manage_config')
  deleteKpi(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.targets.deleteKpi(user, id);
  }
}

// ─── Targets ──────────────────────────────────────────────────────────────────

@Controller('admin/targets')
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  /**
   * GET /v1/admin/targets/template?months=2026-07,2026-08
   * Streams an xlsx template pre-filled with the outlet roster.
   * KPI columns are the tenant's enabled KpiDefs.
   */
  @Get('template')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  async getTemplate(
    @CurrentUser() user: JwtPayload,
    @Query() q: TemplateQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const buffer = await this.targets.getTemplateBuffer(user, q);
    const filename = `target-template-${q.months.replace(/,/g, '_')}.xlsx`;
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /**
   * GET /v1/admin/targets/export?month=YYYY-MM
   * Streams a "final targets" xlsx: the stored OutletTarget values per outlet for
   * the month, verbatim (no compute). Blank cell = KPI not configured.
   */
  @Get('export')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  async exportTargets(
    @CurrentUser() user: JwtPayload,
    @Query('month') month: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const buffer = await this.targets.exportTargetsBuffer(user, month);
    const filename = `final-targets-${month}.xlsx`;
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /**
   * POST /v1/admin/targets/upload  (multipart/form-data, field: "file")
   * Parses the xlsx, validates against KpiDefs + outlet roster, and writes
   * OutletTarget rows inside a TargetUploadBatch. Blank cell = omitted key.
   */
  @Post('upload')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB ceiling — bound memory on parse
      fileFilter: (_req, file, cb) =>
        /\.(xlsx|xls)$/i.test(file.originalname)
          ? cb(null, true)
          : cb(new BadRequestException('Only .xlsx/.xls files are accepted'), false),
    }),
  )
  uploadTargets(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.targets.uploadTargets(user, file);
  }

  /** GET /v1/admin/targets/batches — list upload batches (optionally filter by month). */
  @Get('batches')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  listBatches(@CurrentUser() user: JwtPayload, @Query() q: ListBatchesQueryDto) {
    return this.targets.listBatches(user, q);
  }

  /** GET /v1/admin/targets?month=YYYY-MM — list stored target rows. */
  @Get()
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  listTargets(@CurrentUser() user: JwtPayload, @Query() q: ListTargetsQueryDto) {
    return this.targets.listTargets(user, q);
  }
}

// ─── Achievements ─────────────────────────────────────────────────────────────

/**
 * Achievements controller — extends the targets module with the achievement
 * (sales) side.  Same pattern as TargetsController but writes/reads
 * OutletSalesRecord / SalesUploadBatch.
 *
 * Routes:
 *   POST   /v1/admin/achievements/upload   multipart xlsx → OutletSalesRecord (verbatim)
 *   GET    /v1/admin/achievements/batches  list SalesUploadBatch records
 *   GET    /v1/admin/achievements/pace     pace view: target + achievement + pace per KPI
 *   GET    /v1/admin/achievements          list OutletSalesRecord rows
 */
@Controller('admin/achievements')
export class AchievementsController {
  constructor(private readonly targets: TargetsService) {}

  /**
   * GET /v1/admin/achievements/template?month=YYYY-MM
   * Streams the achievement (sales) upload template — the SAME month-group
   * 2-row layout as the target template, pre-filled with the REAL tenant
   * outlet roster + enabled KpiDef columns. Filling this in and POSTing to
   * /upload round-trips cleanly (the old FE generateSalesTemplate is retired).
   * Must come BEFORE the generic @Get() to avoid routing ambiguity.
   */
  @Get('template')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  async getAchievementTemplate(
    @CurrentUser() user: JwtPayload,
    @Query() q: AchievementTemplateQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const buffer = await this.targets.buildAchievementTemplate(user, q.month);
    const filename = `sales-template-${q.month}.xlsx`;
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /**
   * POST /v1/admin/achievements/upload  (multipart/form-data, field: "file")
   * Parses the xlsx (same template shape as target upload), validates against
   * KpiDefs + outlet roster, and writes OutletSalesRecord rows inside a
   * SalesUploadBatch.  Blank cell = omitted key; 0 stored verbatim; NO compute.
   */
  @Post('upload')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB ceiling
      fileFilter: (_req, file, cb) =>
        /\.(xlsx|xls)$/i.test(file.originalname)
          ? cb(null, true)
          : cb(new BadRequestException('Only .xlsx/.xls files are accepted'), false),
    }),
  )
  uploadAchievements(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.targets.uploadAchievements(user, file);
  }

  /**
   * GET /v1/admin/achievements/batches — list SalesUploadBatch records.
   * Must come BEFORE the generic @Get() to avoid routing ambiguity.
   */
  @Get('batches')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  listAchievementBatches(@CurrentUser() user: JwtPayload, @Query() q: ListAchievementBatchesQueryDto) {
    return this.targets.listAchievementBatches(user, q);
  }

  /**
   * GET /v1/admin/achievements/pace?month=YYYY-MM[&outletCode=XXX]
   * Returns per-outlet pace: target + achievement + pace (achieved÷target) per KPI.
   * pace=null when target is absent or 0 (divide-by-zero guard).
   * Must come BEFORE the generic @Get() to avoid routing ambiguity.
   */
  @Get('pace')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  getPace(@CurrentUser() user: JwtPayload, @Query() q: PaceQueryDto) {
    return this.targets.getPace(user, q);
  }

  /** GET /v1/admin/achievements?month=YYYY-MM — list stored achievement rows. */
  @Get()
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  listAchievements(@CurrentUser() user: JwtPayload, @Query() q: ListAchievementsQueryDto) {
    return this.targets.listAchievements(user, q);
  }

  /**
   * DELETE /v1/admin/achievements/batches/:id — delete an upload batch and its
   * OutletSalesRecord rows (cascade via schema onDelete: Cascade). Lets an admin
   * remove TEST uploads before go-live. Tenant-scoped; 404 if the batch isn't this
   * tenant's. (Replaces the dead FE call to the non-existent /admin/sales/batches/:id.)
   */
  @Delete('batches/:id')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:upload')
  deleteAchievementBatch(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.targets.deleteAchievementBatch(user, id);
  }
}
