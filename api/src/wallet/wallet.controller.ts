import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { WalletService } from './wallet.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Public, Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { AdjustWalletDto, AdminOutletTxQueryDto, ListTransactionsQueryDto } from './dto/wallet.dto';

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
  getWallet(
    @CurrentUser() user: JwtPayload,
    // `x-active-partner-id` (Wave 3 login picker): the active-outlet selector. Re-authorized in the
    // service — a forged/foreign id can never surface another partner's wallet.
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.wallet.getWallet(user, activePartnerId);
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
  listTransactions(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListTransactionsQueryDto,
    // Wave 3 login picker selector (ignored on the GIFSY-admin ?userId= support path — see service).
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.wallet.listTransactions(user, query, activePartnerId);
  }

  /**
   * GET /v1/wallet/admin/outlet/:outletCode/summary — GIFSY-only wallet summary BY OUTLET.
   * Support/ops tooling: resolve any outlet's wallet by outlet CODE, tenant-scoped to the
   * operator's clientId (a foreign-tenant outlet code 404s). A pre-KYC outlet with no
   * partner yet returns hasWallet:false + a zeroed summary. Static `admin/outlet/...`
   * prefix — no collision with @Get()/@Get('transactions').
   */
  @Get('admin/outlet/:outletCode/summary')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('wallet:read')
  adminOutletWallet(@CurrentUser() user: JwtPayload, @Param('outletCode') outletCode: string) {
    return this.wallet.adminOutletWallet(user, outletCode);
  }

  /**
   * GET /v1/wallet/admin/outlet/:outletCode/transactions — GIFSY-only passbook BY OUTLET.
   * Same tenant-scope + pre-KYC (empty page) semantics as the summary route above.
   */
  @Get('admin/outlet/:outletCode/transactions')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('wallet:read')
  adminOutletTransactions(
    @CurrentUser() user: JwtPayload,
    @Param('outletCode') outletCode: string,
    @Query() query: AdminOutletTxQueryDto,
  ) {
    return this.wallet.adminOutletTransactions(user, outletCode, query);
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
