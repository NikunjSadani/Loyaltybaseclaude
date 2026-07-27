import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { VisibilityReviewService } from './visibility-review.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { AdminListCapturesQueryDto, RejectCaptureDto } from './dto/visibility-capture.dto';

/**
 * Visibility (POSM) REVIEW API — GIFSY_ADMIN only (D12). Base path `/v1/visibility`.
 *
 * ROUTE-ORDERING NOTE for the module wiring: Stream A's `VisibilityAdminController`
 * owns the STATIC `GET captures/media` route. This controller's `GET captures/:id`
 * (param) MUST be registered AFTER `captures/media` so `media` is not swallowed by the
 * `:id` segment. Nest matches routes in controller-registration order, so in
 * VisibilityModule.controllers[] list VisibilityAdminController BEFORE
 * VisibilityReviewController. `GET captures` (list) and `GET captures/:id` here are
 * GIFSY-only, same as Stream A's media route — no role divergence.
 */
@Controller('visibility')
@Roles('GIFSY_ADMIN')
export class VisibilityReviewController {
  constructor(private readonly review: VisibilityReviewService) {}

  // ── Review queue: list (filters) — static `captures` path ──────────────────
  @Get('captures')
  @RequirePermission('visibility:read')
  list(@CurrentUser() user: JwtPayload, @Query() query: AdminListCapturesQueryDto) {
    return this.review.adminListCaptures(user, query);
  }

  // ── Single capture detail (values + media + geo + history + dup matches) ────
  @Get('captures/:id')
  @RequirePermission('visibility:read')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.review.adminGetCapture(user, id);
  }

  // ── Approve ────────────────────────────────────────────────────────────────
  @Post('captures/:id/approve')
  @RequirePermission('visibility:write')
  approve(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.review.approve(user, id);
  }

  // ── Reject with a controlled reason (re-opens the window) ──────────────────
  @Post('captures/:id/reject')
  @RequirePermission('visibility:write')
  reject(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RejectCaptureDto,
  ) {
    return this.review.reject(user, id, dto.reasonCode, dto.reason);
  }
}
