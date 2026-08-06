import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { SchemeEnrollmentService } from './scheme-enrollment.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  AdminListEnrollmentsQueryDto,
  EnrollDto,
  RejectEnrollmentDto,
  ResubmitEnrollmentDto,
  SalesTargetsQueryDto,
  SendEnrollOtpDto,
  VerifyEnrollOtpDto,
} from './dto/scheme-enrollment.dto';

/**
 * Scheme Data-Collection — enrollment engine API (Wave-0/W1, §13.4).
 *
 * Mounted on the `schemes` prefix with sub-paths that DO NOT collide with the legacy
 * `SchemesController` routes (the partner-keyed `:id/enroll` + `:id/my-enrollment`
 * paths there are superseded by this stream — see the wiring note in the build report).
 *
 * Roles (all always-on RolesGuard):
 *   enroll / otp / my-enrollment / eligible / resubmit / media-upload → partner + sales
 *   reject / admin-list / admin-get                                   → GIFSY_ADMIN
 *   media-view                                                        → admin + partner + sales (tenant enforced in the service)
 */
const ENROLLER_ROLES = [
  'SSS',
  'WHOLESALER',
  'SUB_STOCKIST',
  'SALES_HO',
  'SALES_STATE_HEAD',
  'SALES_ASM',
  'SALES_SO',
  'SALES_ISR',
] as const;

@Controller('schemes')
export class SchemeEnrollmentController {
  constructor(private readonly enrollment: SchemeEnrollmentService) {}

  // ── Enrollee: eligible schemes for the active partner ──────────────────────
  @Get('enroll/eligible')
  @Roles(...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  eligible(
    @CurrentUser() user: JwtPayload,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.enrollment.getEligibleSchemes(user, activePartnerId);
  }

  // ── Sales rep: active in-window schemes (static path — no `:id` collision) ──
  @Get('sales/eligible')
  @Roles(...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  salesEligible(@CurrentUser() user: JwtPayload) {
    return this.enrollment.getSalesEligibleSchemes(user);
  }

  // ── Sales rep: reachable targets + status for one scheme ────────────────────
  @Get(':id/sales-targets')
  @Roles(...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  salesTargets(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: SalesTargetsQueryDto,
  ) {
    return this.enrollment.getSalesTargets(user, id, query);
  }

  // ── Enrollee: current enrollment for the active partner's roster row ────────
  @Get(':id/enrollment')
  @Roles(...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  myEnrollment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.enrollment.getMyEnrollment(user, id, activePartnerId);
  }

  // ── Phone-OTP consent (D16) ────────────────────────────────────────────────
  @Post(':id/enrollment/otp-send')
  @Roles(...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  otpSend(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SendEnrollOtpDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.enrollment.sendEnrollOtp(user, id, dto, activePartnerId);
  }

  @Post(':id/enrollment/otp-verify')
  @Roles(...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  otpVerify(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: VerifyEnrollOtpDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.enrollment.verifyEnrollOtp(user, id, dto, activePartnerId);
  }

  // ── Media upload (multipart) — magic-byte guarded, returns the stored key ───
  @Post(':id/enrollment/media')
  @Roles(...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  @UseInterceptors(FileInterceptor('file'))
  uploadMedia(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.enrollment.uploadMedia(user, file);
  }

  // ── Enroll (SELF / SALES) — versioned submit ───────────────────────────────
  @Post(':id/enrollment')
  @Roles(...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  enroll(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: EnrollDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.enrollment.enroll(user, id, dto, activePartnerId);
  }

  // ── Admin: auth-gated media stream (declared BEFORE the :enrollmentId GET so
  //          `media` is not swallowed by the param route). ─────────────────────
  @Get(':id/enrollments/media')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', ...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  async viewMedia(
    @CurrentUser() user: JwtPayload,
    @Query('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { bytes, contentType, inline } = await this.enrollment.viewMedia(user, key);
    const disposition = inline ? 'inline' : 'attachment; filename="media"';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(bytes, { type: contentType, disposition });
  }

  // ── Admin: captured-data list (D25) ────────────────────────────────────────
  // GIFSY_ADMIN (cross-tenant) OR a tenant CLIENT_ADMIN read-only. The service
  // HARD-SCOPES a non-GIFSY caller to their own tenant (loadScheme + clientId
  // filter), so a CLIENT_ADMIN only ever lists their own tenant's enrollments.
  @Get(':id/enrollments')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('schemes:read')
  adminList(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: AdminListEnrollmentsQueryDto,
  ) {
    return this.enrollment.adminListEnrollments(user, id, query);
  }

  // ── Admin: soft-deleted enrollments (the "Show deleted" recovery view) ─────
  // NOTE: declared BEFORE :enrollmentId so the literal `deleted` segment wins the match.
  @Get(':id/enrollments/deleted')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:read')
  adminListDeleted(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.enrollment.adminListDeletedEnrollments(user, id);
  }

  // ── Admin: single enrollment detail (values + media + geo + history) ───────
  // GIFSY_ADMIN OR a tenant CLIENT_ADMIN read-only. The detail lookup is pinned to
  // a scheme loaded in the caller's tenant, so a CLIENT_ADMIN cannot read another
  // tenant's enrollment (foreign id → 404). WRITE actions below stay GIFSY-only.
  @Get(':id/enrollments/:enrollmentId')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('schemes:read')
  adminGet(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    return this.enrollment.adminGetEnrollment(user, id, enrollmentId);
  }

  // ── Resubmit after a rejection (D10) ───────────────────────────────────────
  @Post(':id/enrollments/:enrollmentId/resubmit')
  @Roles(...ENROLLER_ROLES)
  @RequirePermission('schemes:read')
  resubmit(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('enrollmentId') enrollmentId: string,
    @Body() dto: ResubmitEnrollmentDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.enrollment.resubmit(user, id, enrollmentId, dto, activePartnerId);
  }

  // ── Admin: reject with reason (D10) ────────────────────────────────────────
  @Post(':id/enrollments/:enrollmentId/reject')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  reject(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('enrollmentId') enrollmentId: string,
    @Body() dto: RejectEnrollmentDto,
  ) {
    return this.enrollment.reject(user, id, enrollmentId, dto);
  }

  // ── Admin: edit a filled enrollment (append a new version) ──────────────────
  @Put(':id/enrollments/:enrollmentId')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  adminEdit(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('enrollmentId') enrollmentId: string,
    @Body() dto: ResubmitEnrollmentDto,
  ) {
    return this.enrollment.adminEditEnrollment(user, id, enrollmentId, dto);
  }

  // ── Admin: soft-delete a filled enrollment ─────────────────────────────────
  @Delete(':id/enrollments/:enrollmentId')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  adminDelete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    return this.enrollment.deleteEnrollment(user, id, enrollmentId);
  }

  // ── Admin: restore a soft-deleted enrollment ───────────────────────────────
  @Post(':id/enrollments/:enrollmentId/restore')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:write')
  adminRestore(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('enrollmentId') enrollmentId: string,
  ) {
    return this.enrollment.restoreEnrollment(user, id, enrollmentId);
  }
}
