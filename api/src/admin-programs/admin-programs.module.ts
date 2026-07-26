import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { KycModule } from '../kyc/kyc.module';

import { ChannelPartnersController } from './channel-partners.controller';
import { VisibilityController } from './visibility.controller';
import { ReportsController } from './reports.controller';
import { BannersController } from './banners.controller';
import { BannerConfigController } from './banner-config.controller';

import { ChannelPartnersService } from './channel-partners.service';
import { VisibilityService } from './visibility.service';
import { ReportsService } from './reports.service';
import { BannersService } from './banners.service';
import { BannerConfigService } from './banner-config.service';

/**
 * Admin Programs — ONE module, MULTIPLE path-mirrored controllers, ported from
 * the platform's `src/app/api/admin/*` Next routes onto /v1 (S-phase backend).
 *
 * Sub-domains: channel-partners, visibility, reports, banners, banner-config.
 * Each maps to one @Controller('admin/<x>') + one service. Tenant-scoped by
 * clientId; @Roles / @RequirePermission per source. (The old admin scheme
 * enrollments-export controller/service was retired — the roster-anchored
 * SchemeReportController now owns the media-link export.)
 */
@Module({
  imports: [PrismaModule, KycModule],
  controllers: [
    ChannelPartnersController,
    VisibilityController,
    ReportsController,
    BannersController,
    BannerConfigController,
  ],
  providers: [
    ChannelPartnersService,
    VisibilityService,
    ReportsService,
    BannersService,
    BannerConfigService,
  ],
})
export class AdminProgramsModule {}
