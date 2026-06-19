import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  ListCatalogQueryDto,
  ListOrdersQueryDto,
  RedeemConfirmDto,
  RedeemDto,
  TransitionOrderDto,
  UpdateOrderDto,
} from './dto/rewards.dto';

/**
 * Rewards & Redemption API — re-homed from platform/src/app/api/rewards/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated); GIFSY-only order management via @Roles.
 * Responses are enveloped globally by TransformInterceptor.
 *
 * 5.4a: the redeem + redeem/confirm routes ARE now ported (REDEMPTION_CONFIRM OTP
 * + notifications enqueue both exist in the canonical schema/api), plus a guarded
 * GIFSY-only status transition with inline voucher/tracking entry.
 *
 * PERMISSION NOTE: there is no `rewards:redeem` key in the catalog
 * (src/common/rbac/permissions.ts REWARDS = read/write/manage_inventory/
 * manage_orders). Partner redeem + confirm use the partner-facing `rewards:read`
 * (the same key already gating catalog/orders reads); GIFSY transition uses
 * `rewards:manage_orders`.
 */
@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Post('redeem')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('rewards:read')
  redeem(@CurrentUser() user: JwtPayload, @Body() dto: RedeemDto) {
    return this.rewards.redeem(user, dto);
  }

  @Post('redeem/confirm')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('rewards:read')
  confirmRedeem(@CurrentUser() user: JwtPayload, @Body() dto: RedeemConfirmDto) {
    return this.rewards.confirmRedeem(user, dto);
  }

  @Get('catalog')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('rewards:read')
  listCatalog(@CurrentUser() user: JwtPayload, @Query() query: ListCatalogQueryDto) {
    return this.rewards.listCatalog(user, query);
  }

  @Get('catalog/:id')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('rewards:read')
  getCatalogItem(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.rewards.getCatalogItem(user, id);
  }

  // Orders reads are multi-audience + self-scoping in the service (partner → own,
  // GIFSY → all-tenant, others → empty; getOrder additionally throws Forbidden for
  // a non-owner non-GIFSY). Intentionally NOT @Roles-gated: the admin Gift-Catalogue
  // Fulfilment tab (CLIENT_ADMIN) also reads this, and gating it to partners 403'd
  // that page. Safety is the service-layer scoping, not a role allowlist here.
  @Get('orders')
  @RequirePermission('rewards:read')
  listOrders(@CurrentUser() user: JwtPayload, @Query() query: ListOrdersQueryDto) {
    return this.rewards.listOrders(user, query);
  }

  @Get('orders/:id')
  @RequirePermission('rewards:read')
  getOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.rewards.getOrder(user, id);
  }

  /** GIFSY-only NON-STATUS edits (tracking / notes / voucher). Status moves go via POST :id/transition. */
  @Patch('orders/:id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('rewards:manage_orders')
  updateOrder(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.rewards.updateOrder(user, id, dto);
  }

  /** GIFSY-only guarded status transition (+ inline voucher/tracking + refund-on-cancel). */
  @Post('orders/:id/transition')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('rewards:manage_orders')
  transitionOrder(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: TransitionOrderDto,
  ) {
    return this.rewards.transitionOrder(user, id, dto);
  }
}
