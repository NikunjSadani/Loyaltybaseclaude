import { Global, Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { PrismaModule } from '../prisma/prisma.module';

@Global()   // Every module can inject TenantService without re-importing
@Module({
  imports:   [PrismaModule],
  providers: [TenantService],
  exports:   [TenantService],
})
export class TenantModule {}
