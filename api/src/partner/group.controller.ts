import { Controller, Get, Query } from '@nestjs/common';
import { GroupService } from './group.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ListPartnerTargetsQueryDto } from './dto/partner.dto';
import { GroupVisibilityQueryDto } from './dto/group.dto';

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

  /**
   * GET /v1/partner/group/targets — consolidated per-outlet × KPI target/achievement/pace
   * roll-up + a group total per KPI, for the group's most-recent (or `?period=YYYY-MM`) month.
   * `{ available: false }` when the login owns no group parent.
   */
  @Get('targets')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('targets:read')
  getTargetsRollup(@CurrentUser() user: JwtPayload, @Query() query: ListPartnerTargetsQueryDto) {
    return this.group.getTargetsRollup(user, query);
  }

  /**
   * GET /v1/partner/group/visibility — per-outlet branding-visibility status + roll-up counts
   * for the group, for the current (or `?month=YYYY-MM`) month. Opt-in + fail-closed: returns
   * `{ visibilityEnabled: false }` (200) when the tenant switch is off. `engagement:read`
   * matches the leaderboard read surface (this is a read-only overview, not a data-entry path).
   */
  @Get('visibility')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('engagement:read')
  getVisibilityRollup(@CurrentUser() user: JwtPayload, @Query() query: GroupVisibilityQueryDto) {
    return this.group.getVisibilityRollup(user, query);
  }

  /**
   * GET /v1/partner/group/leaderboard — the group's partners' rows in the tenant's latest
   * published leaderboard snapshot (each `rank` is the tenant-wide rank). `{ snapshot: null }`
   * when nothing is published; `{ available: false }` when the login owns no group parent.
   */
  @Get('leaderboard')
  @Roles('SSS', 'WHOLESALER', 'SUB_STOCKIST')
  @RequirePermission('engagement:read')
  getLeaderboardRollup(@CurrentUser() user: JwtPayload) {
    return this.group.getLeaderboardRollup(user);
  }
}
