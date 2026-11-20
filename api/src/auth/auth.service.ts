import {
  Injectable, UnauthorizedException, BadRequestException,
  Logger, ForbiddenException, NotFoundException,
  HttpException, HttpStatus, ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, User, UserSession } from '@prisma/client';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { Msg91Service } from '../notifications/msg91.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { TenantService } from '../tenant/tenant.service';
import { isFixedOtpAllowed } from '../common/fixed-otp';
import { generateNumericOtp } from '../common/otp';
import { claimOtpAttempt, markOtpUsed, whyOtpClaimRefused } from '../common/otp-attempt';
import { GifsyTenantGrantService } from '../common/rbac/gifsy-tenant-grant.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { ALL_PERMISSIONS } from '../common/rbac/permissions';
import { captureOtpDeliveryHandle } from '../notifications/otp-delivery';
import {
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_WINDOW_HOURS,
  OTP_MAX_RESENDS_PER_WINDOW,
  SESSION_TTL_DAYS,
  ACCESS_TTL,
} from './auth.constants';
import {
  resolveLoginPartnerDisplay,
  isPartnerLoginRole,
  PartnerDisplayIdentity,
} from '../partner/partner-display.helper';
import { resolveNextActiveManager } from '../sales/sales-hierarchy.loader';
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
// 6s (was 5s): measured from the rotation's COMMIT, it must cover the client's give-up (5s) + its
// one 200ms retry — see the refresh timing budget below. Exported for the timing-invariant tests.
export const ROTATION_GRACE_MS = 6_000;

/**
 * ── Refresh timing budget (F1, 2026-11-19) — the rule: the server NEVER commits a rotation after
 * the client has given up on it. All values are kept in lockstep with platform/src/lib/auth-refresh.ts.
 *
 *   client starts attempt (t0) ────────────────────────────────────────────────────────────────┐
 *   server commit DEADLINE  = receipt + clamp(x-refresh-budget-ms, 500ms, REFRESH_SERVER_BUDGET_MS │
 *                             (4.0s)), further SHORTENED (never below receipt + 500ms) by the     │
 *                             caller's absolute x-refresh-deadline (t0 + 4s) — the relative part  │
 *                             bounds skew, the absolute part covers pre-receipt cold start        │
 *     · tx connection wait  ≤ REFRESH_TX_OPTS.maxWait   (1.5s)                                   │
 *     · each lock wait      ≤ REFRESH_LOCK_TIMEOUT      (1s: FOR SHARE on user, claim on session)│
 *     · whole tx            ≤ REFRESH_TX_OPTS.timeout   (4s)                                     │
 *     · deadline re-checked before the tx starts AND as the LAST statement before COMMIT → a     │
 *       late request rolls back (503, transient) instead of committing                           │
 *   client gives up         = t0 + REFRESH_TIMEOUT_MS (5.0s)  ≥ deadline + 1s (commit + transit) ┘
 *   client retry (document) = give-up + 200ms  → arrives ≤ t0 + 5.2s (+ transit)
 *   grace window            = ROTATION_GRACE_MS (6s) measured from COMMIT time (the predecessor's
 *                             revokedAt is re-stamped as the last statement in the tx), so the
 *                             retry of a committed-but-unanswered rotation (commit ≥ t0) is at most
 *                             ~5.2s + transit old → still handed the successor. A cold start or pool
 *                             wait before the server sees the request only shrinks the server's
 *                             remaining budget (the deadline is client-anchored); it can't push a
 *                             commit past the client's give-up.
 */
export const REFRESH_SERVER_BUDGET_MS = 4_000;
/**
 * H4/C1/S-H1 (owner 2026-11-20): never-used-successor handback. No age cap any more (C1: an app switch of
 * hours or days must not force a login) — the handback RENEWS FORWARD from the live tip, bounded only by
 * the tip's own 30-day sliding session. These bound the lineage walk and the repeat alarm.
 */
export const MAX_HANDBACK_CHAIN = 50;
/** S-H1(c): ≥ this many handbacks for ONE user inside the window raise a SECURITY_EVENT. */
export const HANDBACK_REPEAT_THRESHOLD = 2;
export const HANDBACK_REPEAT_WINDOW_MS = 24 * 60 * 60_000;

/** Per-request refresh context (receipt time, commit deadline, client device fingerprint). */
interface RefreshCtx {
  receivedAt: number;
  deadline: number;
  fingerprint: string | null;
}
/** Floor for a caller-supplied budget (S2): no caller can force an instant 503 probe. */
export const REFRESH_MIN_BUDGET_MS = 500;
export const REFRESH_LOCK_TIMEOUT = '1s';
export const REFRESH_TX_OPTS = { maxWait: 1_500, timeout: 4_000 } as const;

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
    const [dbUser, channelPartner, salesUser, settings, visibilityCaptureMode, display] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.sub }, select: { name: true, phone: true } }),
      this.prisma.channelPartner.findUnique({
        where: { userId: user.sub },
        select: {
          id: true, partnerCode: true, businessName: true, ownerName: true,
          phone: true, email: true, gstNumber: true, panNumber: true, entityType: true,
          // Beneficiary (KYC) — the partner reading THEIR OWN payout rails so the
          // cash-redeem FE can show what it will pay to (tenant-safe: keyed on user.sub).
          // JOB B (PAYMENT-DETAILS-AT-REDEMPTION): the RAW bank/upi fields are KEPT unchanged
          // here — the partner redemption flow needs them to decide "has beneficiary" and to
          // create the payout. We additionally return `paymentDetailsStatus` so the FE profile
          // page can HIDE the payout card until a payout confirms the details (VERIFIED). The
          // rewards page keeps reading the raw fields.
          bankName: true, bankAccountNumber: true, bankAccountHolder: true,
          ifscCode: true, upiId: true, upiCaptureMethod: true, paymentMode: true,
          paymentDetailsStatus: true,
          // Primary outlet's payout MANDATE — so the capture-at-redemption FE can PIN the
          // bank/UPI mode client-side (the backend re-validates it authoritatively regardless).
          outlets: {
            where: { deletedAt: null },
            select: { requiredPaymentType: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      }),
      this.prisma.salesUser.findUnique({
        // F4: a REMOVED (soft-deleted) sales user gets no sales identity back (salesUser: null).
        where: { userId: user.sub, deletedAt: null },
        select: {
          id: true, employeeCode: true, region: true, zone: true, clientId: true,
          // Reporting manager — surfaced on /sales/profile (name + designation + phone).
          // R3: isActive/deletedAt decide whether the DIRECT manager can be shown (see below).
          reportingTo: {
            select: {
              id: true,
              isActive: true,
              deletedAt: true,
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
      // Partner-shell header identity (partner roles only; null otherwise) — the same values the
      // OTP-login reply carries, so a live-cookie/empty-storage re-hydrate (login page) also
      // paints the outlet name from the first frame. Never throws.
      this.resolveLoginDisplay(user.role, user.sub, user.clientId, user.phone ?? null),
    ]);

    // R3 (G3, PLATFORM-WIDE owner-approved 2026-11-17): the profile's "reporting manager" is the NEXT ACTIVE
    // manager — the person this rep's KYCs are routed to (resolveInitialRouting's rule). A soft-deleted /
    // deactivated direct manager is never shown; the walk continues up the chain (resolveNextActiveManager).
    // Fast path: a live+active direct manager is shown as before (no extra query). Response shape unchanged.
    // F5: a vacant direct manager → a bounded walk up by id lookups (no full-tenant load per /auth/me).
    let salesUserOut: Record<string, unknown> | null = null;
    if (salesUser) {
      const { reportingTo, clientId: suClientId, ...rest } = salesUser;
      let manager: { user: { name: string | null; phone: string | null } | null; hierarchyLevel: { name: string } | null } | null =
        reportingTo && reportingTo.isActive && reportingTo.deletedAt == null
          ? { user: reportingTo.user, hierarchyLevel: reportingTo.hierarchyLevel }
          : null;
      if (!manager && reportingTo) {
        const next = await resolveNextActiveManager(this.prisma, suClientId, reportingTo.id);
        manager = next ? { user: next.user, hierarchyLevel: next.hierarchyLevel ? { name: next.hierarchyLevel.name } : null } : null;
      }
      salesUserOut = { ...rest, reportingTo: manager };
    }

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
        visibilityCaptureMode,
        redemptionChannels:     settings.redemptionChannels,
        salesApp:               settings.salesApp,
      },
      user: {
        id: user.sub,
        name: dbUser?.name ?? user.name,
        phone: dbUser?.phone ?? null,
        role: user.role,
        // ADDITIVE, partner roles only (absent for every other role — reply unchanged).
        ...(display ? { businessName: display.businessName, outletName: display.outletName } : {}),
        channelPartner: channelPartner
          ? (() => {
              const { outlets, ...cp } = channelPartner;
              return {
                ...cp,
                // Flat payout mandate for the FE mode pin; the raw outlets[] is not surfaced.
                requiredPaymentType: outlets?.[0]?.requiredPaymentType ?? null,
                wallets: wallet ? [wallet] : [],
              };
            })()
          : null,
        salesUser: salesUserOut,
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
    // controller's per-phone @Throttle (5/60s) bounds probing (verifyOtp remains the authoritative gate).
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
    // across ALL Cloud Run instances (the controller's @Throttle is per-phone but in-memory
    // PER-INSTANCE, so multi-instance distribution bypasses it). This is the real
    // anti-SMS-bombing control — a simple cooldown still allows sustained volume; a
    // windowed COUNT caps the total a victim's number can receive. Skipped only when the
    // fixed-OTP dev/staging bypass is active so UAT can request freely.
    const OTP_WINDOW_MS = OTP_RESEND_WINDOW_HOURS * 60 * 60 * 1000;   // 1 hour
    const OTP_MAX_PER_WINDOW = OTP_MAX_RESENDS_PER_WINDOW;
    const windowStart = new Date(Date.now() - OTP_WINDOW_MS);
    const fixedOtpActive = isFixedOtpAllowed() && !!this.config.get<string>('FIXED_OTP');

    if (!fixedOtpActive) {
      const recentSends = await this.prisma.otpCode.count({
        // LOGIN-only: KYC-consent / redemption / scheme OTPs sent to the same number are their own
        // flows (each with its own limits) and must not eat this number's login budget.
        where: { phone: cleanPhone, purpose: 'LOGIN', createdAt: { gte: windowStart } },
      });
      if (recentSends >= OTP_MAX_PER_WINDOW) {
        // Distinct from the throttler's "throttle.rejected" line (IdentityThrottlerGuard): this is the
        // cross-instance DB cap. Masked — never log the raw number.
        this.logger.warn(
          `[otp-send-cap] ${JSON.stringify({ event: 'otp.send_cap', phone: `******${cleanPhone.slice(-4)}`, recentSends, max: OTP_MAX_PER_WINDOW, windowHours: OTP_RESEND_WINDOW_HOURS })}`,
        );
        throw new HttpException(
          'Too many OTP requests for this number. Please wait a while before trying again.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      // (Small race at the window boundary can let a couple extra through under high
      // concurrency — acceptable for an anti-abuse cap; the per-phone throttle bounds the
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

    const otpRow = await this.prisma.otpCode.create({
      data: {
        phone:      cleanPhone,
        code:       otp,
        purpose:    'LOGIN',
        expiresAt,
        maxAttempts: OTP_MAX_ATTEMPTS,
      },
    });

    // Send via MSG91 — pass the tenant so the per-tenant login template can be resolved.
    const sendRes = await this.sendViaMSG91(cleanPhone, otp, channel, clientId);

    // Light D1 OTP delivery tracking — persist MSG91's request id + mark the row SENT. Best-effort:
    // captureOtpDeliveryHandle NEVER throws, so this can never affect the OTP send behaviour above.
    await captureOtpDeliveryHandle(this.prisma, otpRow.id, sendRes);

    // Mask the phone in logs (PII) — last 4 digits only. cleanPhone is the 10-digit number.
    this.logger.log(`OTP sent to ****${cleanPhone.slice(-4)} via ${channel}`);
    return { success: true, expiresIn: OTP_EXPIRY_MINUTES * 60 };
  }

  // ── Verify OTP + issue tokens ────────────────────────────────────────────────

  async verifyOtp(
    phone: string,
    otp: string,
    clientId: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: Partial<User> & Partial<PartnerDisplayIdentity>;
  }> {
    const cleanPhone = phone.replace(/\D/g, '');

    // LOGIN-purpose only: the phone may also hold an unverified REDEMPTION_CONFIRM / KYC_CONSENT /
    // scheme OTP, and a login attempt must never read (or burn attempts on) one of those. `purpose` is
    // a NOT NULL enum and sendOtp always writes 'LOGIN', so there are no legacy null-purpose login rows.
    // (OtpCode has no tenant column — the tenant is enforced by the user lookup below.)
    const record = await this.prisma.otpCode.findFirst({
      where:   { phone: cleanPhone, purpose: 'LOGIN', verifiedAt: null },
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

    // Claim this attempt ATOMICALLY before comparing the code. The read above is only a cheap
    // pre-check: N parallel requests all read the same `attempts`, so a read-then-write counter let
    // ~100 concurrent guesses through before it reached maxAttempts (audit L1). The conditional
    // increment is the single serialisation point — only maxAttempts claims can ever win, and a
    // losing claim is never compared (even a correct code), so it cannot mint a session.
    const claimed = await claimOtpAttempt(this.prisma, record);
    if (claimed === null) {
      // Refused: re-read so a code superseded/expired or pruned meanwhile gets the honest message (L1).
      const why = await whyOtpClaimRefused(this.prisma, record.id);
      if (why === 'EXPIRED') throw new UnauthorizedException('OTP expired — please request a new one.');
      if (why === 'GONE') throw new UnauthorizedException('No active OTP found for this number. Please request a new OTP.');
      throw new ForbiddenException('Too many attempts — please request a new OTP.');
    }

    const isCorrect = fixedOtp ? otp === fixedOtp : otp === record.code;

    if (!isCorrect) {
      // From the atomic claim's post-increment value — exact under parallel guesses (not the stale read).
      const remaining = Math.max(0, record.maxAttempts - claimed);
      throw new UnauthorizedException(`Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`);
    }

    // Mark OTP as used — CONDITIONALLY, so two parallel correct submissions can't both mint a session.
    if (!(await markOtpUsed(this.prisma, record.id))) {
      throw new UnauthorizedException('No active OTP found for this number. Please request a new OTP.');
    }

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

    // VENDOR login gate (suspend/revoke cascade) — blocks a vendor whose entity is
    // suspended or whose grant for this tenant was revoked (review CRITICAL #2).
    await this.assertVendorLoginAllowed({ id: user.id, role: user.role, vendorId: user.vendorId, clientId });

    // Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data:  { lastLoginAt: new Date(), loginCount: { increment: 1 } },
    });

    const tokens = await this.generateTokens(user);
    this.logger.log(`User ${user.id} (${user.role}) logged in — client: ${clientId}`);

    // Partner-shell header identity (ADDITIVE; partner logins only). The same businessName/outletName
    // GET /partner/me returns for the login's default outlet, so the retailer-app header paints the
    // OUTLET name from the first frame instead of the person's name. Display-only: a failure here
    // must never block a login, so it degrades to the legacy reply (FE then waits for /partner/me).
    const display = await this.resolveLoginDisplay(user.role, user.id, clientId, user.phone);

    return {
      ...tokens,
      user: {
        id:    user.id,
        name:  user.name,
        role:  user.role,
        phone: user.phone,
        ...(display ? { businessName: display.businessName, outletName: display.outletName } : {}),
      },
    };
  }

  /**
   * Partner-shell header identity for the login reply AND the /auth/me re-hydrate (one rule:
   * partner-display.helper). Non-partner roles never query (returns null → reply unchanged).
   * Display-only: any failure degrades to null rather than failing the login / me call.
   */
  private async resolveLoginDisplay(
    role: string | null | undefined,
    userId: string,
    clientId: string,
    phone: string | null,
  ): Promise<PartnerDisplayIdentity | null> {
    if (!isPartnerLoginRole(role)) return null;
    try {
      return await resolveLoginPartnerDisplay(this.prisma, { clientId, userSub: userId, phone });
    } catch (err) {
      this.logger.warn(`Login display identity unavailable for user ${userId}: ${(err as Error)?.message}`);
      return null;
    }
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
    opts?: {
      clientIdOverride?: string;
      assumed?: boolean;
      expiresIn?: string;
      rotatedFromId?: string;
      /** S-H1(a): device fingerprint of the request that created this session (refresh path). */
      createdFingerprint?: string | null;
      /** Write the session row through this transaction client (refresh claim+mint atomicity). */
      db?: Prisma.TransactionClient;
    },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const clientId = opts?.clientIdOverride ?? user.clientId;
    // Pre-generate the session id so it can be embedded in the JWT (`sid`) AND used as
    // the UserSession PK — jwt.strategy then binds the bearer token to THIS session, so
    // revoke/rotate kills the access token on its next request (not after a 30-day TTL).
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
      // Gift Catalogue & Dispatch (Wave 2) — carry the vendor login's Vendor id so the
      // vendor portal can HARD-scope by vendorId without a user lookup. Null for every
      // non-vendor user → omitted from the token.
      ...(user.vendorId ? { vendorId: user.vendorId } : {}),
    };

    // SHORT access-token lifetime — DECOUPLED from the 30-day session/refresh window so
    // the rolling session actually rolls. Both the normal and the assumed (A2) paths sign
    // a 60m (ACCESS_TTL) access token; env JWT_EXPIRES_IN may override in a deployment (set
    // to 60m everywhere), and the CODE default is ACCESS_TTL — NEVER the old 30d, which made
    // the feature inert. The session ROW below still lives SESSION_TTL_DAYS (30d), sliding on
    // each refresh/guard hit. expiresIn accepts the `ms` StringValue | number; cast to string.
    const expiresIn = (opts?.expiresIn ?? this.config.get('JWT_EXPIRES_IN') ?? ACCESS_TTL) as string;
    const accessToken  = this.jwt.sign(payload, {
      secret:    this.config.get('JWT_SECRET'),
      expiresIn: expiresIn as unknown as number,
    });

    const refreshToken = crypto.randomBytes(40).toString('hex');
    // Sliding-session idle window — both the assumed (ASSUMED_SESSION_TTL_HOURS = 720h)
    // and normal (SESSION_TTL_DAYS = 30d) branches are exactly 30 days. Each refresh
    // calls generateTokens, so expiresAt is re-minted to now+30d on every refresh (roll-on-
    // refresh); the jwt.strategy guard slides it the same way on ordinary access.
    const ttlMs        = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;   // 30 days (assumed == normal)
    const expiresAt    = new Date(Date.now() + ttlMs);

    await (opts?.db ?? this.prisma).userSession.create({
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
        ...(opts?.createdFingerprint ? { createdFingerprint: opts.createdFingerprint } : {}),
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
   *     the assumed SESSION row still lives the 30-day sliding window (ASSUMED_SESSION_TTL_HOURS==30d).
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
      // row is 30d (SESSION_TTL_DAYS) inside generateTokens, so the assumed session slides.
      expiresIn: ACCESS_TTL,
    });

    this.logger.log(
      `GIFSY operator ${operator.sub} assumed tenant ${targetClientId} (from ${operator.clientId})`,
    );

    return { ...tokens, clientId: targetClientId, brandName: target.internalName };
  }

  /**
   * POST /v1/auth/exit-tenant — the AUTHORITATIVE inverse of assume-tenant (#51 fix).
   *
   * Re-mints a fresh UN-ASSUMED session for the operator's REAL home identity, derived from
   * the (assumed) token's `sub` — so it does NOT depend on the client-side `home_token`
   * cookie stash. That stash is only a fast-path optimisation; when it is missing or expired
   * (>30d of assumed work, a multi-tab drop, or a pre-stash assume) the FE's cookie-swap Exit
   * silently no-ops and STRANDS the operator on the assumed token under platform chrome
   * (the reported bug). This endpoint is the stash-independent fallback the FE calls in that
   * case, guaranteeing Exit always lands the operator back in their home (un-assumed) context.
   *
   *   - GIFSY_ADMIN / GIFSY_STAFF only (defense-in-depth beyond the controller @Roles);
   *   - identity is fixed to the caller's real `sub` → no escalation: the minted token carries
   *     the operator's OWN home clientId + role (an un-assumed staff token is still NOT
   *     platform-wide, per tenant-scope.ts) — exactly what a fresh login would grant;
   *   - `assumed` is omitted → a clean platform token (clears the FE banner);
   *   - audit-logged (action LOGOUT + metadata.event=EXIT_TENANT) on the same trail as assume.
   */
  async exitTenant(
    operator: JwtPayload,
  ): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
    if (operator.role !== 'GIFSY_ADMIN' && operator.role !== 'GIFSY_STAFF') {
      throw new ForbiddenException('Only Gifsy operators may exit a brand context');
    }
    // Exit is only meaningful FROM an assumed session — refuse an un-assumed caller so this never
    // mints a spurious home session or writes a from==to EXIT_TENANT audit row (audit F4).
    if (operator.assumed !== true) {
      throw new BadRequestException('Not in an assumed tenant context');
    }

    // The real operator user — their home clientId + role define the un-assumed session.
    const opUser = await this.prisma.user.findFirst({
      where: { id: operator.sub, deletedAt: null },
    });
    if (!opUser) throw new UnauthorizedException('Operator account not found');

    // Mint a fresh session for the operator's OWN home clientId with NO assumed flag: no
    // clientIdOverride (→ opUser.clientId) and no `assumed` → an un-assumed platform token.
    // Minted FIRST, so a failure in the revoke below can never leave the operator session-less.
    const tokens = await this.generateTokens(opUser, { expiresIn: ACCESS_TTL });

    // AUTHORITATIVE termination (audit F1, S4): revoke the assumed session being exited AND its
    // WHOLE rotation lineage (every hop, incl. an in-flight refresh's successor — see
    // revokeSessionLineage), so the assumed refresh-token lineage can no longer self-renew for
    // the 30-day session window after Exit — a second device / prior tab still holding the assumed
    // refresh token is cut off (its next refresh hits a revoked row → 401). Scoped to the caller's
    // own userId (defense-in-depth). Skipped only for legacy tokens with no `sid`.
    if (operator.sid) {
      await this.revokeSessionLineage(operator.sub, operator.sid);
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'LOGOUT',
        entityType: 'CLIENT',
        entityId: operator.clientId,
        actorId: operator.sub,
        metadata: {
          event: 'EXIT_TENANT',
          fromClientId: operator.clientId,
          toClientId: opUser.clientId,
        },
      },
    });

    this.logger.log(
      `GIFSY operator ${operator.sub} exited tenant ${operator.clientId} → home ${opUser.clientId}`,
    );

    return { ...tokens, clientId: opUser.clientId };
  }

  /**
   * Revoke a session AND every session that rotated out of it, however many hops deep (S4).
   * The old exit-tenant revoke covered only `sid` + its DIRECT successor, so a second hop (a
   * prior tab that had already rotated twice) or an IN-FLIGHT refresh of the tip survived.
   *
   * Why the walk is complete even against an in-flight refresh: refresh claims the predecessor
   * and inserts its successor in ONE transaction holding the predecessor's row lock. Our revoke
   * of a frontier row therefore either (a) runs first → that refresh's claim later sees it
   * revoked and mints nothing, or (b) blocks on the refresh's lock until it COMMITS → the
   * successor is committed before our revoke returns, so the next `findMany` sees it and the
   * walk revokes it too. Scoped to the caller's own userId (defense-in-depth).
   */
  private async revokeSessionLineage(userId: string, rootSessionId: string): Promise<void> {
    const now = new Date();
    const seen = new Set<string>([rootSessionId]);
    let frontier = [rootSessionId];
    // Bounded: a lineage is a chain (one successor per rotation); 10k hops ≈ a year of hourly use.
    for (let hop = 0; frontier.length > 0 && hop < 10_000; hop++) {
      await this.prisma.userSession.updateMany({
        where: { userId, id: { in: frontier }, revokedAt: null },
        data:  { revokedAt: now },
      });
      const children = await this.prisma.userSession.findMany({
        where:  { userId, rotatedFromId: { in: frontier } },
        select: { id: true },
      });
      frontier = children.map((c) => c.id).filter((id) => !seen.has(id));
      frontier.forEach((id) => seen.add(id));
    }
  }

  // ── Refresh token ────────────────────────────────────────────────────────────

  async refreshToken(
    refreshToken: string,
    opts: { budgetMs?: number; receivedAt?: number; clientDeadlineMs?: number; fingerprint?: string | null } = {},
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // H2 — the instant this request was received; grace is judged against it.
    const receivedAt = opts.receivedAt ?? Date.now();
    // F1/S3 — commit deadline = receipt + the caller's RELATIVE budget (x-refresh-budget-ms; no
    // cross-machine clock comparison), clamped to [MIN, MAX]. The floor (S2) stops a caller from
    // forcing an immediate 503 that would let a stolen token be probed with no rotation and no
    // alarm; the cap is our own budget. Past the deadline we must not COMMIT a rotation.
    const budget = Math.min(
      Math.max(opts.budgetMs ?? REFRESH_SERVER_BUDGET_MS, REFRESH_MIN_BUDGET_MS),
      REFRESH_SERVER_BUDGET_MS,
    );
    let deadline = receivedAt + budget;
    // Secondary cap: the caller's ABSOLUTE give-up time (x-refresh-deadline) covers what a relative
    // budget can't see — time spent BEFORE we received the request (cold start, network). It may only
    // SHORTEN the window, and never below the floor, so clock skew can neither extend the deadline
    // (S3) nor force an instant 503 (S2).
    if (opts.clientDeadlineMs !== undefined && Number.isFinite(opts.clientDeadlineMs)) {
      deadline = Math.max(receivedAt + REFRESH_MIN_BUDGET_MS, Math.min(deadline, opts.clientDeadlineMs));
    }
    const ctx: RefreshCtx = { receivedAt, deadline, fingerprint: opts.fingerprint ?? null };

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
    // forward. (The DURING-refresh race is closed inside the claim transaction.)
    if (
      session.user.sessionsInvalidBefore &&
      session.createdAt < session.user.sessionsInvalidBefore
    ) {
      throw new UnauthorizedException('Session expired — please log in again.');
    }

    // The predecessor's revocation time as READ — what the grace window is judged against for a
    // replay of an already-revoked token. A claim lost below marks a proven concurrent sibling.
    const predecessorRevokedAt: Date | null = session.revokedAt;
    let lostConcurrentClaim = false;

    // ── Live path: the token is unrevoked and unexpired → normal rotation by its HOLDER ─────────
    if (session.revokedAt === null && new Date() <= session.expiresAt) {
      const outcome = await this.rotateSession(session, ctx, 'holder');
      if (outcome.kind === 'won') return outcome.tokens;
      if (outcome.kind === 'swept') throw new UnauthorizedException('Session expired — please log in again.');
      // claim LOST: our read saw the row LIVE at the start of THIS request and the claim found
      // it revoked, so the revoke happened DURING this request — by construction a concurrent
      // sibling (or a logout / sweep racing us), never a stale replay. Our claim blocked on the
      // winner's row lock until it COMMITTED, so its successor (if any) is visible now. Treat it
      // as in-grace regardless of how long the winner's transaction took.
      // (A revoke by logout/sweep leaves no LIVE successor → the in-grace branch just 401s.)
      lostConcurrentClaim = true;
    }

    // H2 — judge the age at RECEIPT, not "now": a slow pool / DB read between receipt and here
    // must not turn a legitimate in-grace retry into "reuse".
    const withinGrace =
      lostConcurrentClaim ||
      (predecessorRevokedAt !== null &&
        receivedAt - predecessorRevokedAt.getTime() <= ROTATION_GRACE_MS);

    // ── Converge on the LIVE successor — ONLY inside the grace window (S1) ─────────────────
    // A predecessor revoked within the last ROTATION_GRACE_MS is a concurrent sibling of the
    // refresh that rotated it (parallel proxy hits, two tabs, proxy + guard). Hand back the
    // successor's STORED pair (minted in the same transaction as the revoke → its access token is
    // seconds old). A successor revoked by a logout / sweep is excluded by revokedAt:null.
    if (withinGrace) {
      const successor = await this.prisma.userSession.findFirst({
        where: { rotatedFromId: session.id, revokedAt: null },
      });
      if (successor && successor.refreshToken) {
        return { accessToken: successor.token, refreshToken: successor.refreshToken };
      }
      // In grace but nothing live to converge on (just logged out / swept) → plain 401.
      throw new UnauthorizedException('Session expired — please log in again.');
    }

    // ── Outside the grace window: a REVOKED (rotated) token is being replayed ───────────────────
    // A merely EXPIRED-but-never-revoked session (revokedAt === null) is not reuse → plain 401.
    if (predecessorRevokedAt !== null) {
      const handback = await this.handbackUnusedSuccessor(session, ctx);
      if (handback.kind === 'tokens') return handback.tokens;
      if (handback.kind === 'kill') await this.killLineage(session, handback.reason);
    }

    throw new UnauthorizedException('Session expired — please log in again.');
  }

  /**
   * Claim `session` and mint its successor, atomically (concurrent-refresh race fix, 2026-11-19).
   *
   * The claim UPDATE takes the session's row lock and holds it until the successor row is COMMITTED, so
   * a concurrent refresh of the same token blocks, then (READ COMMITTED re-check) sees it revoked →
   * count 0 → 'lost' → converges on the committed successor. The access GATES (grant / partner /
   * vendor) run BEFORE the transaction on the shared client (read-only; no second pool connection while
   * the row lock is held → no pool-starvation deadlock).
   *
   *  mode 'holder'   — the session's own refresh token was presented (normal refresh). The claim also
   *                    marks the session USED (firstUsedAt): a holder refreshing it means it was received.
   *  mode 'handback' — C1 renew-forward on behalf of a post-grace replay of an OLDER token in the lineage
   *                    (see handbackUnusedSuccessor). The claim is CONDITIONAL — still unused, never handed
   *                    back (S-H1b: at most one handback per session) — and stamps handedBackAt.
   */
  private async rotateSession(
    session: UserSession & { user: User },
    ctx: RefreshCtx,
    mode: 'holder' | 'handback',
  ): Promise<
    { kind: 'swept' } | { kind: 'lost' } | { kind: 'won'; tokens: { accessToken: string; refreshToken: string } }
  > {
    const assertBeforeDeadline = () => {
      if (Date.now() >= ctx.deadline) {
        throw new ServiceUnavailableException('Session refresh timed out — please retry.');
      }
    };
    const claim = (db: Prisma.TransactionClient) => {
      const now = new Date();
      return mode === 'holder'
        ? db.userSession.updateMany({
            where: { refreshToken: session.refreshToken, revokedAt: null },
            data:  { revokedAt: now, firstUsedAt: now },
          })
        : db.userSession.updateMany({
            where: { id: session.id, revokedAt: null, firstUsedAt: null, handedBackAt: null },
            data:  { revokedAt: now, handedBackAt: now },
          });
    };

    let isAssumed = false;
    try {
      // Preserve the operator-context (A2): an assumed session's row carries the TENANT clientId while
      // its user's home clientId is `gifsy`. RBAC Option-X (P5): both GIFSY_ADMIN and a scoped
      // GIFSY_STAFF can be assumed — a demoted/regular user never matches (clientId == home).
      isAssumed =
        session.clientId !== session.user.clientId &&
        (session.user.role === 'GIFSY_ADMIN' || session.user.role === 'GIFSY_STAFF');

      // Defense-in-depth (P5): a staff whose grant for the assumed tenant was revoked must not roll the
      // assumed scope forward (AUTHORITATIVE uncached check — P5 audit F1).
      if (isAssumed && session.user.role === 'GIFSY_STAFF') {
        if (!(await this.gifsyTenantGrants.hasGrantUncached(session.user.id, session.clientId))) {
          throw new UnauthorizedException('Session expired — please log in again.');
        }
      }

      // Deactivated-outlet gate on every refresh (HOME tenant; no-op for an assumed operator).
      await this.assertPartnerNotDeactivated(session.user.id, session.user.clientId);

      // VENDOR login gate on refresh too — a suspended/revoked vendor can't roll forward.
      await this.assertVendorLoginAllowed({
        id: session.user.id,
        role: session.user.role,
        vendorId: session.user.vendorId,
        clientId: session.user.clientId,
      });
    } catch (gateError) {
      // Only a DELIBERATE refusal (the gates throw 401/403) consumes the session. A transient failure
      // (DB timeout, connection reset, …) leaves it LIVE so the caller's retry can succeed.
      if (gateError instanceof UnauthorizedException || gateError instanceof ForbiddenException) {
        await claim(this.prisma).catch(() => undefined); // never mask the refusal
      }
      throw gateError;
    }

    // Too late already (slow gates / pool wait / cold start)? Refuse BEFORE touching any lock.
    assertBeforeDeadline();

    try {
      return await this.prisma.$transaction(async (tx) => {
        // F1/F2 — fail fast: no single lock wait may exceed REFRESH_LOCK_TIMEOUT (55P03 → rollback → 503).
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${REFRESH_LOCK_TIMEOUT}'`);

        // ── logout-all authority INSIDE the lock (S2) ────────────────────────────────────────────
        // SHARE-lock the user row FIRST, then read the stamp. Every stamper UPDATEs that row: an
        // uncommitted stamp makes us wait and then refuse; a stamper arriving later waits for OUR
        // commit, so its sweep sees (and revokes) our successor. Lock order user → session, same as
        // every stamper (stamp, then sweep) → no deadlock.
        const rows =
          (await tx.$queryRaw<Array<{ sessionsInvalidBefore: Date | null }>>`
            SELECT "sessionsInvalidBefore" FROM "users" WHERE "id" = ${session.user.id} FOR SHARE`) ?? [];
        const stamp = rows[0]?.sessionsInvalidBefore ?? null;
        if (rows.length === 0 || (stamp && session.createdAt < stamp)) {
          return { kind: 'swept' as const };
        }

        const claimed = await claim(tx);
        if (claimed.count !== 1) return { kind: 'lost' as const }; // a concurrent winner COMMITTED first

        // Mint the successor, chained to THIS session (rotatedFromId) and bound to the device that
        // asked for it (createdFingerprint, S-H1a). Access token = ACCESS_TTL (60m); session row 30d.
        const minted = await this.generateTokens(
          session.user,
          isAssumed
            ? {
                clientIdOverride: session.clientId, assumed: true, expiresIn: ACCESS_TTL,
                rotatedFromId: session.id, createdFingerprint: ctx.fingerprint, db: tx,
              }
            : { rotatedFromId: session.id, createdFingerprint: ctx.fingerprint, db: tx },
        );

        // F1 — the LAST statements before COMMIT: (1) never commit past the deadline (rollback, the
        // session stays live); (2) F4 — re-stamp revokedAt NOW so the grace window runs from commit.
        assertBeforeDeadline();
        await tx.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
        // H1 — NOTHING runs after this commit: a committed rotation MUST reach the client.
        return { kind: 'won' as const, tokens: minted };
      }, REFRESH_TX_OPTS);
    } catch (txError) {
      if (txError instanceof HttpException) throw txError; // e.g. the deadline 503
      // Lock timeout (55P03), tx maxWait/timeout (P2028), connection errors: transient — nothing
      // committed, the session is still live, the client should retry.
      this.logger.warn(`Refresh transaction failed (transient): ${(txError as Error)?.message ?? txError}`);
      throw new ServiceUnavailableException('Session refresh temporarily unavailable — please retry.');
    }
  }

  /**
   * H4 + C1 + S-H1 (owner decisions 2026-11-20): a ROTATED token replayed after the grace window.
   *
   * The common legitimate cause is a client whose refresh RESPONSE was lost (an app switch mid-request):
   * it still holds the old token, and the session it never received sits unused. The owner's rule:
   * that must NOT force a login — but a thief replaying a stolen old token must not get in either.
   *
   * Walk the lineage forward from the replayed token to its live tip, then:
   *  - any link USED (firstUsedAt: its access token authenticated a request, or its holder refreshed it)
   *    → 'kill' (strict reuse, exactly as before);
   *  - S-H1a device binding: the replaying request's fingerprint must match the one recorded when the
   *    FIRST successor was created (the lost-response device is the one that asked for it) → else 'kill';
   *  - S-H1b at most ONE handback per lineage step: if a link was already handed back, only a replay
   *    within the grace window of that handback converges (concurrent siblings of the same resume);
   *    anything later → 'kill';
   *  - tip naturally expired (30-day window lapsed) → 'refuse' (plain 401, no alarm);
   *  - otherwise C1 RENEW FORWARD: rotate the tip with the normal rules (gates, logout-all check,
   *    deadline) under a CONDITIONAL claim (still unused + never handed back), so the client gets a FRESH
   *    pair however long it was away (no 60-min cap) and the lineage stays a single chain.
   */
  private async handbackUnusedSuccessor(
    predecessor: UserSession & { user: User },
    ctx: RefreshCtx,
    attempt = 0,
  ): Promise<
    | { kind: 'tokens'; tokens: { accessToken: string; refreshToken: string } }
    | { kind: 'kill'; reason: string }
    | { kind: 'refuse' }
  > {
    const links: UserSession[] = [];
    let cursor = predecessor.id;
    for (let hop = 0; hop < MAX_HANDBACK_CHAIN; hop++) {
      const next = await this.prisma.userSession.findFirst({
        where: { rotatedFromId: cursor, userId: predecessor.userId },
        orderBy: { createdAt: 'asc' },
      });
      if (!next) break;
      links.push(next);
      if (next.revokedAt === null) break;
      cursor = next.id;
    }
    const tip = links[links.length - 1];
    if (!tip || tip.revokedAt !== null) return { kind: 'kill', reason: 'no_live_successor' };
    if (links.some((l) => l.firstUsedAt !== null)) return { kind: 'kill', reason: 'successor_used' };
    const creatorFingerprint = links[0].createdFingerprint;
    if (!ctx.fingerprint || !creatorFingerprint || ctx.fingerprint !== creatorFingerprint) {
      return { kind: 'kill', reason: 'device_mismatch' };
    }
    if (tip.expiresAt.getTime() <= ctx.receivedAt) return { kind: 'refuse' };

    const handedBack = links
      .map((l) => l.handedBackAt?.getTime() ?? 0)
      .filter((t) => t > 0);
    if (handedBack.length > 0) {
      const last = Math.max(...handedBack);
      // A concurrent sibling of the SAME resume (several requests carried the old token) converges on
      // the pair the first handback minted. Later → a second handback → strict (S-H1b / S-L1).
      if (ctx.receivedAt - last <= ROTATION_GRACE_MS && tip.refreshToken) {
        return { kind: 'tokens', tokens: { accessToken: tip.token, refreshToken: tip.refreshToken } };
      }
      return { kind: 'kill', reason: 'second_handback' };
    }

    const outcome = await this.rotateSession({ ...tip, user: predecessor.user }, ctx, 'handback');
    if (outcome.kind === 'swept') return { kind: 'refuse' };
    if (outcome.kind === 'lost') {
      // The tip changed under us (a concurrent replay handed it back, or its holder used/refreshed it):
      // re-evaluate once against the committed state.
      if (attempt >= 1) return { kind: 'kill', reason: 'handback_contended' };
      return this.handbackUnusedSuccessor(predecessor, ctx, attempt + 1);
    }

    await this.recordHandback(predecessor, tip, links.length, ctx);
    return { kind: 'tokens', tokens: outcome.tokens };
  }

  /** Audit a handback (info event) and raise a SECURITY_EVENT on repeats (S-H1c). Never blocks. */
  private async recordHandback(
    predecessor: UserSession & { user: User },
    tip: UserSession,
    chainLength: number,
    ctx: RefreshCtx,
  ): Promise<void> {
    const user = predecessor.user;
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'REFRESH_HANDOFF', // own action — a session continuation, NOT a security event
          entityType: 'AUTH_EVENT',
          entityId: user.id,
          actorId: user.id,
          targetUserId: user.id,
          metadata: {
            event: 'REFRESH_HANDOFF_UNUSED_SUCCESSOR',
            clientId: user.clientId,
            predecessorSessionId: predecessor.id,
            handedBackSessionId: tip.id,
            chainLength,
            ageMs: predecessor.revokedAt ? ctx.receivedAt - predecessor.revokedAt.getTime() : null,
          },
        },
      });
      const since = new Date(ctx.receivedAt - HANDBACK_REPEAT_WINDOW_MS);
      const recent = await this.prisma.auditLog.count({
        where: {
          entityType: 'AUTH_EVENT',
          entityId: user.id,
          createdAt: { gte: since },
          metadata: { path: ['event'], equals: 'REFRESH_HANDOFF_UNUSED_SUCCESSOR' },
        },
      });
      if ((recent ?? 0) >= HANDBACK_REPEAT_THRESHOLD) {
        // Repeated handbacks for one user are the signature of a thief sharing the session (S-H1c).
        await this.prisma.auditLog.create({
          data: {
            action: 'REFRESH_HANDOFF',
            entityType: 'SECURITY_EVENT',
            entityId: user.id,
            actorId: user.id,
            targetUserId: user.id,
            metadata: {
              event: 'repeated_unused_successor_handoff',
              clientId: user.clientId,
              handoffsIn24h: recent,
              detectedAt: new Date(ctx.receivedAt).toISOString(),
            },
          },
        });
        this.logger.warn(`Repeated unused-successor handbacks for user ${user.id}: ${recent} in 24h`);
      }
    } catch (auditError) {
      // Best-effort (never block the handback) — but not silent.
      this.logger.error(
        `Could not audit unused-successor handback for user ${user.id}: ${(auditError as Error)?.message ?? auditError}`,
      );
    }
    this.logger.log(`Refresh: renewed forward never-used session ${tip.id} for a post-grace replay (user ${user.id})`);
  }

  /**
   * Reuse detection (1c): STAMP sessionsInvalidBefore FIRST, then revoke every live session
   * (stamp-before-revoke, same authority logout-all uses), and write the platform security event.
   * Best-effort: a failed kill or audit must never mask the 401 the caller throws.
   */
  private async killLineage(session: UserSession & { user: User }, reason: string): Promise<void> {
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
      /* best-effort lineage kill — never mask the 401 */
    }
    this.logger.warn(
      `Refresh-token reuse detected for user ${session.user.id} (${reason}) — revoked all sessions`,
    );
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
            reason,
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
  /**
   * Gift Catalogue & Dispatch (Wave 2) — VENDOR login gate (suspend/revoke cascade,
   * review CRITICAL #2). A VENDOR user may authenticate ONLY while their Vendor is
   * ACTIVE and they hold an ACTIVE VendorTenantGrant for their pinned clientId
   * (decision #12: one tenant per vendor login). Suspending the vendor or revoking
   * the grant therefore stops the login on its next OTP-login OR refresh (≤ the 60m
   * access-token TTL), complementing the immediate data-boundary re-check the vendor
   * portal runs on every request. A non-VENDOR user is unaffected (no-op).
   */
  private async assertVendorLoginAllowed(user: {
    id: string;
    role: string;
    vendorId: string | null;
    clientId: string;
  }): Promise<void> {
    if (user.role !== 'VENDOR') return;
    if (!user.vendorId) {
      throw new ForbiddenException('This vendor login is not linked to a vendor. Contact Gifsy support.');
    }
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: user.vendorId },
      select: { status: true },
    });
    if (!vendor || vendor.status !== 'ACTIVE') {
      throw new ForbiddenException('This vendor account is suspended. Please contact Gifsy support.');
    }
    const grant = await this.prisma.vendorTenantGrant.findFirst({
      where: { vendorId: user.vendorId, clientId: user.clientId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!grant) {
      throw new ForbiddenException('This vendor is no longer authorised for this brand. Please contact Gifsy support.');
    }
  }

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

  private async sendViaMSG91(phone: string, otp: string, channel: 'SMS' | 'WHATSAPP', clientId?: string): Promise<{ requestId: string | null }> {
    // Delegates to the shared Msg91Service — behavior is byte-identical to the
    // former inline implementation (FIXED_OTP/missing-authKey bypasses + the
    // HTTP-200-with-{type:'error'} failure check live there now).
    // Per-tenant login template; undefined (no clientId / no override) → global env template.
    // Returns MSG91's `{ requestId }` (null under the DEV bypasses) for the light D1 delivery capture.
    const tpl = await this.tenantSettings.getOtpTemplateId(clientId, 'login');
    return this.msg91.sendOtp(phone, otp, channel, tpl);
  }
}
