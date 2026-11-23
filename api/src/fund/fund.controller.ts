import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, Res } from '@nestjs/common';
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
  SetBrandDiscountDto,
  UpdateFundAlertsDto,
} from './dto/fund.dto';

/**
 * Fund reconciliation API (FUND-RECONCILIATION-DESIGN.md). Tenant = the caller's (assumed) clientId.
 *  - Reads: Gifsy operators (owner; staff via their GifsyRole's payouts:read) + CLIENT_ADMIN of the OWN tenant
 *    (read-only, decision 8). MIS_USER / sales / partner roles are refused by @Roles.
 *  - Writes: Gifsy only — @Roles('GIFSY_ADMIN') (+ staff holding payouts:manage_fund, which CLIENT_ADMIN never has:
 *    it is GIFSY-operated) and the service re-checks isGifsyOperator. Every write is audited.
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

  @Get('settings')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('payouts:read')
  settings(@CurrentUser() user: JwtPayload) {
    return this.fund.settings(user);
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

  @Put('settings/alerts')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  updateAlerts(@CurrentUser() user: JwtPayload, @Body() dto: UpdateFundAlertsDto) {
    return this.fund.updateAlerts(user, dto);
  }

  @Post('rates/fee')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.CREATED)
  setAgencyFee(@CurrentUser() user: JwtPayload, @Body() dto: SetAgencyFeeDto) {
    return this.fund.setAgencyFee(user, dto);
  }

  @Post('rates/discount')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.CREATED)
  setBrandDiscount(@CurrentUser() user: JwtPayload, @Body() dto: SetBrandDiscountDto) {
    return this.fund.setBrandDiscount(user, dto);
  }
}
