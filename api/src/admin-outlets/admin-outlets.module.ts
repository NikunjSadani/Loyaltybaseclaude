import { Module } from '@nestjs/common';
import { AdminOutletsController } from './admin-outlets.controller';
import { AdminOutletsService } from './admin-outlets.service';
import { ParentsController } from './parents.controller';
import { ParentsService } from './parents.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AdminOutletsController, ParentsController],
  providers: [AdminOutletsService, ParentsService],
})
export class AdminOutletsModule {}
