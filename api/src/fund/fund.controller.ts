import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ExportsService } from '../exports/exports.service';
import { FundService } from './fund.service';
import { FUND_RECONCILIATION_KIND_ID } from './fund-reconciliation.kind';
import {
  FundExportQueryDto,
  FundStatementQueryDto,
  RecordFundAdjustmentDto,
  RecordFundReceiptDto,
  RecordOpeningBalanceDto,
  SetAgencyFeeDto,
  SetItemDiscountDto,
  UpdateFundAlertsDto,
} from './dto/fund.dto';

/**
 * Fund reconciliation API (FUND-RECONCILIATION-DESIGN.md) — the CLIENT's view, tenant = the caller's (assumed)
 * clientId.
 *  - Reads: Gifsy operators (owner; staff holding payouts:read) + CLIENT_ADMIN of the OWN tenant (read-only,
 *    decision 8). MIS_USER / sales / partner roles are refused by @Roles.
 *  - Writes (receipts / adjustments / opening balance): Gifsy only — @Roles('GIFSY_ADMIN') (+ staff holding
 *    payouts:manage_fund, which CLIENT_ADMIN never has: it is GIFSY-operated) and the service re-checks the
 *    permission. Settings live in the Gifsy console (FundConsoleController, owner D6); GET settings here is read-only.
 */
@Controller('fund')
export class FundController {
  constructor(
    private readonly fund: FundService,
    private readonly exports: ExportsService,
  ) {}

  @Get('summary')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('payouts:read')
  summary(@CurrentUser() user: JwtPayload) {
    return this.fund.summary(user);
  }

  @Get('statement')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('payouts:read')
  statement(@CurrentUser() user: JwtPayload, @Query() q: FundStatementQueryDto) {
    return this.fund.statement(user, q);
  }

  @Get('entries')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('payouts:read')
  entries(@CurrentUser() user: JwtPayload) {
    return this.fund.entries(user);
  }

  /** Read-only: the settings are managed in the Gifsy console (owner D6). */
  @Get('settings')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('payouts:read')
  settings(@CurrentUser() user: JwtPayload) {
    return this.fund.tenantSettings(user);
  }

  /** Excel "Fund reconciliation" (Summary / Statement / Receipts / Rates / About) via the Downloads mechanism. */
  @Get('export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('payouts:read')
  export(@CurrentUser() user: JwtPayload, @Query() q: FundExportQueryDto, @Res({ passthrough: true }) res: Response) {
    this.fund.tenantOf(user);
    return this.exports.respond(res, user, FUND_RECONCILIATION_KIND_ID, q);
  }

  @Post('receipts')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.CREATED)
  recordReceipt(@CurrentUser() user: JwtPayload, @Body() dto: RecordFundReceiptDto) {
    return this.fund.recordReceipt(user, dto);
  }

  @Post('adjustments')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.CREATED)
  recordAdjustment(@CurrentUser() user: JwtPayload, @Body() dto: RecordFundAdjustmentDto) {
    return this.fund.recordAdjustment(user, dto);
  }

  @Post('opening-balance')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.CREATED)
  recordOpening(@CurrentUser() user: JwtPayload, @Body() dto: RecordOpeningBalanceDto) {
    return this.fund.recordOpening(user, dto);
  }
}

/**
 * Gifsy console — a client's Fund settings (owner D6, 2026-11-23): agency fee + history, voucher ITEM discounts +
 * history, low-balance threshold + recipients. Targets the client by slug (the console works un-assumed). Gifsy
 * operators only: GIFSY_ADMIN, or GIFSY_STAFF holding the permission AND a tenant grant for the client (service).
 * Back-dated rates need a preview + confirm (owner D1) — enforced in FundService.saveRate.
 */
@Controller('gifsy/clients/:slug/fund')
export class FundConsoleController {
  constructor(private readonly fund: FundService) {}

  @Get()
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:read')
  get(@CurrentUser() user: JwtPayload, @Param('slug') slug: string) {
    return this.fund.consoleSettings(user, slug);
  }

  @Put('alerts')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  updateAlerts(@CurrentUser() user: JwtPayload, @Param('slug') slug: string, @Body() dto: UpdateFundAlertsDto) {
    return this.fund.updateAlerts(user, slug, dto);
  }

  /** 200 { requiresConfirmation, preview, confirmToken } for a back-dated rate; 200 { saved } otherwise. */
  @Post('rates/fee')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.OK)
  setAgencyFee(@CurrentUser() user: JwtPayload, @Param('slug') slug: string, @Body() dto: SetAgencyFeeDto) {
    return this.fund.setAgencyFee(user, slug, dto);
  }

  @Post('rates/discount')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.OK)
  setItemDiscount(@CurrentUser() user: JwtPayload, @Param('slug') slug: string, @Body() dto: SetItemDiscountDto) {
    return this.fund.setItemDiscount(user, slug, dto);
  }
}
