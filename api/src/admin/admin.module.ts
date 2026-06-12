import { Module } from '@nestjs/common';
import { AdminController }         from './admin.controller';
import { OutletTypeConfigService } from './outlet-type-config.service';
import { PrismaModule }            from '../prisma/prisma.module';
import { UsersModule }             from '../users/users.module';
// TenantModule is @Global(), so TenantService is available without re-importing it here.

@Module({
  imports:     [PrismaModule, UsersModule],
  controllers: [AdminController],
  providers:   [OutletTypeConfigService],
  exports:     [OutletTypeConfigService],
})
export class AdminModule {}
