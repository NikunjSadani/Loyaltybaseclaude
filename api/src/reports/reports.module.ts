import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ScheduledReportsController } from './scheduled/scheduled-reports.controller';
import { ScheduledReportsService } from './scheduled/scheduled-reports.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TdsModule } from '../tds/tds.module';
import { FundModule } from '../fund/fund.module';
import { PointsEngineModule } from '../points-engine/points-engine.module';
import { PayoutTrackerController } from './payout-tracker/payout-tracker.controller';
import { PAYOUT_TRACKER_INPUT_SOURCE, PayoutTrackerSender } from './payout-tracker/payout-tracker.sender';
import { PayoutTrackerDataService } from './payout-tracker/payout-tracker.data.service';

// Msg91Service (used by ScheduledReportsService + PayoutTrackerSender) is exported from the @Global
// NotificationsModule, so it is injectable here without an explicit import.
@Module({
  // TdsModule: the digest's TDS section reads the 194R report (TdsService).
  // FundModule: the digest's per-client fund line + the daily low-balance e-mails (FundService).
  // PointsEngineModule: the payout tracker's data loader reads the engine's read-only preview (PointsComputeService).
  imports: [PrismaModule, TdsModule, FundModule, PointsEngineModule],
  controllers: [ReportsController, ScheduledReportsController, PayoutTrackerController],
  providers: [
    ReportsService,
    ScheduledReportsService,
    PayoutTrackerDataService,
    { provide: PAYOUT_TRACKER_INPUT_SOURCE, useExisting: PayoutTrackerDataService },
    PayoutTrackerSender,
  ],
})
export class ReportsModule {}
