import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RewardsService } from '../rewards/rewards.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  FulfilmentOrdersQueryDto,
  TransitionOrderDto,
  UpdateOrderDto,
} from '../rewards/dto/rewards.dto';

/**
 * Gift dispatch / fulfilment CONSOLE (Wave 1) — GIFSY ops, cross-tenant.
 *
 * A platform operator sees ALL tenants' gift orders (un-assumed OWNER → platformWide;
 * an assumed operator is pinned to that tenant), filters/ages them, stamps the
 * fulfilment channel/partner/tracking, and moves status through the SAME guarded
 * `transitionOrder` the per-order endpoint uses (edge-map, RedemptionStatusHistory,
 * timestamps, refund-on-cancel, member notifications, idempotent skip, Gifsy-only
 * DELIVERED→RETURNED value-reversal). No fulfilment logic is re-implemented here.
 *
 * GIFSY-only: @Roles('GIFSY_ADMIN') + the service's tenantScope boundary. Vendor-scoped
 * fulfilment is Wave 2 (the query DTO leaves a vendorId seam).
 */
@Controller('admin/gift-orders')
@Roles('GIFSY_ADMIN')
export class DispatchController {
  constructor(private readonly rewards: RewardsService) {}

  /** GET /v1/admin/gift-orders — cross-tenant fulfilment queue with channel-aware SLA aging. */
  @Get()
  @RequirePermission('rewards:manage_orders')
  listOrders(@CurrentUser() user: JwtPayload, @Query() q: FulfilmentOrdersQueryDto) {
    return this.rewards.listFulfilmentOrders(user, q);
  }

  /** GET /v1/admin/gift-orders/:id — console order detail (timeline + fulfilled-by context). */
  @Get(':id')
  @RequirePermission('rewards:manage_orders')
  getOrder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.rewards.getFulfilmentOrder(user, id);
  }

  /** PATCH /v1/admin/gift-orders/:id/fulfilment — non-status update (channel/partner/tracking/POD). */
  @Patch(':id/fulfilment')
  @RequirePermission('rewards:manage_orders')
  updateFulfilment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.rewards.updateOrder(user, id, dto);
  }

  /** POST /v1/admin/gift-orders/:id/transition — guarded status move (incl. DELIVERED→RETURNED). */
  @Post(':id/transition')
  @RequirePermission('rewards:manage_orders')
  transition(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: TransitionOrderDto,
  ) {
    return this.rewards.transitionOrder(user, id, dto);
  }
}
