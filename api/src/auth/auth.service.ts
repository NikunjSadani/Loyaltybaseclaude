import {
  Injectable, UnauthorizedException, BadRequestException,
  Logger, ForbiddenException, NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import * as crypto from 'crypto';

// ─── Business rule constants — single source of truth ─────────────────────────
// TDS under 194C: ₹30,000 single / ₹1,00,000 annual
// TDS under 194R: same thresholds (per user confirmation)
// Values stored in paise (1 rupee = 100 paise) to avoid float arithmetic

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  static readonly POINTS_TO_PAISE = 100; // 1 point = ₹1 = 100 paise

  constructor(
    private readonly prisma:  PrismaService,
    private readonly jwt:     JwtService,
    private readonly config:  ConfigService,
  ) {}

  // ── Send OTP ────────────────────────────────────────────────────────────────

  async sendOtp(phone: string, channel: 'SMS' | 'WHATSAPP'): Promise<{ success: boolean; expiresIn: number }> {
    if (!phone || phone.replace(/\D/g, '').length !== 10) {
      throw new BadRequestException('Invalid phone number — must be 10 digits');
    }

    const cleanPhone = phone.replace(/\D/g, '');
    const otp        = this.generateOtpCode();
    const expiresAt  = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Expire any existing unused OTPs for this phone
    await this.prisma.otpCode.deleteMany({
      where: { phone: cleanPhone, verifiedAt: null },
    });

    await this.prisma.otpCode.create({
      data: {
        phone:      cleanPhone,
        code:       otp,
        purpose:    'LOGIN',
        expiresAt,
        maxAttempts: 3,
      },
    });

    // Send via MSG91
    await this.sendViaMSG91(cleanPhone, otp, channel);

    this.logger.log(`OTP sent to ${cleanPhone} via ${channel}`);
    return { success: true, expiresIn: 600 };
  }

  // ── Verify OTP + issue tokens ────────────────────────────────────────────────

  async verifyOtp(
    phone: string,
    otp: string,
    clientId: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: Partial<User> }> {
    const cleanPhone = phone.replace(/\D/g, '');

    const record = await this.prisma.otpCode.findFirst({
      where:   { phone: cleanPhone, verifiedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new UnauthorizedException('No active OTP found for this number. Please request a new OTP.');
    }

    if (record.attempts >= record.maxAttempts) {
      throw new ForbiddenException('Too many attempts — please request a new OTP.');
    }

    if (new Date() > record.expiresAt) {
      throw new UnauthorizedException('OTP expired — please request a new one.');
    }

    const fixedOtp = this.config.get<string>('FIXED_OTP');
    const isCorrect = fixedOtp ? otp === fixedOtp : otp === record.code;

    if (!isCorrect) {
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data:  { attempts: record.attempts + 1 },
      });
      const remaining = record.maxAttempts - record.attempts - 1;
      throw new UnauthorizedException(`Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`);
    }

    // Mark OTP as used
    await this.prisma.otpCode.update({
      where: { id: record.id },
      data:  { verifiedAt: new Date() },
    });

    // Fetch or auto-register user
    let user = await this.prisma.user.findFirst({
      where: { phone: cleanPhone, clientId, deletedAt: null },
    });

    if (!user) {
      // Auto-register as RETAILER if self-enrollment is on, else throw
      throw new UnauthorizedException('No account found. Please contact your sales representative to complete KYC first.');
    }

    if (user.status === 'INACTIVE') {
      throw new ForbiddenException('Your account is inactive. Please contact your Deoleo representative.');
    }

    if (user.status === 'PENDING_VERIFICATION') {
      throw new ForbiddenException('Your account is pending activation. Please contact your Deoleo representative.');
    }

    // Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data:  { lastLoginAt: new Date(), loginCount: { increment: 1 } },
    });

    const tokens = await this.generateTokens(user);
    this.logger.log(`User ${user.id} (${user.role}) logged in — client: ${clientId}`);

    return {
      ...tokens,
      user: {
        id:    user.id,
        name:  user.name,
        role:  user.role,
        phone: user.phone,
      },
    };
  }

  // ── Generate JWT + Refresh token ─────────────────────────────────────────────

  /**
   * Mint an access + refresh token and persist a session row.
   *
   * `opts.clientIdOverride` / `opts.assumed` support the A2 operator-context
   * (assume-tenant) flow: a GIFSY_ADMIN gets a token scoped to a TENANT's clientId
   * (not their own `gifsy`) while `sub` stays the real operator. When overriding,
   * the session row + JWT both carry the assumed clientId, and `opts.expiresIn`
   * gives assumed tokens a shorter life (industry practice — scoped, short-lived).
   */
  async generateTokens(
    user: User,
    opts?: { clientIdOverride?: string; assumed?: boolean; expiresIn?: string },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const clientId = opts?.clientIdOverride ?? user.clientId;
    const payload = {
      sub:      user.id,
      role:     user.role,
      clientId,
      phone:    user.phone,
      name:     user.name,
      ...(opts?.assumed ? { assumed: true } : {}),
    };

    // expiresIn accepts the `ms` StringValue | number; the config value widens to
    // string|number, so cast (the original used an untyped config.get for this).
    const expiresIn = (opts?.expiresIn ?? this.config.get('JWT_EXPIRES_IN') ?? '7d') as string;
    const accessToken  = this.jwt.sign(payload, {
      secret:    this.config.get('JWT_SECRET'),
      expiresIn: expiresIn as unknown as number,
    });

    const refreshToken = crypto.randomBytes(40).toString('hex');
    const ttlMs        = opts?.assumed
      ? 8 * 60 * 60 * 1000              // assumed sessions: 8h
      : 30 * 24 * 60 * 60 * 1000;       // normal: 30 days
    const expiresAt    = new Date(Date.now() + ttlMs);

    await this.prisma.userSession.create({
      data: {
        userId:       user.id,
        clientId,                       // canonical model binds the tenant to the session
        token:        accessToken,
        refreshToken,
        expiresAt,
      },
    });

    return { accessToken, refreshToken };
  }

  /**
   * POST /v1/auth/assume-tenant — A2 operator-context switcher (#51).
   *
   * A GIFSY platform operator exchanges their `gifsy` session for a token scoped
   * to ONE tenant's context, so per-brand operations (payouts) run under the
   * normal `clientId: user.clientId` discipline with no cross-tenant query rewrite.
   *
   * Guardrails (industry pattern — AWS AssumeRole / Salesforce Login-As):
   *   - GIFSY_ADMIN only (defense-in-depth beyond the controller @Roles);
   *   - target must be a REAL, ACTIVE tenant (never `gifsy` itself);
   *   - `sub` stays the real operator → audit logs attribute actions to them;
   *   - every assume is audit-logged (action LOGIN + metadata.event=ASSUME_TENANT);
   *   - the token is short-lived (8h) and flagged `assumed:true` (FE banner).
   */
  async assumeTenant(
    operator: JwtPayload,
    targetClientId: string,
  ): Promise<{ accessToken: string; refreshToken: string; clientId: string; brandName: string }> {
    if (operator.role !== 'GIFSY_ADMIN') {
      throw new ForbiddenException('Only Gifsy operators may switch brand context');
    }
    if (targetClientId === operator.clientId) {
      throw new BadRequestException('Already in this context');
    }

    const target = await this.prisma.client.findFirst({
      where: { id: targetClientId, status: 'ACTIVE' },
      select: { id: true, internalName: true },
    });
    if (!target) {
      throw new NotFoundException('Tenant not found or not active');
    }

    // The real operator user (their identity rides the assumed token).
    const opUser = await this.prisma.user.findFirst({
      where: { id: operator.sub, deletedAt: null },
    });
    if (!opUser) throw new UnauthorizedException('Operator account not found');

    // Audit the assume on the money-path trail — attributed to the real operator.
    await this.prisma.auditLog.create({
      data: {
        action: 'LOGIN',
        entityType: 'CLIENT',
        entityId: targetClientId,
        actorId: operator.sub,
        metadata: { event: 'ASSUME_TENANT', fromClientId: operator.clientId, toClientId: targetClientId },
      },
    });

    const tokens = await this.generateTokens(opUser, {
      clientIdOverride: targetClientId,
      assumed: true,
      expiresIn: '8h',
    });

    this.logger.log(
      `GIFSY operator ${operator.sub} assumed tenant ${targetClientId} (from ${operator.clientId})`,
    );

    return { ...tokens, clientId: targetClientId, brandName: target.internalName };
  }

  // ── Refresh token ────────────────────────────────────────────────────────────

  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const session = await this.prisma.userSession.findFirst({
      where:   { refreshToken, revokedAt: null },
      include: { user: true },
    });

    if (!session || new Date() > session.expiresAt) {
      throw new UnauthorizedException('Session expired — please log in again.');
    }

    // Revoke old session
    await this.prisma.userSession.update({
      where: { id: session.id },
      data:  { revokedAt: new Date() },
    });

    // Preserve the operator-context (A2): an assumed session's row carries the
    // TENANT clientId while its user's home clientId is `gifsy`. Refresh must keep
    // the assumed tenant scope (otherwise the operator is silently reverted to the
    // platform context mid-flow). Only preserve while the operator is still a
    // GIFSY_ADMIN — a demoted operator falls back to their home scope.
    const isAssumed =
      session.clientId !== session.user.clientId && session.user.role === 'GIFSY_ADMIN';
    return this.generateTokens(
      session.user,
      isAssumed ? { clientIdOverride: session.clientId, assumed: true, expiresIn: '8h' } : undefined,
    );
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private generateOtpCode(): string {
    // 6-digit OTP: 100000–999999
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  private async sendViaMSG91(phone: string, otp: string, channel: 'SMS' | 'WHATSAPP'): Promise<void> {
    const authKey    = this.config.get<string>('MSG91_AUTH_KEY');
    const templateId = this.config.get<string>('MSG91_OTP_TEMPLATE_ID');
    const fixedOtp   = this.config.get<string>('FIXED_OTP');

    // FIXED_OTP mode — skip MSG91, log OTP to console (dev/staging only)
    // Production Cloud Run will never have FIXED_OTP set
    if (fixedOtp) {
      this.logger.warn(`[FIXED_OTP MODE] OTP for ${phone} is always: ${fixedOtp} — MSG91 not called`);
      return;
    }

    if (!authKey) {
      this.logger.warn(`[DEV] MSG91 not configured — OTP for ${phone}: ${otp}`);
      return;
    }

    // MSG91 OTP API v5 — authkey goes in the header, not the body.
    // Sender ID is configured on the template inside the MSG91 dashboard,
    // so it is NOT passed here. Both SMS and WhatsApp use the same endpoint;
    // routing is determined by the template type registered in MSG91.
    const url  = 'https://control.msg91.com/api/v5/otp';
    const body = { template_id: templateId, mobile: `91${phone}`, otp };

    const res = await fetch(url, {
      method:  'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    // MSG91 can return HTTP 200 with {"type":"error"} — check the body too
    const json = await res.json() as { type?: string; message?: string };
    if (!res.ok || json?.type === 'error') {
      const reason = json?.message ?? `HTTP ${res.status}`;
      this.logger.error(`MSG91 OTP failed for ${phone} (${channel}): ${reason}`);
      throw new Error(`Failed to send OTP via ${channel}: ${reason}`);
    }
  }
}
