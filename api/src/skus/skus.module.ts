import { Module } from '@nestjs/common';
import { SkusService }    from './skus.service';
import { SkusController } from './skus.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  controllers: [SkusController],
  providers:   [SkusService],
  exports:     [SkusService],
})
export class SkusModule {}
