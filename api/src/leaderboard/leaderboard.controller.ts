import {
  Controller, Get, Post, Patch, Param, Query,
} from '@nestjs/common';
import { Roles }                from '../common/decorators/roles.decorator';
import { CurrentUser }          from '../common/decorators/current-user.decorator';
import type { JwtPayload }      from '../common/decorators/current-user.decorator';
import { LeaderboardService }   from './leaderboard.service';

@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  /** Get latest published leaderboard snapshot */
  @Get()
  getLeaderboard(
    @CurrentUser() user: JwtPayload,
    @Query('configId') configId?: string,
    @Query('page')     page?:     string,
    @Query('limit')    limit?:    string,
  ) {
    return this.leaderboardService.getLeaderboard(user.clientId, {
      configId,
      page:  page  ? parseInt(page, 10)  : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Admin: compute a new snapshot for a leaderboard config */
  @Post('configs/:configId/compute')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  computeSnapshot(
    @CurrentUser() user: JwtPayload,
    @Param('configId') configId: string,
  ) {
    return this.leaderboardService.computeSnapshot(configId, user.clientId);
  }

  /** Admin: publish a snapshot so it's visible to partners */
  @Patch('snapshots/:snapshotId/publish')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  publishSnapshot(
    @CurrentUser() user: JwtPayload,
    @Param('snapshotId') snapshotId: string,
  ) {
    return this.leaderboardService.publishSnapshot(snapshotId, user.clientId);
  }
}
