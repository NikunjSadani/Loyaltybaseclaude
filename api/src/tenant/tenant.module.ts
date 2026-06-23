import { Global, Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { TenantSettingsService } from './tenant-settings.service';
import { TenantSettingsController } from './tenant-settings.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Global()   // Every module can inject TenantService / TenantSettingsService without re-importing
@Module({
  imports:     [PrismaModule],
  controllers: [TenantSettingsController],
  providers:   [TenantService, TenantSettingsService],
  exports:     [TenantService, TenantSettingsService],
})
export class TenantModule {}
