import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { AdjustWalletDto, ListTransactionsQueryDto } from './dto/wallet.dto';

/**
 * Wallet & Points API — re-homed from platform/src/app/api/wallet/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated); GIFSY-only adjust via @Roles. Responses are
 * enveloped globally by TransformInterceptor.
 */
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @RequirePermission('wallet:read')
  getWallet(@CurrentUser() user: JwtPayload) {
    return this.wallet.getWallet(user);
  }

  @Post('adjust')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('wallet:adjust')
  adjust(@CurrentUser() user: JwtPayload, @Body() dto: AdjustWalletDto) {
    return this.wallet.adjust(user, dto);
  }

  @Get('transactions')
  @RequirePermission('wallet:read')
  listTransactions(@CurrentUser() user: JwtPayload, @Query() query: ListTransactionsQueryDto) {
    return this.wallet.listTransactions(user, query);
  }

  /**
   * POST /v1/wallet/expire — GIFSY-only manual trigger for the expiry sweep.
   * Idempotent + safe to re-run. Scheduling (cron) is deferred to P7/infra; this
   * lets ops run it on demand until a job is wired up.
   */
  @Post('expire')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('wallet:adjust')
  expireDuePoints() {
    return this.wallet.expireDuePoints();
  }
}
