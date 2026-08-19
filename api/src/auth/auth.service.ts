import {
  Injectable, UnauthorizedException, BadRequestException,
  Logger, ForbiddenException, NotFoundException,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { Msg91Service } from '../notifications/msg91.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { TenantService } from '../tenant/tenant.service';
import { isFixedOtpAllowed } from '../common/fixed-otp';
import { generateNumericOtp } from '../common/otp';
import { GifsyTenantGrantService } from '../common/rbac/gifsy-tenant-grant.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { ALL_PERMISSIONS } from '../common/rbac/permissions';
import {
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_WINDOW_HOURS,
  OTP_MAX_RESENDS_PER_WINDOW,
  SESSION_TTL_DAYS,
  ACCESS_TTL,
} from './auth.constants';
import * as crypto from 'crypto';

/**
 * Idempotent-rotation grace window (ms). A refresh token that has JUST been rotated
 * (single-use claim already consumed by a concurrent tab) may still be replayed for a
 * few seconds by a slow second tab. Within this window, if the rotated-from predecessor
 * has a live (non-revoked) successor, that successor's STORED tokens are returned instead
 * of a 401 — so parallel tabs converge on one token set instead of logging each other out.
 * Outside the window, a replay is treated as genuine reuse (→ 401), preserving reuse
 * detection. Kept short so the reuse-detection window stays tight.
 */
const ROTATION_GRACE_MS = 5_000;

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
    private readonly msg91:   Msg91Service,
    private readonly tenantSettings: TenantSettingsService,
    private readonly tenant:  TenantService,
    private readonly gifsyTenantGrants: GifsyTenantGrantService,
    private readonly gifsyRoles: GifsyRoleService,
  ) {}

  // ── Current user (enriched) ───────────────────────────────────────────────────

  /**
   * GET /v1/auth/me — the base JWT identity PLUS the role-specific record under `user`
   * (channelPartner + its wallet for partners, salesUser for sales) so the shell + /profile
   * pages render REAL data instead of the demo MOCK_PROFILE fallback (#40-class, the profile-page
   * analog of gap #54/#55). Tenant-safe — every lookup is keyed on the authenticated user's own id.
   * The flat identity fields are kept for any consumer that reads them (and the A2 operator banner).
   */
  async getMe(user: JwtPayload) {
    const [dbUser, channelPartner, salesUser, settings, visibilityCaptureMode] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.sub }, select: { name: true, phone: true } }),
      this.prisma.channelPartner.findUnique({
        where: { userId: user.sub },
        select: {
          id: true, partnerCode: true, businessName: true, ownerName: true,
          phone: true, email: true, gstNumber: true, panNumber: true, entityType: true,
          // Beneficiary (KYC) — the partner reading THEIR OWN payout rails so the
          // cash-redeem FE can show what it will pay to (tenant-safe: keyed on user.sub).
          bankName: true, bankAccountNumber: true, bankAccountHolder: true,
          ifscCode: true, upiId: true, paymentMode: true,
        },
      }),
      this.prisma.salesUser.findUnique({
        where: { userId: user.sub },
        select: {
          id: true, employeeCode: true, region: true, zone: true,
          // Reporting manager — surfaced on /sales/profile (name + designation + phone).
          reportingTo: {
            select: {
              user: { select: { name: true, phone: true } },
              hierarchyLevel: { select: { name: true } },
            },
          },
        },
      }),
      this.tenantSettings.getEffectiveSettings(user.clientId),
      // The authoritative visibility-capture mode (ClientConfig.features) — surfaced here so
      // the SALES shell can read it (the /admin/settings/config endpoint is admin-only, so
      // sales would 403 and wrongly default to PHOTO_APPROVAL).
      this.tenant.resolveVisibilityCaptureMode(user.clientId),
    ]);

    const wallet = channelPartner
      ? await this.prisma.wallet.findUnique({
          where: { partnerId: channelPartner.id },
          select: { earnedPoints: true, redeemablePoints: true, lockedPoints: true, lifetimeEarned: true },
        })
      : null;

    // RBAC Option-X (P6): the caller's EFFECTIVE permission keys, so the FE can show a clear
    // "you don't have permission" message (page + action level) instead of a raw 403 — the FE
    // gates only GIFSY_STAFF by this; the backend remains the real enforcement boundary. Owner
    // (GIFSY_ADMIN) = all permissions (unrestricted); a GIFSY_STAFF = their assigned GifsyRole's
    // set; every other (legacy) role = [] (their existing, un-permission-gated UX is untouched).
    const permissions: string[] =
      user.role === 'GIFSY_ADMIN'
        ? ALL_PERMISSIONS
        : user.role === 'GIFSY_STAFF'
          ? Array.from(await this.gifsyRoles.getPermissions(user.gifsyRoleId))
          : [];

    return {
      id: user.sub,
      role: user.role,
      clientId: user.clientId,
      name: user.name,
      assumed: user.assumed ?? false,
      permissions,
      // Authoritative points→₹ conversion rate so the partner FE previews points
      // and shows the ₹ minimum from the server, not its stale localStorage rate.
      // Now per-tenant (TenantSettingsService), defaulting to the env rate.
      conversionRate: settings.conversionRate,
      // Partner/sales-facing tenant settings block — the server source of truth that
      // replaces the browser localStorage blob. Operator-only creditsPayouts is omitted.
      settings: {
        conversionRate:         settings.conversionRate,
        minBankTransferAmount:  settings.minBankTransferAmount,
        minVoucherFreeAmount:   settings.minVoucherFreeAmount,
        paceAmberThreshold:     settings.paceAmberThreshold,
        visibilityPhotoEnabled: settings.visibilityPhotoEnabled,
        visibilityCaptureMode,
        redemptionChannels:     settings.redemptionChannels,
        salesApp:               settings.salesApp,
      },
      user: {
        id: user.sub,
        name: dbUser?.name ?? user.name,
        phone: dbUser?.phone ?? null,
        role: user.role,
        channelPartner: channelPartner
          ? { ...channelPartner, wallets: wallet ? [wallet] : [] }
          : null,
        salesUser: salesUser ?? null,
      },
    };
  }

  // ── Send OTP ────────────────────────────────────────────────────────────────

  async sendOtp(phone: string, channel: 'SMS' | 'WHATSAPP', clientId?: string): Promise<{ success: boolean; expiresIn: number }> {
    if (!phone || phone.replace(/\D/g, '').length !== 10) {
      throw new BadRequestException('Invalid phone number — must be 10 digits');
    }

    const cleanPhone = phone.replace(/\D/g, '');

    // Registration gate (owner decision — "check first, refuse if unregistered"). For a tenant-scoped
    // login (clientId resolved by the FE from the request Host), refuse to send an OTP to a number that
    // has NO account under this tenant — the user gets immediate "no account" feedback instead of a
    // silently-undelivered SMS to a mistyped number. Tenant-scoped so a phone registered under a
    // DIFFERENT tenant is not treated as registered here (matches verifyOtp's `{phone, clientId}` lookup).
    // Same status + message as verifyOtp's post-code check, so the "no account" outcome is identical
    // whether surfaced at send or verify. Runs even under the FIXED_OTP bypass so the behaviour is
    // testable on staging. Skipped only when clientId is absent (legacy/unbranded caller) → falls back to
    // the prior send-then-check-at-verify behaviour. Enumeration note: this reveals which numbers are
    // registered, an owner-accepted trade-off for the clearer UX on a closed KYC-only platform; the
    // controller's per-IP @Throttle (5/60s) bounds probing (verifyOtp remains the authoritative gate).
    if (clientId) {
      const account = await this.prisma.user.findFirst({
        // ACTIVE-only reservation (partial unique index `users_clientId_phone_active_key`):
        // a deactivated user's number is freed, so only a LIVE (ACTIVE) account here should
        // receive a login OTP. If only an INACTIVE/soft-deleted user holds the number, the
        // "no account" outcome below is the correct, safe result (no OTP to a freed number).
        where: { phone: cleanPhone, clientId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!account) {
        throw new UnauthorizedException(
          'No account found. Please contact your sales representative to complete KYC first.',
        );
      }
    }

    // AF-10 — per-phone send cap over a rolling window, enforced in the DB so it holds
    // across ALL Cloud Run instances (the controller's @Throttle is per-IP AND
    // per-instance, so multi-instance distribution bypasses it). This is the real
    // anti-SMS-bombing control — a simple cooldown still allows sustained volume; a
    // windowed COUNT caps the total a victim's number can receive. Skipped only when the
    // fixed-OTP dev/staging bypass is active so UAT can request freely.
    const OTP_WINDOW_MS = OTP_RESEND_WINDOW_HOURS * 60 * 60 * 1000;   // 1 hour
    const OTP_MAX_PER_WINDOW = OTP_MAX_RESENDS_PER_WINDOW;
    const windowStart = new Date(Date.now() - OTP_WINDOW_MS);
    const fixedOtpActive = isFixedOtpAllowed() && !!this.config.get<string>('FIXED_OTP');

    if (!fixedOtpActive) {
      const recentSends = await this.prisma.otpCode.count({
        where: { phone: cleanPhone, createdAt: { gte: windowStart } },
      });
      if (recentSends >= OTP_MAX_PER_WINDOW) {
        this.logger.warn(`OTP send cap hit for ${cleanPhone} (${recentSends} in window)`);
        throw new HttpException(
          'Too many OTP requests for this number. Please wait a while before trying again.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      // (Small race at the window boundary can let a couple extra through under high
      // concurrency — acceptable for an anti-abuse cap; the per-IP throttle bounds the
      // concurrent source and each send still costs an SMS.)
    }

    const otp        = this.generateOtpCode();
    const expiresAt  = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000); // 10 minutes

    // Prune this phone's OTPs that have aged out of the window. We retain IN-WINDOW rows
    // (verified or not) so the cap above can count actual sends; a freshly-issued code
    // supersedes older ones because verifyOtp always reads the NEWEST unverified row, so
    // older codes are inert (equivalent to the old "delete unverified on resend").
    await this.prisma.otpCode.deleteMany({
      where: { phone: cleanPhone, createdAt: { lt: windowStart } },
    });

    // Opportunistic global cleanup so the table stays bounded without a scheduler:
    // OTP rows are 10-min-expiry, so anything >1 day past expiry is dead for every phone.
    // Cheap at launch volume (small table); graduate to an indexed scheduled job at scale.
    await this.prisma.otpCode.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });

    await this.prisma.otpCode.create({
      data: {
        phone:      cleanPhone,
        code:       otp,
        purpose:    'LOGIN',
        expiresAt,
        maxAttempts: OTP_MAX_ATTEMPTS,
      },
    });

    // Send via MSG91 — pass the tenant so the per-tenant login template can be resolved.
    await this.sendViaMSG91(cleanPhone, otp, channel, clientId);

    // Mask the phone in logs (PII) — last 4 digits only. cleanPhone is the 10-digit number.
    this.logger.log(`OTP sent to ****${cleanPhone.slice(-4)} via ${channel}`);
    return { success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 };
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

    // FIXED_OTP is a dev/staging convenience bypass, gated by isFixedOtpAllowed (non-prod
    // NODE_ENV, or an explicit ALLOW_FIXED_OTP opt-in; always refused on the prod DB) so a
    // misconfig can't turn into a universal-OTP backdoor. (Mirrors the redemption OTP path.)
    const fixedOtp = isFixedOtpAllowed() ? this.config.get<string>('FIXED_OTP') : undefined;
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

    // Resolve the login user — TWO-STEP so it is DETERMINISTIC now that ACTIVE + INACTIVE
    // rows can share a phone (deactivation frees the number: it flips status→INACTIVE while
    // leaving deletedAt=null). The old single `findFirst({ deletedAt: null })` had NO orderBy,
    // so over such a duplicate it could nondeterministically return the INACTIVE row and
    // wrongly reject a valid ACTIVE login.
    //
    // Step 1 — the ACTIVE user IS the login. The partial unique index
    // `users_clientId_phone_active_key` (WHERE status = 'ACTIVE') guarantees at most one
    // ACTIVE row per (clientId, phone), so this resolves to exactly the right account.
    const user = await this.prisma.user.findFirst({
      where: { phone: cleanPhone, clientId, status: 'ACTIVE' },
    });

    if (!user) {
      // Step 2 — no ACTIVE account. Fall back to the prior lookup SOLELY to choose the
      // correct user-facing message; NEVER mint a token on this branch. Messages are
      // byte-identical to the pre-refactor strings.
      const fallback = await this.prisma.user.findFirst({
        where: { phone: cleanPhone, clientId, deletedAt: null },
      });

      if (fallback?.status === 'INACTIVE') {
        throw new ForbiddenException('Your account is inactive. Please contact your Deoleo representative.');
      }

      if (fallback?.status === 'PENDING_VERIFICATION') {
        throw new ForbiddenException('Your account is pending activation. Please contact your Deoleo representative.');
      }

      if (fallback?.status === 'SUSPENDED') {
        // A suspended account is blocked from login (previously it fell through and was — wrongly —
        // issued a token). Its phone is freed under the ACTIVE-only reservation, but the account
        // itself cannot log in until reactivated.
        throw new ForbiddenException('Your account is suspended. Please contact your Deoleo representative.');
      }

      // No account (fallback null) or any other residual non-ACTIVE status → "no account found".
      throw new UnauthorizedException('No account found. Please contact your sales representative to complete KYC first.');
    }

    // Deactivated-outlet gate (see assertPartnerNotDeactivated). Runs on BOTH the
    // OTP login here AND the refresh path, so a partner deactivated mid-session
    // cannot keep minting access tokens via their long-lived refresh token.
    await this.assertPartnerNotDeactivated(user.id, clientId);

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
    opts?: { clientIdOverride?: string; assumed?: boolean; expiresIn?: string; rotatedFromId?: string },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const clientId = opts?.clientIdOverride ?? user.clientId;
    // Pre-generate the session id so it can be embedded in the JWT (`sid`) AND used as
    // the UserSession PK — jwt.strategy then binds the bearer token to THIS session, so
    // revoke/rotate kills the access token on its next request (not after a 7-day TTL).
    const sid = crypto.randomUUID();
    const payload = {
      sub:      user.id,
      role:     user.role,
      clientId,
      phone:    user.phone,
      name:     user.name,
      sid,
      ...(opts?.assumed ? { assumed: true } : {}),
      // RBAC Option-X — carry the staff member's assigned GifsyRole id so the
      // PermissionGuard can resolve GIFSY_STAFF permissions without a user lookup.
      // Rides both login and refresh (refresh re-mints from the full session.user).
      // Null for every non-staff user → omitted from the token.
      ...(user.gifsyRoleId ? { gifsyRoleId: user.gifsyRoleId } : {}),
    };

    // SHORT access-token lifetime — DECOUPLED from the 7-day session/refresh window so
    // the rolling session actually rolls. Both the normal and the assumed (A2) paths sign
    // a 60m (ACCESS_TTL) access token; env JWT_EXPIRES_IN may override in a deployment (set
    // to 60m everywhere), and the CODE default is ACCESS_TTL — NEVER the old 7d, which made
    // the feature inert. The session ROW below still lives SESSION_TTL_DAYS (7d), sliding on
    // each refresh/guard hit. expiresIn accepts the `ms` StringValue | number; cast to string.
    const expiresIn = (opts?.expiresIn ?? this.config.get('JWT_EXPIRES_IN') ?? ACCESS_TTL) as string;
    const accessToken  = this.jwt.sign(payload, {
      secret:    this.config.get('JWT_SECRET'),
      expiresIn: expiresIn as unknown as number,
    });

    const refreshToken = crypto.randomBytes(40).toString('hex');
    // Sliding-session idle window — both the assumed (ASSUMED_SESSION_TTL_HOURS = 168h)
    // and normal (SESSION_TTL_DAYS = 7d) branches are now exactly 7 days. Each refresh
    // calls generateTokens, so expiresAt is re-minted to now+7d on every refresh (roll-on-
    // refresh); the jwt.strategy guard slides it the same way on ordinary access.
    const ttlMs        = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;   // 7 days (assumed == normal)
    const expiresAt    = new Date(Date.now() + ttlMs);

    await this.prisma.userSession.create({
      data: {
        id:           sid,              // PK = the JWT's `sid` claim (token↔session binding)
        userId:       user.id,
        clientId,                       // canonical model binds the tenant to the session
        token:        accessToken,
        refreshToken,
        expiresAt,
        // Idempotent-rotation chain: link this successor back to the refresh row it rotated
        // from, so a slow second tab replaying the (just-revoked) predecessor within the
        // grace window can be handed THIS successor's stored tokens instead of a 401.
        ...(opts?.rotatedFromId ? { rotatedFromId: opts.rotatedFromId } : {}),
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
   *   - the access token is short-lived (ACCESS_TTL, 60m) and flagged `assumed:true` (FE banner);
   *     the assumed SESSION row still lives the 7-day sliding window (ASSUMED_SESSION_TTL_HOURS==7d).
   */
  async assumeTenant(
    operator: JwtPayload,
    targetClientId: string,
  ): Promise<{ accessToken: string; refreshToken: string; clientId: string; brandName: string }> {
    if (operator.role !== 'GIFSY_ADMIN' && operator.role !== 'GIFSY_STAFF') {
      throw new ForbiddenException('Only Gifsy operators may switch brand context');
    }
    if (targetClientId === operator.clientId) {
      throw new BadRequestException('Already in this context');
    }

    // RBAC Option-X (P5) — TENANT axis: a GIFSY_STAFF may assume ONLY a tenant they hold a
    // grant for (the owner assigns brands per-staff via GifsyStaffTenantGrant). The owner
    // (GIFSY_ADMIN) may assume any assumable tenant. This is the authorization gate for staff
    // cross-tenant work — an un-granted staff is refused here (deny-by-default), and because
    // un-assumed staff are not platform-wide (tenant-scope.ts) they have no other path in.
    if (operator.role === 'GIFSY_STAFF') {
      // AUTHORITATIVE (uncached) grant check — a grant just revoked on another instance must not
      // be honored from a stale 30s cache (no cross-instance invalidation; Redis removed). P5 audit F1.
      if (!(await this.gifsyTenantGrants.hasGrantUncached(operator.sub, targetClientId))) {
        throw new ForbiddenException('You do not have access to this brand');
      }
    }

    // ONBOARDING tenants are assumable so a GIFSY operator can configure the
    // brand (branding/features/outlet-type configs) before flipping it ACTIVE.
    // INACTIVE tenants stay blocked — they are intentionally disabled.
    const target = await this.prisma.client.findFirst({
      where: { id: targetClientId, status: { in: ['ACTIVE', 'ONBOARDING'] } },
      select: { id: true, internalName: true },
    });
    if (!target) {
      throw new NotFoundException('Tenant not found or not assumable');
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
      // Access token is the SHORT ACCESS_TTL (60m) — same as the normal path. The session
      // row is 7d (SESSION_TTL_DAYS) inside generateTokens, so the assumed session slides.
      expiresIn: ACCESS_TTL,
    });

    this.logger.log(
      `GIFSY operator ${operator.sub} assumed tenant ${targetClientId} (from ${operator.clientId})`,
    );

    return { ...tokens, clientId: targetClientId, brandName: target.internalName };
  }

  // ── Refresh token ────────────────────────────────────────────────────────────

  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    // Read the session (with its user) IGNORING revokedAt, so a JUST-revoked
    // predecessor is visible for the idempotent-rotation grace path below (a slow
    // second tab replaying a token its sibling already rotated). This read alone is
    // NOT the gate — the atomic claim on the live path is.
    const session = await this.prisma.userSession.findFirst({
      where:   { refreshToken },
      include: { user: true },
    });

    // Unknown token → 401 (genuine bad/forged token). Nothing to rotate or grace.
    if (!session) {
      throw new UnauthorizedException('Session expired — please log in again.');
    }

    // ── logout-all authority (1b), predecessor-predates-sweep guard ──────────────
    // If a "log out everywhere" was stamped on the user AFTER this session was created,
    // the predecessor predates the sweep and is dead — refuse regardless of the grace/
    // reuse machinery below, so a session that existed at logout time can never be rolled
    // forward. (The DURING-refresh race is closed by the re-read after the mint.)
    if (
      session.user.sessionsInvalidBefore &&
      session.createdAt < session.user.sessionsInvalidBefore
    ) {
      throw new UnauthorizedException('Session expired — please log in again.');
    }

    // ── Live path: the token is unrevoked and unexpired ──────────────────────────
    if (session.revokedAt === null && new Date() <= session.expiresAt) {
      // ATOMIC single-use claim (token-reuse / session-fixation fix): revoke the
      // row by its refreshToken in one statement and only proceed if THIS call won
      // the revoke. Two concurrent refreshes both pass the read above, but the DB
      // serialises this updateMany — exactly one sees count===1; the loser sees
      // count===0 and falls through to the idempotent-rotation grace below.
      const claim = await this.prisma.userSession.updateMany({
        where: { refreshToken, revokedAt: null },
        data:  { revokedAt: new Date() },
      });

      if (claim.count === 1) {
        // Preserve the operator-context (A2): an assumed session's row carries the
        // TENANT clientId while its user's home clientId is `gifsy`. Refresh must keep
        // the assumed tenant scope (otherwise the operator is silently reverted to the
        // platform context mid-flow). Only preserve while the operator is still a
        // GIFSY_ADMIN — a demoted operator falls back to their home scope.
        // RBAC Option-X (P5): an ASSUMED session is one whose token clientId differs from the
        // operator's home clientId. Both the owner (GIFSY_ADMIN) AND a scoped GIFSY_STAFF can be
        // assumed into a tenant — this MUST include GIFSY_STAFF, otherwise a staff's assumed
        // token silently reverts to their home ('gifsy') context on the next (~hourly) refresh,
        // dropping their tenant scope. A demoted/regular user never matches (clientId == home).
        const isAssumed =
          session.clientId !== session.user.clientId &&
          (session.user.role === 'GIFSY_ADMIN' || session.user.role === 'GIFSY_STAFF');

        // Defense-in-depth (P5): if a staff's grant for the assumed tenant was revoked, do NOT
        // roll the assumed scope forward. Grant removal already revokes the staff's sessions
        // (GifsyStaffService stamp-before-sweep), so a swept token 401s before reaching here;
        // this is the backstop for a missed sweep — the predecessor is already revoked by the
        // atomic claim above, so the staff must re-login (and can only re-assume a still-granted
        // tenant). Cached resolver → no hot-path DB cost in the common case.
        if (isAssumed && session.user.role === 'GIFSY_STAFF') {
          // AUTHORITATIVE (uncached) — a revoked grant must not roll forward from a stale cache
          // even if the session-sweep was somehow missed on this instance (P5 audit F1).
          if (!(await this.gifsyTenantGrants.hasGrantUncached(session.user.id, session.clientId))) {
            throw new UnauthorizedException('Session expired — please log in again.');
          }
        }

        // Re-apply the deactivated-outlet gate on every refresh. The session row was
        // already revoked by the atomic claim above, so a deactivated partner who
        // tries to refresh is denied AND loses the session (must re-login, which is
        // also blocked). Scoped to the user's HOME tenant — an assumed operator is a
        // GIFSY_ADMIN with no ChannelPartner, so this is a no-op for that flow.
        await this.assertPartnerNotDeactivated(session.user.id, session.user.clientId);

        // Mint the successor, chaining rotatedFromId back to THIS predecessor so a
        // slow sibling replay can be handed the successor's stored tokens (grace).
        // The assumed access token uses the SHORT ACCESS_TTL (60m) — same as normal;
        // the successor SESSION row is 7d (SESSION_TTL_DAYS) inside generateTokens.
        const tokens = await this.generateTokens(
          session.user,
          isAssumed
            ? { clientIdOverride: session.clientId, assumed: true, expiresIn: ACCESS_TTL, rotatedFromId: session.id }
            : { rotatedFromId: session.id },
        );

        // ── logout-all authority (1b), DURING-refresh race — clock-skew robust ─────
        // A concurrent "log out everywhere" can land AFTER our predecessor read but
        // AROUND the successor create — the classic "successor survives the sweep" hole.
        // RE-READ the stamp now and compare it to the PREDECESSOR's createdAt. BOTH are
        // DB-written timestamps and the predecessor was created well before any logout, so
        // this is robust to cross-instance app-clock skew (unlike comparing the stamp to
        // THIS instance's wall clock). If a logout-all whose stamp post-dates the refreshed
        // lineage's start is now visible, the successor we just minted is illegitimate →
        // revoke it and 401, so nothing live survives "log out everywhere". (Stampers write
        // sessionsInvalidBefore BEFORE revoking, so a sweep that missed our successor is
        // always preceded by a committed stamp this re-read observes.)
        const fresh = await this.prisma.user.findUnique({
          where:  { id: session.user.id },
          select: { sessionsInvalidBefore: true },
        });
        if (fresh?.sessionsInvalidBefore && session.createdAt < fresh.sessionsInvalidBefore) {
          await this.prisma.userSession.updateMany({
            where: { refreshToken: tokens.refreshToken, revokedAt: null },
            data:  { revokedAt: new Date() },
          });
          throw new UnauthorizedException('Session expired — please log in again.');
        }

        return tokens;
      }
      // claim LOST (count===0): a concurrent winner revoked this row ~now — fall
      // through to the grace path (predecessorRevokedAt resolves to now below).
    }

    // ── Revoked/expired predecessor: converge on a LIVE successor if one exists ───
    // The token is revoked (an already-revoked replay, or a concurrent winner just revoked
    // it out from under our claim) or naturally expired. FIRST look for a LIVE successor
    // (the row this predecessor rotated INTO, still non-revoked) — REGARDLESS of the grace
    // window. If one exists, this is a benign concurrent/rotated refresh (multi-tab, or a
    // page-nav proxy refresh colliding with an in-flight XHR/prefetch refresh — which under
    // the 60m access token can be MORE than the grace window apart), so hand back the
    // successor's STORED tokens and converge instead of nuking a legit active user. A
    // successor revoked by a logout-all is excluded by revokedAt:null, so a swept lineage
    // is never resurrected here.
    const successor = await this.prisma.userSession.findFirst({
      where: { rotatedFromId: session.id, revokedAt: null },
    });
    if (successor && successor.refreshToken) {
      return { accessToken: successor.token, refreshToken: successor.refreshToken };
    }

    // No live successor. Distinguish a transient in-grace loser from genuine reuse.
    const predecessorRevokedAt = session.revokedAt ?? new Date(); // lost-claim → ~now
    const withinGrace = Date.now() - predecessorRevokedAt.getTime() <= ROTATION_GRACE_MS;

    // ── Reuse detection (1c) ─────────────────────────────────────────────────────
    // Nuke the lineage ONLY when the predecessor was ALREADY REVOKED (previously rotated),
    // is being replayed AFTER the grace window, AND has NO live successor to hand back — a
    // single-use rotated token resurfacing with its successor gone is a strong theft signal.
    // STAMP sessionsInvalidBefore FIRST, then revoke every live session (stamp-before-revoke,
    // same authority logout-all uses), so any in-flight refresh's post-mint re-read observes
    // the stamp and drops its successor. A merely EXPIRED-but-never-revoked session
    // (revokedAt === null) is NOT reuse, and an in-grace loser is transient — both just 401.
    // Best-effort: a failed lineage-kill must never mask the 401 below.
    if (!withinGrace && session.revokedAt !== null) {
      const now = new Date();
      try {
        await this.prisma.user.update({
          where: { id: session.user.id },
          data:  { sessionsInvalidBefore: now },
        });
        await this.prisma.userSession.updateMany({
          where: { userId: session.user.id, revokedAt: null },
          data:  { revokedAt: now },
        });
      } catch {
        /* best-effort lineage kill — never mask the 401 below */
      }
      this.logger.warn(
        `Refresh-token reuse detected for user ${session.user.id} — revoked all sessions`,
      );
      // Platform-level security-event audit row (best-effort — a failed audit write
      // must NEVER mask the 401 below). Queryable via the [entityType, entityId] index
      // and filtered by metadata.event in the GIFSY security-events report.
      try {
        await this.prisma.auditLog.create({
          data: {
            action: 'LOGOUT', // valid AuditAction enum; matches session-kill semantics
            entityType: 'SECURITY_EVENT', // distinctive, queryable via [entityType,entityId] index
            entityId: session.user.id,
            actorId: session.user.id,
            targetUserId: session.user.id,
            metadata: {
              event: 'refresh_token_reuse', // discriminator the report filters on
              clientId: session.user.clientId, // which TENANT (AuditLog has no clientId column)
              sessionId: session.id,
              detectedAt: now.toISOString(),
            },
          },
        });
      } catch {
        /* best-effort security audit — never mask the 401 */
      }
    }

    throw new UnauthorizedException('Session expired — please log in again.');
  }

  // ── Self-service "log out everywhere" (#101 / Feature 10-i) ──────────────────

  /**
   * POST /v1/auth/logout-all — revoke ALL of the CURRENT user's non-revoked sessions
   * so every other signed-in device is logged out. Scoped strictly to `user.sub`
   * (never another user's rows). The caller's own cookies are cleared separately by
   * the FE logout action after this returns.
   *
   * HONESTY CAVEAT: access-token JWTs are verified at the proxy with NO per-request
   * session-revocation check, so revoking sessions kills the REFRESH path (other
   * devices can no longer renew, so they're bounded by the access-token TTL) but does
   * NOT instantly invalidate an already-issued, still-valid access token. Other
   * devices are therefore signed out within the session window / on their next
   * refresh — not immediately. UI copy must reflect this.
   */
  async logoutAllSessions(user: JwtPayload): Promise<{ revoked: number }> {
    const now = new Date();

    // AUTHORITATIVE (1b): STAMP BEFORE REVOKE. A concurrent refresh's mint+re-read must
    // never slot inside a revoke→stamp gap and survive. Stamping sessionsInvalidBefore
    // FIRST guarantees that any sweep which misses a just-minted successor is necessarily
    // PRECEDED by a committed stamp that the refresh's post-mint re-read observes (→ it
    // revokes its own successor). refreshToken compares that stamp to the predecessor's
    // createdAt (both DB timestamps) so the check is robust to cross-instance clock skew.
    await this.prisma.user.update({
      where: { id: user.sub },
      data:  { sessionsInvalidBefore: now },
    });

    const result = await this.prisma.userSession.updateMany({
      where: { userId: user.sub, revokedAt: null },
      data:  { revokedAt: now },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'LOGOUT',
        entityType: 'SESSION',
        entityId: user.sub,
        actorId: user.sub,
        metadata: { event: 'logout_all_sessions', revoked: result.count },
      },
    });

    this.logger.log(`User ${user.sub} logged out of all sessions (${result.count} revoked)`);
    return { revoked: result.count };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Block a deactivated partner from obtaining OR refreshing a session. The
   * login identity is the ChannelPartner (1 User → 1 partner → 1..n outlets);
   * the admin outlet-deactivate flow flips Outlet.isActive=false without touching
   * User.status, so this is the authoritative live check. No-op for non-partner
   * users (sales/admin have no ChannelPartner). Throws when the partner is itself
   * deactivated OR has NO active, non-deleted outlet left. A multi-outlet partner
   * with ≥1 active outlet is never stranded. Tenant-scoped by `clientId`.
   */
  private async assertPartnerNotDeactivated(userId: string, clientId: string): Promise<void> {
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId, clientId, deletedAt: null },
      select: { id: true, isActive: true },
    });
    if (!partner) return;
    const activeOutlets = await this.prisma.outlet.count({
      where: { partnerId: partner.id, clientId, isActive: true, deletedAt: null },
    });
    if (partner.isActive === false || activeOutlets === 0) {
      throw new ForbiddenException(
        'Your account is inactive — your outlet has been deactivated. Please contact your Deoleo representative.',
      );
    }
  }

  private generateOtpCode(): string {
    // 6-digit OTP (100000–999999) via CSPRNG — see common/otp.ts (AF-10).
    return generateNumericOtp();
  }

  private async sendViaMSG91(phone: string, otp: string, channel: 'SMS' | 'WHATSAPP', clientId?: string): Promise<void> {
    // Delegates to the shared Msg91Service — behavior is byte-identical to the
    // former inline implementation (FIXED_OTP/missing-authKey bypasses + the
    // HTTP-200-with-{type:'error'} failure check live there now).
    // Per-tenant login template; undefined (no clientId / no override) → global env template.
    const tpl = await this.tenantSettings.getOtpTemplateId(clientId, 'login');
    await this.msg91.sendOtp(phone, otp, channel, tpl);
  }
}
