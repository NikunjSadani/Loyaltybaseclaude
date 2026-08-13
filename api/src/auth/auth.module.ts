import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { ActivityTrackingService } from '../activity/activity-tracking.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ACCESS_TTL } from './auth.constants';

@Module({
  imports: [
    PrismaModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports:    [ConfigModule],
      inject:     [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:      config.get('JWT_SECRET'),
        // Default access-token lifetime is the SHORT ACCESS_TTL (60m), not 7d — decoupled
        // from the 7-day session window so the rolling session actually rolls. (AuthService
        // .generateTokens signs with an explicit expiresIn, so this is the module-level default.)
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN') ?? ACCESS_TTL },
      }),
    }),
  ],
  controllers: [AuthController],
  providers:   [AuthService, JwtStrategy, ActivityTrackingService],
  exports:     [AuthService, JwtModule, PassportModule],
})
export class AuthModule {}
