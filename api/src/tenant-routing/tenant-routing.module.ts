import { Module } from '@nestjs/common';
import { TenantRoutingController } from './tenant-routing.controller';
import { TenantRoutingService } from './tenant-routing.service';

// PrismaService is provided by the @Global() PrismaModule, so no import needed.
@Module({
  controllers: [TenantRoutingController],
  providers: [TenantRoutingService],
})
export class TenantRoutingModule {}
