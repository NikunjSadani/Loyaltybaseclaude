import { Module } from '@nestjs/common';
import { ContestsController } from './contests.controller';
import { EmployeeContestsController } from './employee-contests.controller';
import { ContestsService } from './contests.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';
import { TenantModule } from '../tenant/tenant.module';

/**
 * Employee Rewards Phase C — Contests. Additive module: admin CRUD + manual bonus credit
 * (/v1/admin/contests) and the rep read (/v1/rewards/employee/contests). Imports WalletModule
 * to reuse the AUDITED account-first credit primitive (creditEarnForAccount) — NO new
 * wallet-mutation path.
 */
@Module({
  imports: [PrismaModule, WalletModule, TenantModule],
  controllers: [ContestsController, EmployeeContestsController],
  providers: [ContestsService],
  exports: [ContestsService],
})
export class ContestsModule {}
