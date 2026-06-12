import { Module }                      from '@nestjs/common';
import { LeaderboardController }       from './leaderboard.controller';
import { LeaderboardAdminController }  from './leaderboard-admin.controller';
import { LeaderboardService }          from './leaderboard.service';

@Module({
  controllers: [LeaderboardController, LeaderboardAdminController],
  providers:   [LeaderboardService],
  exports:     [LeaderboardService],
})
export class LeaderboardModule {}
