import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { LimitedFileInterceptor, MEDIA_UPLOAD_MAX_BYTES } from '../common/upload-limits';
import { PartnerService } from './partner.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CapturePayoutDetailsDto,
  ListPartnerTargetsQueryDto,
  UploadPartnerDocumentDto,
} from './dto/partner.dto';

/**
 * Partner self-service API — re-homed from platform/src/app/api/partner/* onto
 * /v1. Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC
 * via @RequirePermission (flag-gated). All routes are caller-scoped reads; no
 * @Roles gating since the source routes admitted all authenticated roles.
 * Responses are enveloped globally by TransformInterceptor.
 */
@Controller('partner')
@Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
export class PartnerController {
  constructor(private readonly partner: PartnerService) {}

  // `x-active-partner-id` (Wave 3 login picker): the active-outlet selector — a ChannelPartner id,
  // or absent for the login's own outlet. Re-authorized in the service (never trusted blind).
  @Get('me')
  getMe(
    @CurrentUser() user: JwtPayload,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.partner.getMe(user, activePartnerId);
  }

  @Get('banners')
  @RequirePermission('engagement:read')
  getBanners(@CurrentUser() user: JwtPayload) {
    return this.partner.getBanners(user);
  }

  @Get('payouts')
  @RequirePermission('payouts:read')
  getPayouts(
    @CurrentUser() user: JwtPayload,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.partner.getPayouts(user, activePartnerId);
  }

  @Get('targets')
  @RequirePermission('targets:read')
  getTargets(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListPartnerTargetsQueryDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.partner.getTargets(user, query, activePartnerId);
  }

  // Primary-KPI target-vs-achieved trend (last N months) for the dashboard chart.
  @Get('targets/trend')
  @RequirePermission('targets:read')
  getTargetTrend(
    @CurrentUser() user: JwtPayload,
    @Query('months') months?: string,
    @Query('kpi') kpi?: string,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.partner.getTargetTrend(user, months ? Number(months) : 24, kpi, activePartnerId);
  }

  // The caller's own assigned sales reps (Support page "Your Sales Team").
  // Caller- + tenant-scoped in the service; basic self-info, like /me.
  @Get('sales-team')
  getSalesTeam(
    @CurrentUser() user: JwtPayload,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.partner.getSalesTeam(user, activePartnerId);
  }

  // ── Capture-bank-at-redemption (PAYMENT-DETAILS-AT-REDEMPTION-DESIGN.md) ──────────
  // Partner-scoped cheque upload (cancelled cheque only) — partners can't reach the
  // KYC `kyc:initiate` doc route. Service gates the actual capture on the tenant flag.
  @Post('documents')
  @RequirePermission('rewards:read')
  @UseInterceptors(LimitedFileInterceptor('file', MEDIA_UPLOAD_MAX_BYTES))
  uploadPayoutDocument(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    // Validated (@IsIn CANCELLED_CHEQUE) by the global pipe; the cheque is the only partner doc.
    @Body() _dto: UploadPartnerDocumentDto,
  ) {
    return this.partner.uploadPayoutDocument(user, file);
  }

  // Self-capture bank/UPI in-flow at redemption. Feature-gated + uniqueness-enforced in the service.
  @Post('payout-details')
  @RequirePermission('rewards:read')
  capturePayoutDetails(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CapturePayoutDetailsDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.partner.capturePayoutDetails(user, dto, activePartnerId);
  }
}
