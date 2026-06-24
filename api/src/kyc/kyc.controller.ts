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
  GstDetailsDto,
  ListKycQueryDto,
  NotInterestedKycDto,
  RejectKycDto,
  ReKycDto,
  SendConsentOtpDto,
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

  // Initiation is multi-actor (partner self / sales / admin); tenant-scoped + caller-scoped in the service.
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

  // Send the outlet-owner consent OTP (real MSG91 in prod; FIXED_OTP on staging).
  @Post('consent-otp')
  @RequirePermission('kyc:initiate')
  sendConsentOtp(@CurrentUser() user: JwtPayload, @Body() dto: SendConsentOtpDto) {
    return this.kyc.sendConsentOtp(user, dto);
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

  /**
   * GET /v1/kyc/phone-available?phone=<digits>
   *
   * Pre-submit uniqueness probe used by the new-KYC form: is this outlet-owner
   * phone already a SALES EMPLOYEE in THIS tenant? Tenant-scoped via the JWT
   * clientId in the service. Returns ONLY { available, conflictType } — no
   * employee PII. Static route declared before :id so Nest does not match it as
   * an :id param. Same gate as the other enrollment actions (kyc:initiate).
   */
  @Get('phone-available')
  @RequirePermission('kyc:initiate')
  phoneAvailable(@CurrentUser() user: JwtPayload, @Query('phone') phone: string) {
    return this.kyc.checkPhoneAvailable(user, phone ?? '');
  }

  @Get('sla-metrics')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:read')
  slaMetrics(@CurrentUser() user: JwtPayload) {
    return this.kyc.slaMetrics(user);
  }

  /**
   * GET /v1/kyc/review-queue
   *
   * Returns all PENDING_GIFSY submissions for this tenant with their 7-field
   * verification state, so the approvals UI can show queue items with n/7 progress
   * and per-field status without a separate detail fetch per row.
   *
   * Gifsy-admin only. Placed BEFORE the :id route to avoid param shadowing.
   */
  @Get('review-queue')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:read')
  reviewQueue(@CurrentUser() user: JwtPayload) {
    return this.kyc.reviewQueue(user);
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
  @Roles('SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR', 'CLIENT_ADMIN')
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
  @Roles('SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR', 'CLIENT_ADMIN')
  @RequirePermission('kyc:reject')
  reject(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: RejectKycDto) {
    return this.kyc.reject(user, id, dto);
  }

  @Get(':id/ledger')
  @RequirePermission('kyc:read')
  ledger(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.kyc.ledger(user, id);
  }

  /**
   * POST /v1/kyc/:id/re-kyc — manual re-KYC trigger (Task 3.6, Gifsy-only).
   * Body: { reason: string, fieldKeys?: KycFieldKey[] }
   * Transitions APPROVED → RE_KYC_REQUIRED; optionally sets reKycFlags on the
   * primary outlet. Notification enqueued post-tx (B1).
   * Permission: kyc:gifsy_approve (closest existing Gifsy-side gate action).
   */
  @Post(':id/re-kyc')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:gifsy_approve')
  reKyc(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReKycDto,
  ) {
    return this.kyc.reKyc(user, id, dto);
  }

  /**
   * POST /v1/kyc/:id/gst-details — capture entity/registration type (Task 3.4e, Gifsy-only).
   * Body: { entityType, gstRegistrationType, gstLegalName?, gstStatus? }
   * Sets the two enums on the submission's ChannelPartner (tenant-scoped).
   * Optional gstLegalName/gstStatus are stored in KycVerificationItem.evidence
   * for GST_VALIDATION — the clean seam that P6 lib/invoice will read.
   */
  @Post(':id/gst-details')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('kyc:gifsy_approve')
  gstDetails(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: GstDetailsDto,
  ) {
    return this.kyc.gstDetails(user, id, dto);
  }
}
