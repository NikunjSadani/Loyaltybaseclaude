import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { KycService } from './kyc.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  BulkVerifyQueryDto,
  ConsentKycDto,
  CreateKycDto,
  FirstApproveKycDto,
  ListKycQueryDto,
  NotInterestedKycDto,
  RejectKycDto,
  UpdateKycDto,
  UploadKycDocumentDto,
  VerifyKycFieldDto,
} from './dto/kyc.dto';

/**
 * KYC & Enrollment API — re-homed from platform/src/app/api/kyc/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated); GIFSY-only routes via @Roles. Responses are
 * enveloped globally by TransformInterceptor.
 *
 * Static routes (consent, not-interested, sla-metrics) are declared before the
 * :id routes so Nest does not match them as an :id param.
 */
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @RequirePermission('kyc:read')
  list(@CurrentUser() user: JwtPayload, @Query() query: ListKycQueryDto) {
    return this.kyc.list(user, query);
  }

  @Post()
  @RequirePermission('kyc:initiate')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateKycDto) {
    return this.kyc.create(user, dto);
  }

  @Post('documents')
  @RequirePermission('kyc:initiate')
  @UseInterceptors(FileInterceptor('file'))
  uploadDocument(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadKycDocumentDto,
  ) {
    return this.kyc.uploadDocument(user, file, dto);
  }

  @Post('consent')
  @RequirePermission('kyc:initiate')
  consent(@CurrentUser() user: JwtPayload, @Body() dto: ConsentKycDto) {
    return this.kyc.consent(user, dto);
  }

  @Post('not-interested')
  @RequirePermission('kyc:initiate')
  notInterested(@CurrentUser() user: JwtPayload, @Body() dto: NotInterestedKycDto) {
    return this.kyc.notInterested(user, dto);
  }

  @Get('sla-metrics')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:read')
  slaMetrics(@CurrentUser() user: JwtPayload) {
    return this.kyc.slaMetrics(user);
  }

  @Get('review-dump')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:read')
  async reviewDump(@CurrentUser() user: JwtPayload): Promise<StreamableFile> {
    const buffer = await this.kyc.reviewDump(user);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="kyc-review-dump.xlsx"',
    });
  }

  /**
   * POST /v1/kyc/bulk-verify?apply=true|false
   *
   * Lane A bulk upload: parse a filled KYC review-dump xlsx and either preview
   * (apply=false, default) or commit (apply=true) field-level verification for
   * all PENDING_GIFSY submissions in this tenant.
   *
   * Gifsy-admin only.  File rides as multipart field `file`.
   * apply=false → dry-run, 0 DB writes, returns { updates, errors, summary }.
   * apply=true  → per-submission $transaction commit, returns { committed, results, errors, summary }.
   */
  @Post('bulk-verify')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:gifsy_approve')
  @UseInterceptors(FileInterceptor('file'))
  bulkVerify(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Query() query: BulkVerifyQueryDto,
  ) {
    return this.kyc.bulkVerify(user, file, query.apply === 'true');
  }

  @Get(':id')
  @RequirePermission('kyc:read')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.kyc.getOne(user, id);
  }

  @Patch(':id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:approve')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateKycDto) {
    return this.kyc.update(user, id, dto);
  }

  @Post(':id/first-approve')
  @RequirePermission('kyc:approve')
  firstApprove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: FirstApproveKycDto,
  ) {
    return this.kyc.firstApprove(user, id, dto);
  }

  /**
   * POST /v1/kyc/:id/verify — per-field portal verification (Lane B, Gifsy-only).
   * Body: { fieldKey, decision: 'APPROVED'|'REJECTED', remark? }
   * REJECTED requires a non-empty remark (validated in VerifyKycFieldDto).
   * Runs the bridge after the upsert; applies side-effects if all 7 are terminal.
   */
  @Post(':id/verify')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:gifsy_approve')
  verifyField(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: VerifyKycFieldDto,
  ) {
    return this.kyc.verifyField(user, id, dto);
  }

  @Post(':id/approve')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:gifsy_approve')
  approve(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.kyc.approve(user, id);
  }

  @Post(':id/reject')
  @RequirePermission('kyc:reject')
  reject(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: RejectKycDto) {
    return this.kyc.reject(user, id, dto);
  }

  @Get(':id/ledger')
  @RequirePermission('kyc:read')
  ledger(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.kyc.ledger(user, id);
  }
}
