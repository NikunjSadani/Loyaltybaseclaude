import {
  Controller, Post, Body, HttpCode, HttpStatus, Get, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SendOtpDto, VerifyOtpDto, RefreshTokenDto, AssumeTenantDto } from './dto/auth.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Public, Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Step 1 — Request OTP (tightly rate-limited: 5 requests per minute per IP) */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto.phone, dto.channel);
  }

  /** Step 2 — Verify OTP and receive tokens (10 attempts per minute per IP) */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phone, dto.otp, dto.clientId);
  }

  /** Refresh access token */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  /** Verify token is valid and return current user info */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    // `assumed`/`clientId` let the operator shell render the "Working in <Brand>"
    // banner (A2). For a normal session `assumed` is false.
    return {
      id: user.sub,
      role: user.role,
      clientId: user.clientId,
      name: user.name,
      assumed: user.assumed ?? false,
    };
  }

  /**
   * POST /v1/auth/assume-tenant — A2 operator-context switcher (#51).
   * A GIFSY operator exchanges their session for one scoped to a tenant's context.
   * GIFSY_ADMIN-only (global RolesGuard); the service re-checks + audit-logs.
   */
  @Roles('GIFSY_ADMIN')
  @Post('assume-tenant')
  @HttpCode(HttpStatus.OK)
  assumeTenant(@CurrentUser() user: JwtPayload, @Body() dto: AssumeTenantDto) {
    return this.authService.assumeTenant(user, dto.clientId);
  }
}
