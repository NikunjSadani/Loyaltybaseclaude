import { Module }                 from '@nestjs/common';
import { RewardsController }      from './rewards.controller';
import { RewardsAdminController } from './rewards-admin.controller';
import { RewardsService }         from './rewards.service';

@Module({
  controllers: [RewardsController, RewardsAdminController],
  providers:   [RewardsService],
  exports:     [RewardsService],
})
export class RewardsModule {}
