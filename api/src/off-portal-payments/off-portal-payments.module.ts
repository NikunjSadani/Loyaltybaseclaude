import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CreditsModule } from '../credits/credits.module';
import { OffPortalPaymentsController } from './off-portal-payments.controller';
import { OffPortalPaymentsService } from './off-portal-payments.service';

/**
 * Off-portal payments register (owner-approved 2026-11-25). Storage + TenantSettings are @Global; CreditsService raises
 * the 194C gross-up TDS invoice / recovery through the payout engine when payments are recorded (owner 2026-11-26).
 */
@Module({
  imports: [PrismaModule, CreditsModule],
  controllers: [OffPortalPaymentsController],
  providers: [OffPortalPaymentsService],
})
export class OffPortalPaymentsModule {}
