import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    // Same JWT secret/registration as AuthModule so a doc-view token is signed
    // (and verified) with the identical secret. We re-register rather than import
    // AuthModule to avoid a module cycle (auth ⇄ kyc).
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [KycController],
  // ReportsService (admin-programs) imports KycService to mint doc-view links in
  // the Outlet Master export, so KycService must be exported.
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
