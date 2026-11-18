import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesPreviewService } from './apply/sales-preview.service';
import { SalesApplyService } from './apply/sales-apply.service';
import { assertSalesImportAccess } from './sales-import-access';
import type { ApplyEnqueued, ApplyRequest, SalesApplyJobDto, SalesImportPreview } from './sales-import.contract';
import { NO_JOB_FOR_REQUEST, SalesApplyJobsService } from './apply/sales-apply-jobs.service';
import { SalesImportRunnerService } from './ingest/sales-import-runner.service';
import { HeavyOp } from '../common/heavy-op-limiter';

/**
 * Sales Import PREVIEW / APPLY routes (plan §5.2):
 *   GET  admin/sales-import/:id/preview   targets:read   → SalesImportPreview (READY only)
 *   POST admin/sales-import/:id/apply     targets:upload → 202 ApplyEnqueued (a BACKGROUND job, owner 2026-11-18; 409
 *                                         when a month already has an active job)
 *   GET  admin/sales-import/apply-jobs/:jobId          targets:read → SalesApplyJobDto (progress; apply AND recalculate)
 *   GET  admin/sales-import/apply-jobs?requestId=…     targets:read → SalesApplyJobDto (the page's resend lookup; 404)
 * OWNER: Lane K. Every handler calls assertSalesImportAccess(...) FIRST; the import is always looked
 * up WITH `clientId: user.clientId` (cross-tenant id → 404).
 */
@Controller('admin/sales-import')
@Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
export class SalesImportApplyController {
  constructor(
    readonly preview: SalesPreviewService,
    readonly apply: SalesApplyService,
    readonly tenant: TenantService,
    readonly prisma: PrismaService,
    readonly jobs: SalesApplyJobsService,
    readonly runner: SalesImportRunnerService,
  ) {}

  @Get(':id/preview')
  @RequirePermission('targets:read')
  @HeavyOp()
  async getPreview(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesImportPreview> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: false });
    return this.preview.preview(user.clientId, id);
  }

  @Post(':id/apply')
  @HttpCode(202)
  @RequirePermission('targets:upload')
  @HeavyOp()
  async postApply(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: ApplyRequest): Promise<ApplyEnqueued> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    const out = await this.jobs.enqueueApply(user, id, body);
    // Start the worker (Cloud Run Job, full CPU). Never throws; when it cannot start, the 10-min drain picks the job up.
    if (out.job.status === 'QUEUED') await this.runner.kick();
    return out;
  }

  @Get('apply-jobs/:jobId')
  @RequirePermission('targets:read')
  async getJob(@CurrentUser() user: JwtPayload, @Param('jobId') jobId: string): Promise<SalesApplyJobDto> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: false });
    return this.jobs.getJob(user.clientId, jobId);
  }

  @Get('apply-jobs')
  @RequirePermission('targets:read')
  async findJob(@CurrentUser() user: JwtPayload, @Query('requestId') requestId?: string): Promise<SalesApplyJobDto> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: false });
    if (!requestId) throw new BadRequestException('requestId is required.');
    const job = await this.jobs.findByRequestId(user.clientId, requestId);
    if (!job) throw new NotFoundException(NO_JOB_FOR_REQUEST);
    return job;
  }
}
