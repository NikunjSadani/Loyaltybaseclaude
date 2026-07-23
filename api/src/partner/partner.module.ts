import { Module } from '@nestjs/common';
import { PartnerController } from './partner.controller';
import { PartnerService } from './partner.service';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';
import { PrismaModule } from '../prisma/prisma.module';

// TenantService / TenantSettingsService are provided by the @Global TenantModule,
// so GroupService can inject TenantSettingsService without importing it here.
@Module({
  imports: [PrismaModule],
  controllers: [PartnerController, GroupController],
  providers: [PartnerService, GroupService],
})
export class PartnerModule {}
