import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FundController } from './fund.controller';
import { FundService } from './fund.service';

/**
 * Fund reconciliation (FUND-RECONCILIATION-DESIGN.md). Msg91Service comes from the @Global NotificationsModule and
 * ExportsService from the @Global ExportsModule. FundService is exported for the Finance dashboard and the daily
 * scheduled-reports run (digest line + low-balance e-mails).
 */
@Module({
  imports: [PrismaModule],
  controllers: [FundController],
  providers: [FundService],
  exports: [FundService],
})
export class FundModule {}
