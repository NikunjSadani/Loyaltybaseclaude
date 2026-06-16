import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ListCatalogQueryDto, ListOrdersQueryDto, UpdateOrderDto } from './dto/rewards.dto';

/**
 * Rewards & Redemption API — re-homed from platform/src/app/api/rewards/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated); GIFSY-only order update via @Roles. Responses
 * are enveloped globally by TransformInterceptor.
 *
 * NOTE: the source redeem + redeem/confirm routes are intentionally not ported
 * (OTP purpose + notifications infra absent from the canonical schema/api).
 */
@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Get('catalog')
  @RequirePermission('rewards:read')
  listCatalog(@CurrentUser() user: JwtPayload, @Query() query: ListCatalogQueryDto) {
    return this.rewards.listCatalog(user, query);
  }

  @Get('catalog/:id')
  @RequirePermission('rewards:read')
  getCatalogItem(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.rewards.getCatalogItem(user, id);
  }

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
}
