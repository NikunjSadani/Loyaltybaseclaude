import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { HelpAdminController, HelpMediaController, PartnerHelpController, SalesHelpController } from './help.controller';
import { HelpAdminService } from './help-admin.service';
import { HelpMemberService } from './help-member.service';
import { HelpMediaService } from './help-media.service';
import { HelpMediaLimiter } from './help-media-limiter';

/**
 * Help & videos (Bajaj, tenant flag `helpVideos`). StorageService + TenantService are @Global. JwtModule is
 * re-registered with the same secret as AuthModule (mirrors SchemesModule / KycModule) so HelpMediaService can
 * mint + verify the media-view token without importing AuthModule (avoids a module cycle).
 * See platform/docs/plans/HELP-VIDEOS.md.
 */
@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.get('JWT_SECRET') }),
    }),
  ],
  controllers: [HelpAdminController, SalesHelpController, PartnerHelpController, HelpMediaController],
  providers: [HelpAdminService, HelpMemberService, HelpMediaService, HelpMediaLimiter],
})
export class HelpModule {}
