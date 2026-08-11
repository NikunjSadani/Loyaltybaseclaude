import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ScheduledReportsController } from './scheduled/scheduled-reports.controller';
import { ScheduledReportsService } from './scheduled/scheduled-reports.service';
import { PrismaModule } from '../prisma/prisma.module';

// Msg91Service (used by ScheduledReportsService) is exported from the @Global NotificationsModule,
// so it is injectable here without an explicit import.
@Module({
  imports: [PrismaModule],
  controllers: [ReportsController, ScheduledReportsController],
  providers: [ReportsService, ScheduledReportsService],
})
export class ReportsModule {}
