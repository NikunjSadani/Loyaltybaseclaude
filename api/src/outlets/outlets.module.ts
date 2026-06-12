import { Module } from '@nestjs/common';
import { OutletsService }    from './outlets.service';
import { OutletsController } from './outlets.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  controllers: [OutletsController],
  providers:   [OutletsService],
  exports:     [OutletsService],
})
export class OutletsModule {}
