import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  ListCatalogQueryDto,
  ListOrdersQueryDto,
  RedeemConfirmDto,
  RedeemDto,
  SalesRedeemConfirmDto,
  SalesRedeemDto,
  TransitionOrderDto,
  UpdateOrderDto,
} from './dto/rewards.dto';

/** Sales hierarchy roles that may redeem on behalf of an assigned outlet. */
const SALES_ROLES = [
  'SALES_HO',
  'SALES_STATE_HEAD',
  'SALES_ASM',
  'SALES_SO',
  'SALES_ISR',
] as const;

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

  // Wave 3 login-picker: `x-active-partner-id` names WHICH outlet's partner a
  // multi-outlet login is acting on (its own or a login-less same-group sibling).
  // The service re-authorizes it through resolveActivePartnerId — a bogus/foreign
  // id is rejected there (403), so it is never trusted blind. Absent → own partner.
  @Post('redeem')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('rewards:read')
  redeem(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RedeemDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.rewards.redeem(user, dto, activePartnerId);
  }

  @Post('redeem/confirm')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('rewards:read')
  confirmRedeem(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RedeemConfirmDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.rewards.confirmRedeem(user, dto, activePartnerId);
  }

  /** SALES-ASSISTED redeem (B1, #50-E) — a sales user redeems for an assigned outlet. */
  @Post('redeem-for-outlet')
  @Roles(...SALES_ROLES)
  @RequirePermission('rewards:read')
  redeemForOutlet(@CurrentUser() user: JwtPayload, @Body() dto: SalesRedeemDto) {
    return this.rewards.redeemForOutlet(user, dto);
  }

  /** SALES-ASSISTED redeem confirm — the OUTLET's OTP, submitted by the sales rep. */
  @Post('redeem-for-outlet/confirm')
  @Roles(...SALES_ROLES)
  @RequirePermission('rewards:read')
  confirmRedeemForOutlet(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SalesRedeemConfirmDto,
  ) {
    return this.rewards.confirmRedeemForOutlet(user, dto);
  }

  // Catalog browsing is for partners (self-redeem) AND sales reps (sales-assisted
  // redemption for an assigned outlet — B1). Tenant-scoped in the service.
  @Get('catalog')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST', ...SALES_ROLES)
  @RequirePermission('rewards:read')
  listCatalog(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListCatalogQueryDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.rewards.listCatalog(user, query, activePartnerId);
  }

  @Get('catalog/:id')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST', ...SALES_ROLES)
  @RequirePermission('rewards:read')
  getCatalogItem(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.rewards.getCatalogItem(user, id, activePartnerId);
  }

  // Orders reads are multi-audience + self-scoping in the service (partner → own,
  // GIFSY → all-tenant, others → empty; getOrder additionally throws Forbidden for
  // a non-owner non-GIFSY). Intentionally NOT @Roles-gated: the admin Gift-Catalogue
  // Fulfilment tab (CLIENT_ADMIN) also reads this, and gating it to partners 403'd
  // that page. Safety is the service-layer scoping, not a role allowlist here.
  @Get('orders')
  @RequirePermission('rewards:read')
  listOrders(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListOrdersQueryDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.rewards.listOrders(user, query, activePartnerId);
  }

  @Get('orders/:id')
  @RequirePermission('rewards:read')
  getOrder(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.rewards.getOrder(user, id, activePartnerId);
  }

  /** Member ORDER-TRACKING view (partner app) — own order status + tracking + timeline. */
  @Get('orders/:id/track')
  @RequirePermission('rewards:read')
  trackOrder(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.rewards.trackOrder(user, id, activePartnerId);
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
