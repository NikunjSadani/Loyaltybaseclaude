import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VisibilityCaptureService } from './visibility-capture.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ResubmitCaptureDto, SubmitCaptureDto } from './dto/visibility-capture.dto';

/**
 * Visibility (POSM) SALES capture API — front-line sales roles (D8). Base path
 * `/v1/visibility`. The service enforces `visibilityEnabled` + PHOTO_APPROVAL mode +
 * allowed-level + downline reach (fail-closed); a non-allowed level can still read
 * status (canCapture:false) but a submit 403s.
 *
 * ROUTE ORDERING: static segments (`sales/eligible`, `capture`, `outlet/:outletId/status`,
 * `captures/:id/resubmit`) do not collide with Stream A's `captures/media` /
 * `config|form|outlets`. This controller owns NO bare `captures/:id` GET.
 */
const SALES_CAPTURE_ROLES = [
  'SALES_HO',
  'SALES_STATE_HEAD',
  'SALES_ASM',
  'SALES_SO',
  'SALES_ISR',
] as const;

@Controller('visibility')
@Roles(...SALES_CAPTURE_ROLES)
export class VisibilityCaptureController {
  constructor(private readonly capture: VisibilityCaptureService) {}

  // ── In-scope downline outlets + current-window status ──────────────────────
  @Get('sales/eligible')
  @RequirePermission('visibility:read')
  eligible(@CurrentUser() user: JwtPayload) {
    return this.capture.getSalesEligible(user);
  }

  // ── Active capture form schema (sales-safe read; GIFSY owns authoring) ───────
  @Get('sales/form')
  @RequirePermission('visibility:read')
  salesForm(@CurrentUser() user: JwtPayload) {
    return this.capture.getSalesForm(user);
  }

  // ── One outlet: all windows of the current month ───────────────────────────
  @Get('outlet/:outletId/status')
  @RequirePermission('visibility:read')
  outletStatus(@CurrentUser() user: JwtPayload, @Param('outletId') outletId: string) {
    return this.capture.getOutletStatus(user, outletId);
  }

  // ── Capture-photo upload (sales-reachable; returns the stored key for a CAMERA field) ──
  // The GIFSY `POST media` route (admin form-builder sample images) is unchanged; this is
  // the SALES capture-photo upload. Static two-segment path — no `:id` collision.
  @Post('sales/media')
  @RequirePermission('visibility:write')
  @UseInterceptors(FileInterceptor('file'))
  uploadMedia(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.capture.uploadCaptureMedia(user, file);
  }

  // ── Submit a capture (window-key + geo-fence computed server-side) ──────────
  @Post('capture')
  @RequirePermission('visibility:write')
  submit(@CurrentUser() user: JwtPayload, @Body() dto: SubmitCaptureDto) {
    return this.capture.submitCapture(user, dto);
  }

  // ── Resubmit after a rejection ─────────────────────────────────────────────
  @Post('captures/:id/resubmit')
  @RequirePermission('visibility:write')
  resubmit(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ResubmitCaptureDto,
  ) {
    return this.capture.resubmitCapture(user, id, dto);
  }
}
