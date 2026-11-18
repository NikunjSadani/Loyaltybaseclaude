import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type JwtPayload } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { assertNoActiveJobForImport } from './apply/apply-jobs-data';
import { assertSalesImportAccess, callerHasPermission, SalesImportPartGuard } from './sales-import-access';
import {
  SALES_IMPORT_PART_LIMIT_BYTES,
  type CreateSalesImportUploadResult,
  type SalesImportCombos,
  type SalesImportDetail,
  type SalesImportList,
  type SalesImportPartResult,
  type SalesImportSummary,
} from './sales-import.contract';
import { SalesImportRunnerService } from './ingest/sales-import-runner.service';
import { SalesImportUploadService } from './ingest/sales-import-upload.service';
import { CreateSalesImportUploadDto, ListSalesImportsQueryDto } from './ingest/sales-import-upload.dto';
import { HeavyOp } from '../common/heavy-op-limiter';

/**
 * Sales Import UPLOAD + READ routes (plan §5.2, tasks I-9 / I-10):
 *   POST   admin/sales-import/uploads                     targets:upload
 *   POST   admin/sales-import/:id/parts/:n                targets:upload (multipart `file`, ≤ SALES_IMPORT_PART_LIMIT_BYTES)
 *   POST   admin/sales-import/:id/complete                targets:upload
 *   POST   admin/sales-import/:id/reprocess               targets:upload
 *   POST   admin/sales-import/:id/cancel                  targets:upload (QUEUED / stalled PROCESSING → CANCELLED)
 *   POST   admin/sales-import/:id/reprocess-as-new        targets:upload (applied + mapping changed → NEW import)
 *   DELETE admin/sales-import/:id                         targets:upload
 *   GET    admin/sales-import                             targets:read
 *   GET    admin/sales-import/:id                         targets:read
 *   GET    admin/sales-import/:id/combos                  targets:read (`:id` may be `latest`)
 *   GET    admin/sales-import/:id/unmatched.csv | errors.xlsx   targets:read
 * OWNER: Lane I. Every handler calls assertSalesImportAccess(...) FIRST; import lookups are always scoped
 * by `clientId: user.clientId` (cross-tenant id → 404).
 * Registered AFTER the config/apply controllers (see SalesImportModule) so `GET :id` cannot shadow
 * `GET profile` / `GET kpis`.
 */
@Controller('admin/sales-import')
@Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
export class SalesImportController {
  constructor(
    readonly runner: SalesImportRunnerService,
    readonly tenant: TenantService,
    readonly prisma: PrismaService,
    readonly uploads: SalesImportUploadService,
    readonly gifsyRoles: GifsyRoleService,
  ) {}

  private gate(user: JwtPayload, write: boolean): Promise<void> {
    return assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write });
  }

  @Post('uploads')
  @RequirePermission('targets:upload')
  async createUpload(@CurrentUser() user: JwtPayload, @Body() body: CreateSalesImportUploadDto): Promise<CreateSalesImportUploadResult> {
    await this.gate(user, true);
    return this.uploads.createUpload(user, body);
  }

  /**
   * The global throttle (60/min per route per user) would 429 a fast 600 MB upload (150 parts); parts are
   * small, idempotent and size-checked, so this route allows 300/min.
   * S7: SalesImportPartGuard runs the access gate (flag uncached, operator rule) and the UPLOADING check BEFORE
   * FileInterceptor buffers the body (guards always run before interceptors).
   */
  @Post(':id/parts/:n')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @RequirePermission('targets:upload')
  @UseGuards(SalesImportPartGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SALES_IMPORT_PART_LIMIT_BYTES, files: 1 } }))
  async putPart(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('n') n: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<SalesImportPartResult> {
    return this.uploads.putPart(user, id, n, file);
  }

  @Post(':id/complete')
  @RequirePermission('targets:upload')
  async complete(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesImportSummary> {
    await this.gate(user, true);
    return this.uploads.complete(user, id);
  }

  @Post(':id/reprocess')
  @RequirePermission('targets:upload')
  async reprocess(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesImportSummary> {
    await this.gate(user, true);
    await assertNoActiveJobForImport(this.prisma, user.clientId, id); // A-L6: not while an apply of it runs
    return this.uploads.reprocess(user, id);
  }

  /** Applied import + changed mapping → a NEW import from the same stored file (re-audit M3). Returns the NEW summary. */
  @Post(':id/reprocess-as-new')
  @RequirePermission('targets:upload')
  async reprocessAsNew(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesImportSummary> {
    await this.gate(user, true);
    await assertNoActiveJobForImport(this.prisma, user.clientId, id); // A-L6: not while an apply of it runs
    return this.uploads.reprocessAsNew(user, id);
  }

  @Post(':id/cancel')
  @RequirePermission('targets:upload')
  async cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesImportSummary> {
    await this.gate(user, true);
    await assertNoActiveJobForImport(this.prisma, user.clientId, id); // A-L6: not while an apply of it runs
    return this.uploads.cancel(user, id);
  }

  @Delete(':id')
  @RequirePermission('targets:upload')
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesImportSummary> {
    await this.gate(user, true);
    await assertNoActiveJobForImport(this.prisma, user.clientId, id); // A-L6: not while an apply of it runs
    return this.uploads.remove(user, id);
  }

  @Get()
  @RequirePermission('targets:read')
  async list(@CurrentUser() user: JwtPayload, @Query() q: ListSalesImportsQueryDto): Promise<SalesImportList> {
    await this.gate(user, false);
    return this.uploads.list(user, q);
  }

  @Get(':id/combos')
  @RequirePermission('targets:read')
  async combos(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesImportCombos> {
    await this.gate(user, false);
    return this.uploads.combos(user, id);
  }

  @Get(':id/unmatched.csv')
  @RequirePermission('targets:read')
  async unmatchedCsv(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<StreamableFile> {
    await this.gate(user, false);
    const { stream, filename } = await this.uploads.unmatchedCsv(user, id);
    return new StreamableFile(stream, { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${filename}"` });
  }

  @Get(':id/errors.xlsx')
  @RequirePermission('targets:read')
  @HeavyOp()
  async errorsXlsx(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<StreamableFile> {
    await this.gate(user, false);
    const { buffer, filename } = await this.uploads.errorsXlsx(user, id);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get(':id')
  @RequirePermission('targets:read')
  async get(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesImportDetail> {
    await this.gate(user, false);
    const includeSamples = await callerHasPermission(user, 'targets:upload', { tenant: this.tenant, gifsyRoles: this.gifsyRoles });
    return this.uploads.get(user, id, { includeSamples });
  }
}
