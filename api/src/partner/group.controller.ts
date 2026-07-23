import { Controller, Get } from '@nestjs/common';
import { GroupService } from './group.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Partner GROUP overview API — Wave 3 read-only parent-group wallet roll-up.
 *
 * A small sub-feature alongside PartnerController (kept separate so it does not
 * collide with the partner self-service surface). Thin adapter: auth (JWT) +
 * tenant scope come from @CurrentUser(); RBAC mirrors the wallet surface
 * (@Roles partner roles + @RequirePermission('wallet:read')). READ-ONLY — no
 * mutations are exposed here.
 */
@Controller('partner/group')
export class GroupController {
  constructor(private readonly group: GroupService) {}

  /**
   * GET /v1/partner/group/wallet — consolidated wallet roll-up across the login's
   * group (when the login's phone owns a group parent), else `{ available: false }`.
   */
  @Get('wallet')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('wallet:read')
  getWalletRollup(@CurrentUser() user: JwtPayload) {
    return this.group.getWalletRollup(user);
  }
}
