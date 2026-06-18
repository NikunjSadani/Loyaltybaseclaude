import { Module } from '@nestjs/common';
import { TdsController } from './tds.controller';
import { TdsService } from './tds.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TdsController],
  providers: [TdsService],
  exports: [TdsService],
})
export class TdsModule {}
