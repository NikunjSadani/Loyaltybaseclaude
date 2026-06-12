import {
  Controller, Get, Post, Body, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Roles }        from '../common/decorators/roles.decorator';
import { CurrentUser }  from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { LeaderboardService }         from './leaderboard.service';
import { CreateLeaderboardConfigDto } from './dto/leaderboard-admin.dto';

@Controller('leaderboard/configs')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class LeaderboardAdminController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  /** Admin: list all leaderboard configs for this client */
  @Get()
  listConfigs(@CurrentUser() user: JwtPayload) {
    return this.leaderboardService.listConfigs(user.clientId);
  }

  /** Admin: create a new leaderboard config */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createConfig(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateLeaderboardConfigDto,
  ) {
    return this.leaderboardService.createConfig(user.clientId, dto);
  }
}
