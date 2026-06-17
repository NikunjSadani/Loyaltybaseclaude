import { Module } from '@nestjs/common';
import { KpisController, TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [KpisController, TargetsController],
  providers: [TargetsService],
  exports: [TargetsService],
})
export class TargetsModule {}
