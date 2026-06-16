import { Module } from '@nestjs/common';
import { AdminOutletsController } from './admin-outlets.controller';
import { AdminOutletsService } from './admin-outlets.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AdminOutletsController],
  providers: [AdminOutletsService],
})
export class AdminOutletsModule {}
