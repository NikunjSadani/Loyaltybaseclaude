import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PaymentsReportService, PaymentsReportScope } from './payments-report.service';
import { ExportsService } from '../exports/exports.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PaymentsReportPageQueryDto, PaymentsReportQueryDto } from './dto/payments-report.dto';

/**
 * Payments Report controller — a READ-ONLY report of all payout PAYMENTS in a date range, across
 * ALL payout streams (visibility 194C + incentive/standard).
 *
 *   GET /v1/admin/payments-report[/export]   — CLIENT_ADMIN (own tenant) or GIFSY_ADMIN (any)
 *
 * Tenant scope is resolved HERE from the JWT, never trusted from the query (mirrors
 * tds-reports.controller): a CLIENT_ADMIN — and an ASSUMED GIFSY operator — is always pinned to
 * their own/assumed clientId (any ?clientId= is ignored), so a tenant admin can never read another
 * tenant's payments; an un-assumed GIFSY_ADMIN may pass ?clientId= to scope to one tenant or omit
 * it for platform-wide.
 */
@Controller('admin/payments-report')
export class PaymentsReportController {
  constructor(
    private readonly reports: PaymentsReportService,
    private readonly exports: ExportsService,
  ) {}

  /**
   * The effective tenant scope: platform-wide (un-assumed GIFSY) → ?clientId= if supplied else
   * undefined; everyone else (CLIENT_ADMIN or ASSUMED operator) → own clientId, query ignored.
   * Mirrors tds-reports.controller.resolveClientId exactly.
   */
  private resolveClientId(user: JwtPayload, queryClientId?: string): string | undefined {
    return platformWide(user) ? queryClientId : user.clientId;
  }

  @Get()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('reports:read')
  paymentsReport(@CurrentUser() user: JwtPayload, @Query() q: PaymentsReportPageQueryDto) {
    // One page (?page=&pageSize=, default 1 / 50, max 200) + whole-range DB totals — see PaymentsReportService.
    const scope: PaymentsReportScope = {
      clientId: this.resolveClientId(user, q.clientId),
      from: q.from,
      to: q.to,
      status: q.status,
      ...(q.page !== undefined ? { page: q.page } : {}),
      ...(q.pageSize !== undefined ? { pageSize: q.pageSize } : {}),
    };
    return this.reports.paymentReport(scope);
  }

  @Get('export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('reports:read')
  paymentsReportExport(
    @CurrentUser() user: JwtPayload,
    @Query() q: PaymentsReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // 'payments-report' export kind — same scope rule (resolved from the JWT inside the kind); EVERY matching row,
    // streamed page by page (ranges over 31 days / open-ended → 202, prepared on the Downloads page).
    return this.exports.respond(res, user, 'payments-report', q);
  }
}
