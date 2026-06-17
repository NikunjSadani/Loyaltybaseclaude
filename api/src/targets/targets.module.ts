import { Module } from '@nestjs/common';
import { KpisController, TargetsController, AchievementsController } from './targets.controller';
import { TargetsService } from './targets.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [KpisController, TargetsController, AchievementsController],
  providers: [TargetsService],
  exports: [TargetsService],
})
export class TargetsModule {}
