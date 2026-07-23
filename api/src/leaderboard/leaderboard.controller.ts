import { Controller, Get, Headers, Query } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ListLeaderboardQueryDto } from './dto/leaderboard.dto';

/**
 * Leaderboard API — re-homed from platform/src/app/api/leaderboard/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated). Responses are enveloped globally by
 * TransformInterceptor.
 */
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  @RequirePermission('engagement:read')
  list(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListLeaderboardQueryDto,
    @Headers('x-active-partner-id') activePartnerId?: string,
  ) {
    return this.leaderboard.list(user, query, activePartnerId);
  }
}
