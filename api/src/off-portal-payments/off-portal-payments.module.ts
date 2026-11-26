import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OffPortalPaymentsController } from './off-portal-payments.controller';
import { OffPortalPaymentsService } from './off-portal-payments.service';

/** Off-portal payments register (owner-approved 2026-11-25). Storage + TenantSettings are @Global. */
@Module({
  imports: [PrismaModule],
  controllers: [OffPortalPaymentsController],
  providers: [OffPortalPaymentsService],
})
export class OffPortalPaymentsModule {}
