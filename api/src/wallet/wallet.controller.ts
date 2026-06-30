import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  Query,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { WalletService } from './wallet.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Public, Roles } from '../common/decorators/roles.decorator';
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
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
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
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
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

  /**
   * POST /v1/wallet/expire-sweep — Cloud-Scheduler-triggered points-expiry sweep.
   *
   * Mirrors POST /v1/push/drain: @Public (Cloud Scheduler carries no JWT) but gated by
   * a shared secret in the `x-expire-secret` header matched against EXPIRE_SWEEP_SECRET.
   * FAIL-CLOSED: if the env secret is unset the endpoint refuses, so it is never an open
   * trigger. expireDuePoints() is concurrency-safe + idempotent, so the worst case of a
   * leaked secret is an early sweep (identical to the GIFSY manual trigger) — no data
   * exposure (the body has no user input; the sweep only expires already-due EARN lots).
   */
  @Public()
  @Post('expire-sweep')
  async expireSweep(@Headers('x-expire-secret') secret?: string) {
    const expected = process.env.EXPIRE_SWEEP_SECRET;
    // Fail-closed: no configured secret → never an open trigger. Constant-time compare.
    if (!expected) throw new ForbiddenException('Expire sweep disabled');
    const got = Buffer.from(secret ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new ForbiddenException('Invalid expire secret');
    }
    const result = await this.wallet.expireDuePoints();
    return { ok: true, ...result };
  }
}
