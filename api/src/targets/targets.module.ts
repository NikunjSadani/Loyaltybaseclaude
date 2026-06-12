import { Module } from '@nestjs/common';
import { TargetsService } from './targets.service';
import { TargetsController } from './targets.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  controllers: [TargetsController],
  providers:   [TargetsService],
  exports:     [TargetsService],
})
export class TargetsModule {}