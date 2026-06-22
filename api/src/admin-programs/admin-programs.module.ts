import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';

import { ChannelPartnersController } from './channel-partners.controller';
import { VisibilityController } from './visibility.controller';
import { ReportsController } from './reports.controller';
import { SchemesController } from './schemes.controller';
import { BannersController } from './banners.controller';
import { BannerConfigController } from './banner-config.controller';

import { ChannelPartnersService } from './channel-partners.service';
import { VisibilityService } from './visibility.service';
import { ReportsService } from './reports.service';
import { SchemesService } from './schemes.service';
import { BannersService } from './banners.service';
import { BannerConfigService } from './banner-config.service';

/**
 * Admin Programs — ONE module, MULTIPLE path-mirrored controllers, ported from
 * the platform's `src/app/api/admin/*` Next routes onto /v1 (S-phase backend).
 *
 * Sub-domains: channel-partners, visibility, reports, schemes,
 * banners, banner-config. Each maps to one @Controller('admin/<x>') + one
 * service. Tenant-scoped by clientId; @Roles / @RequirePermission per source.
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    ChannelPartnersController,
    VisibilityController,
    ReportsController,
    SchemesController,
    BannersController,
    BannerConfigController,
  ],
  providers: [
    ChannelPartnersService,
    VisibilityService,
    ReportsService,
    SchemesService,
    BannersService,
    BannerConfigService,
  ],
})
export class AdminProgramsModule {}
