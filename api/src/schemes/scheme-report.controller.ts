import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { SchemeReportService } from './scheme-report.service';
import { SchemeNotifyService } from './scheme-notify.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { BroadcastDto } from './dto/scheme-notify.dto';

/**
 * Scheme notifications + reports surface (Wave-0 data-collection).
 *
 * Shares the `schemes` base path with SchemesController (Nest registers routes
 * across controllers; the paths here are distinct sub-paths, no collision):
 *   - broadcast/broadcasts/report        → GIFSY_ADMIN only (D2/D29). RolesGuard
 *                                           is always-on, independent of the RBAC
 *                                           master flag.
 *   - report/tenant + enrollments/export → tenant admin read-only (D26/D30),
 *                                           permission-gated (schemes:read/export).
 * All service methods tenant-scope by the caller's clientId.
 */
@Controller('schemes')
export class SchemeReportController {
  constructor(
    private readonly reports: SchemeReportService,
    private readonly notify: SchemeNotifyService,
  ) {}

  // ── Notifications (D29) — GIFSY_ADMIN only ────────────────────────────────

  /** POST /v1/schemes/:id/broadcast — send an ad-hoc broadcast + log it. */
  @Post(':id/broadcast')
  @Roles('GIFSY_ADMIN')
  broadcast(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: BroadcastDto,
  ) {
    return this.notify.broadcast(user, id, dto);
  }

  /** POST /v1/schemes/:id/broadcast/preview — dry-run recipient count (no send, no log). */
  @Post(':id/broadcast/preview')
  @Roles('GIFSY_ADMIN')
  previewBroadcast(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: BroadcastDto,
  ) {
    return this.notify.previewBroadcast(user, id, dto);
  }

  /** GET /v1/schemes/:id/broadcasts — broadcast send history. */
  @Get(':id/broadcasts')
  @Roles('GIFSY_ADMIN')
  listBroadcasts(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.notify.listBroadcasts(user, id);
  }

  // ── Reports (D26) ─────────────────────────────────────────────────────────

  /** GET /v1/schemes/:id/report — full Gifsy admin report. */
  @Get(':id/report')
  @Roles('GIFSY_ADMIN')
  gifsyReport(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.reports.gifsyReport(user, id);
  }

  /** GET /v1/schemes/:id/report/tenant — tenant admin read-only report (D26). */
  @Get(':id/report/tenant')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('schemes:read')
  tenantReport(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.reports.tenantReport(user, id);
  }

  /**
   * GET /v1/schemes/:id/report/export — xlsx with auth-gated media links (D30).
   *
   * Mounted under `:id/report/...` (NOT `:id/enrollments/...`) so it never shadows
   * the enrollment stream's `:id/enrollments/:enrollmentId` param route. GIFSY-only:
   * this export surfaces raw captured values + media links; tenant admins use the
   * aggregate `:id/report/tenant` (no raw media/formValues).
   */
  @Get(':id/report/export')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('schemes:export')
  exportEnrollments(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    // Resolve the host the admin downloaded from so media links come back absolute
    // to the RIGHT tenant: edge-proxy `x-forwarded-host` (comma-list → first) →
    // `host` → PUBLIC_APP_BASE_URL's host → '' (relative fallback). Not
    // security-critical — the media endpoint re-authenticates; this only decides
    // where the click goes.
    const first = (h?: string) => (h ? h.split(',')[0].trim() : '');
    const fwd = req.headers['x-forwarded-host'];
    const host =
      first(Array.isArray(fwd) ? fwd[0] : fwd) ||
      first(req.headers.host) ||
      (process.env.PUBLIC_APP_BASE_URL ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') ||
      '';
    return this.reports.exportEnrollments(user, id, host);
  }
}
