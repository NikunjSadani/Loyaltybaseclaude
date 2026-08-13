// TDD: AuthService
// Tests written BEFORE implementation â€” each describes expected behaviour.
// Run: npx jest src/auth/auth.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Msg91Service } from '../notifications/msg91.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { TenantService } from '../tenant/tenant.service';

// getMe surfaces the tenant visibility-capture mode; default PHOTO_APPROVAL for tests.
const mockTenant = { resolveVisibilityCaptureMode: jest.fn(async () => 'PHOTO_APPROVAL') };

// â”€â”€â”€ Mocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const mockPrisma = {
  // findUnique added for refreshToken's post-mint sessionsInvalidBefore re-read (1b);
  // defaults to undefined so the guard is a no-op unless a test opts in.
  user:    { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  otpCode: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  userSession: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  client:  { findFirst: jest.fn() },
  auditLog: { create: jest.fn() },
  // Deactivated-outlet login gate: default to "no partner" so non-partner logins
  // skip the gate; the partner-login tests below override these.
  channelPartner: { findFirst: jest.fn() },
  outlet: { count: jest.fn() },
  // TenantSettingsService reads this (no rows -> typed defaults, conversionRate = env).
  programSetting: { findMany: jest.fn().mockResolvedValue([]) },
};

const gifsyOp = { sub: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' } as any;

const mockJwt = {
  sign:   jest.fn().mockReturnValue('mock.jwt.token'),
  verify: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    const cfg: Record<string, string> = {
      JWT_SECRET:              'test-secret',
      // Deployment now sets the access-token TTL to 60m (decoupled from the 7d session).
      JWT_EXPIRES_IN:          '60m',
      MSG91_AUTH_KEY:          'test-msg91-key',
      MSG91_SENDER_ID:         'GIFSY',
      MSG91_OTP_TEMPLATE_ID:   'test-template',
    };
    return cfg[key];
  }),
};

// â”€â”€â”€ Suite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService,  useValue: mockPrisma },
        { provide: JwtService,     useValue: mockJwt    },
        { provide: ConfigService,  useValue: mockConfig },
        // Real Msg91Service (A-2a): thin wrapper over the mocked ConfigService + global.fetch,
        // so the existing MSG91/fetch behaviour tests run unchanged through the delegate.
        Msg91Service,
        // Real TenantSettingsService over the mocked Prisma (no rows -> typed defaults,
        // so getMe's conversionRate still reflects POINTS_CONVERSION_RATE env in these tests).
        TenantSettingsService,
        { provide: TenantService, useValue: mockTenant },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // â”€â”€ getMe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('getMe', () => {
    const partnerUser = { sub: 'u1', role: 'CHANNEL_PARTNER', clientId: 'deoleo', phone: '99', name: 'P' } as any;

    beforeEach(() => {
      // getMe queries channelPartner/salesUser/wallet — extend the mock for this block.
      (mockPrisma as any).channelPartner = { findUnique: jest.fn() };
      (mockPrisma as any).salesUser = { findUnique: jest.fn() };
      (mockPrisma as any).wallet = { findUnique: jest.fn() };
    });

    it('returns the partner beneficiary fields + the authoritative conversionRate', async () => {
      process.env.POINTS_CONVERSION_RATE = '2';
      (mockPrisma.user.findFirst as any); // unused here
      (mockPrisma as any).user.findUnique = jest.fn().mockResolvedValue({ name: 'P', phone: '99' });
      (mockPrisma as any).channelPartner.findUnique.mockResolvedValue({
        id: 'cp1', partnerCode: 'PC1', businessName: 'Biz', ownerName: 'Owner',
        phone: '99', email: 'e@e.com', gstNumber: null, panNumber: null, entityType: 'PROPRIETORSHIP',
        bankName: 'HDFC', bankAccountNumber: '123456', bankAccountHolder: 'Owner',
        ifscCode: 'HDFC0001', upiId: 'owner@upi', paymentMode: 'UPI',
      });
      (mockPrisma as any).salesUser.findUnique.mockResolvedValue(null);
      (mockPrisma as any).wallet.findUnique.mockResolvedValue({
        earnedPoints: 100, redeemablePoints: 80, lockedPoints: 0, lifetimeEarned: 100,
      });

      const result = await service.getMe(partnerUser);

      // The select passed to channelPartner.findUnique must include the beneficiary fields.
      const selectArg = (mockPrisma as any).channelPartner.findUnique.mock.calls[0][0].select;
      expect(selectArg).toMatchObject({
        bankName: true, bankAccountNumber: true, bankAccountHolder: true,
        ifscCode: true, upiId: true, paymentMode: true,
      });

      const cp = result.user.channelPartner as any;
      expect(cp.bankName).toBe('HDFC');
      expect(cp.bankAccountNumber).toBe('123456');
      expect(cp.bankAccountHolder).toBe('Owner');
      expect(cp.ifscCode).toBe('HDFC0001');
      expect(cp.upiId).toBe('owner@upi');
      expect(cp.paymentMode).toBe('UPI');

      // Authoritative server-side conversion rate from env.
      expect((result as any).conversionRate).toBe(2);
    });

    it('defaults conversionRate to 1 when POINTS_CONVERSION_RATE is unset', async () => {
      delete process.env.POINTS_CONVERSION_RATE;
      (mockPrisma as any).user.findUnique = jest.fn().mockResolvedValue({ name: 'P', phone: '99' });
      (mockPrisma as any).channelPartner.findUnique.mockResolvedValue(null);
      (mockPrisma as any).salesUser.findUnique.mockResolvedValue(null);

      const result = await service.getMe(partnerUser);
      expect((result as any).conversionRate).toBe(1);
    });
  });

  // â”€â”€ sendOtp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('sendOtp', () => {
    beforeEach(() => {
      // MSG91_AUTH_KEY is set in mockConfig, so sendViaMSG91 will try to
      // call fetch(). Mock a full response including json() so the response-body
      // error check in sendViaMSG91 doesn't blow up.
      global.fetch = jest.fn().mockResolvedValue({
        ok:   true,
        json: async () => ({ type: 'success', message: 'mock-request-id' }),
      } as any);
      // AF-10 per-phone window cap: default to "well under the cap" so existing tests pass.
      mockPrisma.otpCode.count.mockResolvedValue(0);
      // Option-B registration gate: default to "account exists" so a clientId-scoped send proceeds;
      // the unregistered case overrides this to null. Ignored when no clientId is passed.
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'seed-user' } as any);
    });

    it('should create an OTP record and return success', async () => {
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1', code: '123456' });

      const result = await service.sendOtp('9876543210', 'SMS');

      // AF-10: prunes only OUT-OF-WINDOW rows (in-window rows are retained for the cap count).
      const delArg = mockPrisma.otpCode.deleteMany.mock.calls[0][0];
      expect(delArg.where.phone).toBe('9876543210');
      expect(delArg.where.createdAt.lt).toBeInstanceOf(Date);
      expect(mockPrisma.otpCode.create).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('AF-10: rejects (429) when the per-phone window cap is reached', async () => {
      mockPrisma.otpCode.count.mockResolvedValue(5); // at the cap
      await expect(service.sendOtp('9876543210', 'SMS')).rejects.toMatchObject({
        status: 429,
      });
      // No OTP created and no SMS sent once capped.
      expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
    });

    it('A2: OTP code stored is exactly 6 digits', async () => {
      // RED: currently generateOtpCode() produces a 4-digit number (1000-9999).
      // After fix it must produce a 6-digit number (100000-999999).
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });

      await service.sendOtp('9876543210', 'SMS');

      const createArg = mockPrisma.otpCode.create.mock.calls[0][0];
      const code      = createArg.data.code as string;

      expect(code).toHaveLength(6);
      expect(Number(code)).toBeGreaterThanOrEqual(100000);
      expect(Number(code)).toBeLessThanOrEqual(999999);
    });

    it('should reject invalid phone (< 10 digits)', async () => {
      await expect(service.sendOtp('12345', 'SMS')).rejects.toThrow();
    });

    it('uses the global env template when the tenant has no login override', async () => {
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      // programSetting.findMany defaults to [] → no otpTemplates override → undefined → env template.
      await service.sendOtp('9876543210', 'SMS', 'deoleo');

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.template_id).toBe('test-template'); // MSG91_OTP_TEMPLATE_ID env
    });

    it('threads the per-tenant login template into the MSG91 send when configured', async () => {
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      mockPrisma.programSetting.findMany.mockResolvedValueOnce([
        { settingKey: 'otpTemplates', settingValue: { login: 'login-tpl' } },
      ]);

      await service.sendOtp('9876543210', 'SMS', 'deoleo');

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.template_id).toBe('login-tpl');
    });

    it('uses the env template when no clientId is passed (pre-auth, tenant unknown)', async () => {
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      mockPrisma.programSetting.findMany.mockResolvedValueOnce([
        { settingKey: 'otpTemplates', settingValue: { login: 'login-tpl' } },
      ]);

      // No clientId → getOtpTemplateId short-circuits to undefined → env template (no DB read).
      await service.sendOtp('9876543210', 'SMS');

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.template_id).toBe('test-template');
    });

    // ── Option B: check-first registration gate ──────────────────────────────
    it('Option B: refuses to send (401) to a number with NO ACTIVE account under the tenant', async () => {
      // Under ACTIVE-only phone reservation, a number held only by an INACTIVE/soft-deleted
      // user has NO ACTIVE holder → the status:'ACTIVE' lookup returns null → refuse to send.
      mockPrisma.user.findFirst.mockResolvedValue(null as any); // no ACTIVE holder under this tenant
      await expect(service.sendOtp('9876543210', 'SMS', 'deoleo')).rejects.toMatchObject({
        status: 401,
      });
      // Tenant-scoped, ACTIVE-only lookup (a freed/deactivated number does not receive an OTP).
      const where = (mockPrisma.user.findFirst as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ phone: '9876543210', clientId: 'deoleo', status: 'ACTIVE' });
      // No OTP created + no SMS sent for an unregistered number.
      expect(mockPrisma.otpCode.create).not.toHaveBeenCalled();
      expect(global.fetch as jest.Mock).not.toHaveBeenCalled();
    });

    it('Option B: sends to a REGISTERED number (tenant-scoped ACTIVE account exists)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'u1' } as any); // ACTIVE holder exists
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      const result = await service.sendOtp('9876543210', 'SMS', 'deoleo');
      expect(result.success).toBe(true);
      // Gate keyed on the ACTIVE status (not deletedAt), so only a live account is OTP-eligible.
      const where = (mockPrisma.user.findFirst as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ phone: '9876543210', clientId: 'deoleo', status: 'ACTIVE' });
      expect(mockPrisma.otpCode.create).toHaveBeenCalled();
    });

    it('Option B: SKIPS the registration check when no clientId is passed (legacy/unbranded caller)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null as any); // would reject IF the check ran
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      const result = await service.sendOtp('9876543210', 'SMS'); // no clientId
      expect(result.success).toBe(true);
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.otpCode.create).toHaveBeenCalled();
    });
  });

  // â”€â”€ verifyOtp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('verifyOtp', () => {
    const phone    = '9876543210';
    const clientId = 'deoleo';
    const validOtp = { id: 'otp_1', code: '1234', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };

    // The getMe block reassigns mockPrisma.channelPartner to a findUnique-only stub;
    // restore the findFirst + outlet.count shape the deactivated-outlet gate needs.
    beforeEach(() => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn() };
      (mockPrisma as any).outlet = { count: jest.fn() };
    });

    it('should return access + refresh tokens on correct OTP', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'RETAILER', clientId, status: 'ACTIVE' });
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      const result = await service.verifyOtp(phone, '1234', clientId);

      expect(result.accessToken).toBe('mock.jwt.token');
      expect(result.refreshToken).toBeTruthy();
    });

    // ── ACTIVE-only phone reservation: DETERMINISTIC login resolution ──────────
    // Now that a deactivated user keeps deletedAt=null (only status→INACTIVE), an ACTIVE
    // and an INACTIVE row can share (clientId, phone). Login MUST resolve to the ACTIVE
    // user via an ACTIVE-first query — never the nondeterministic old findFirst.
    it('resolves to the ACTIVE user when an ACTIVE + INACTIVE duplicate share the phone', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      // Step 1 (status:'ACTIVE') returns the ACTIVE user; the INACTIVE duplicate is never consulted.
      mockPrisma.user.findFirst.mockResolvedValueOnce({
        id: 'active_user', role: 'RETAILER', clientId, status: 'ACTIVE', name: 'A', phone,
      });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      const result = await service.verifyOtp(phone, '1234', clientId);

      // Tokens are minted for the ACTIVE user's id.
      expect(result.user.id).toBe('active_user');
      // The FIRST user lookup is the ACTIVE-scoped query — proves ACTIVE is consulted first.
      const firstWhere = (mockPrisma.user.findFirst as jest.Mock).mock.calls[0][0].where;
      expect(firstWhere).toMatchObject({ phone, clientId, status: 'ACTIVE' });
      // With an ACTIVE hit, the deletedAt fallback query is never reached.
      expect(mockPrisma.user.findFirst as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it('throws the existing "account is inactive" error for a single INACTIVE user (no ACTIVE)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      // Step 1 (ACTIVE) → none; Step 2 (fallback, deletedAt:null) → the INACTIVE row (message only).
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'u_inactive', role: 'RETAILER', clientId, status: 'INACTIVE' });

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow(
        'Your account is inactive. Please contact your Deoleo representative.',
      );
      // No token minted on the fallback branch.
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('throws the existing "pending activation" error for a single PENDING_VERIFICATION user', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'u_pending', role: 'RETAILER', clientId, status: 'PENDING_VERIFICATION' });

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow(
        'Your account is pending activation. Please contact your Deoleo representative.',
      );
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('throws "No account found" when neither an ACTIVE nor any non-deleted user exists', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst
        .mockResolvedValueOnce(null)  // no ACTIVE
        .mockResolvedValueOnce(null); // no fallback (deletedAt:null) either

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow(
        'No account found. Please contact your sales representative to complete KYC first.',
      );
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    // ── Deactivated-outlet login gate (owner: a deactivated outlet must not log in) ──
    it('blocks a partner login when ALL their outlets are deactivated (0 active)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'WHOLESALER', clientId, status: 'ACTIVE' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', isActive: true });
      mockPrisma.outlet.count.mockResolvedValue(0); // every outlet deactivated/deleted

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('deactivated');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled(); // no session minted
    });

    it('blocks a partner login when the ChannelPartner itself is deactivated', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'SSS', clientId, status: 'ACTIVE' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', isActive: false });
      mockPrisma.outlet.count.mockResolvedValue(1); // even with an active outlet, the partner is off

      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('inactive');
    });

    it('allows a partner login when at least ONE outlet is still active', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'WHOLESALER', clientId, status: 'ACTIVE' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', isActive: true });
      mockPrisma.outlet.count.mockResolvedValue(2); // multi-outlet partner, one deactivated, one still active
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      const result = await service.verifyOtp(phone, '1234', clientId);
      expect(result.accessToken).toBe('mock.jwt.token');
      // The active-outlet count is scoped to active + non-deleted outlets for THIS partner.
      expect(mockPrisma.outlet.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ partnerId: 'cp1', isActive: true, deletedAt: null }) }),
      );
    });

    it('does not gate a non-partner login (sales/admin have no ChannelPartner)', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'su_1', role: 'SALES_SO', clientId, status: 'ACTIVE' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null); // no partner → gate skipped
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      const result = await service.verifyOtp(phone, '1234', clientId);
      expect(result.accessToken).toBe('mock.jwt.token');
      expect(mockPrisma.outlet.count).not.toHaveBeenCalled(); // never even checks outlets
    });

    // The same gate MUST run on refresh — else a partner deactivated mid-session
    // keeps minting access tokens via their 30-day refresh token (audit F1).
    it('refresh is BLOCKED for a partner whose outlets were all deactivated', async () => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn().mockResolvedValue({ id: 'cp1', isActive: true }) };
      (mockPrisma as any).outlet = { count: jest.fn().mockResolvedValue(0) };
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_d', clientId, refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        user: { id: 'u1', role: 'WHOLESALER', clientId },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 }); // atomic claim wins (session now revoked)

      await expect(service.refreshToken('rt')).rejects.toThrow('inactive');
    });

    it('refresh SUCCEEDS for a partner that still has an active outlet', async () => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn().mockResolvedValue({ id: 'cp1', isActive: true }) };
      (mockPrisma as any).outlet = { count: jest.fn().mockResolvedValue(1) };
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_ok', clientId, refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        user: { id: 'u1', role: 'WHOLESALER', clientId },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_new' });

      const result = await service.refreshToken('rt');
      expect(result.accessToken).toBe('mock.jwt.token');
    });

    it('should throw on expired OTP', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        ...validOtp,
        expiresAt: new Date(Date.now() - 1000),  // expired
      });
      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow('OTP expired');
    });

    it('should throw on wrong OTP and increment attempts', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});

      await expect(service.verifyOtp(phone, '9999', clientId)).rejects.toThrow('Invalid OTP');
      expect(mockPrisma.otpCode.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ attempts: 1 }) }),
      );
    });

    it('should lock OTP after 3 failed attempts', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue({ ...validOtp, attempts: 3 });
      await expect(service.verifyOtp(phone, '9999', clientId)).rejects.toThrow('Too many attempts');
    });

    it('should throw on no OTP found for phone', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(null);
      await expect(service.verifyOtp(phone, '1234', clientId)).rejects.toThrow();
    });
  });

  // â”€â”€ generateTokens â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('generateTokens', () => {
    it('should call JwtService.sign with correct payload', async () => {
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
      const user = { id: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210' };

      await service.generateTokens(user as any);

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user_1', role: 'RETAILER', clientId: 'deoleo' }),
        expect.any(Object),
      );
    });
  });

  // ── logoutAllSessions (self "log out everywhere", #101 / Feature 10-i) ───────
  describe('logoutAllSessions', () => {
    const caller = { sub: 'me1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'Me' } as any;

    it('revokes ONLY the caller (user.sub) non-revoked sessions and returns the count', async () => {
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'al1' });

      const res = await service.logoutAllSessions(caller);

      // Strictly scoped to the caller's own userId + non-revoked rows
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'me1', revokedAt: null },
        data:  { revokedAt: expect.any(Date) },
      });
      expect(res).toEqual({ revoked: 3 });
    });

    it('writes a LOGOUT audit log attributed to the caller with the logout_all_sessions event', async () => {
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'al2' });

      await service.logoutAllSessions(caller);

      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
      expect(audit.action).toBe('LOGOUT');
      expect(audit.actorId).toBe('me1');
      expect(audit.metadata).toMatchObject({ event: 'logout_all_sessions', revoked: 1 });
    });
  });

  // ── refreshToken preserves the assumed operator-context (A2 audit fix) ───────
  describe('refreshToken (operator-context)', () => {
    it('a refreshed ASSUMED session keeps the tenant scope + assumed flag (not reverted to gifsy)', async () => {
      // Session row carries the TENANT clientId; its user is the gifsy operator.
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_a', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 }); // claim wins
      mockPrisma.userSession.update.mockResolvedValue({});
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({ sub: 'op1', role: 'GIFSY_ADMIN', clientId: 'deoleo', assumed: true });
    });

    it('a normal session refreshes to its own home clientId (no assumed flag)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_n', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 }); // claim wins
      mockPrisma.userSession.update.mockResolvedValue({});
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload.clientId).toBe('deoleo');
      expect(payload.assumed).toBeUndefined();
    });
  });

  // ── refreshToken atomic single-use claim (token-reuse / session-fixation fix) ─
  describe('refreshToken (atomic single-use)', () => {
    const liveSession = {
      id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
    };

    it('revokes via an ATOMIC updateMany claim keyed on the refreshToken (not a read-then-update by id)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { refreshToken: 'rt', revokedAt: null },
        data:  { revokedAt: expect.any(Date) },
      });
      // new tokens minted exactly once
      expect(mockPrisma.userSession.create).toHaveBeenCalledTimes(1);
      // the successor row records the predecessor it rotated from (idempotent-rotation chain)
      expect(mockPrisma.userSession.create.mock.calls[0][0].data.rotatedFromId).toBe('sess_x');
    });

    it('reads the predecessor IGNORING revokedAt (so a just-rotated predecessor is visible for grace)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      // The FIRST lookup keys on refreshToken alone (no revokedAt:null in the where).
      expect(mockPrisma.userSession.findFirst.mock.calls[0][0].where).toEqual({ refreshToken: 'rt' });
    });

    // ── Idempotent rotation (multi-tab fix) ──────────────────────────────────────
    it('idempotent: a loser (claim lost, predecessor revoked < grace, LIVE successor) returns the successor STORED tokens (no second mint)', async () => {
      const predecessor = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 1_000), // just revoked by the winning sibling
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
      };
      const successor = { id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null };
      // 1st findFirst → predecessor (already revoked); 2nd findFirst → the live successor.
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(predecessor)
        .mockResolvedValueOnce(successor);

      const res = await service.refreshToken('rt');

      // Hands back the successor's already-issued pair — NOT a freshly minted set.
      expect(res).toEqual({ accessToken: 'succ.access', refreshToken: 'succ-refresh' });
      // No claim attempt (already revoked) and, crucially, NO second mint.
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      // The successor lookup REQUIRES revokedAt:null (a revoked successor can't be resurrected).
      expect(mockPrisma.userSession.findFirst.mock.calls[1][0].where).toEqual({
        rotatedFromId: 'sess_x', revokedAt: null,
      });
    });

    it('idempotent: a lost claim (count 0) with a live successor also returns the successor STORED tokens', async () => {
      // Predecessor still reads as un-revoked (our stale read), but the concurrent winner
      // revokes it → our claim loses (count 0) → grace path with predecessorRevokedAt ≈ now.
      const successor = { id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null };
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(liveSession)   // predecessor (revokedAt:null in our read)
        .mockResolvedValueOnce(successor);    // live successor
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 0 }); // claim lost

      const res = await service.refreshToken('rt');

      expect(res).toEqual({ accessToken: 'succ.access', refreshToken: 'succ-refresh' });
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('reuse: an already-revoked token replayed AFTER the 5s grace with NO live successor → 401', async () => {
      const staleRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 60_000), // revoked a minute ago — outside the 5s grace
        createdAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      // Predecessor read → revoked; successor lookup → none (successor already rotated away).
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(staleRevoked)
        .mockResolvedValueOnce(null);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      // Predecessor read + successor lookup = 2 findFirsts; never mints a new session.
      expect(mockPrisma.userSession.findFirst).toHaveBeenCalledTimes(2);
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('unknown token → 401 (no session row at all)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(null);
      await expect(service.refreshToken('nope')).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('no-resurrection: a successor revoked by logout-all → 401 (grace lookup requires revokedAt:null)', async () => {
      const predecessor = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 1_000), // within grace
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
      };
      // Predecessor is within grace, but the successor lookup (revokedAt:null) finds nothing
      // because logout-all revoked the successor → no resurrection → 401.
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(predecessor)
        .mockResolvedValueOnce(null);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('preserves the assumed operator-context only when the claim WINS', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'sess_a', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({ sub: 'op1', clientId: 'deoleo', assumed: true });
    });
  });

  // ── Sliding 7-day session TTL (roll-on-refresh) ──────────────────────────────
  describe('sliding session TTL (SESSION_TTL_DAYS = 7)', () => {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    beforeEach(() => {
      // Fixed "now" so TTL math is exact — computed RELATIVE to the mocked clock,
      // never a hardcoded future date.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('login (generateTokens) stamps expiresAt ≈ now + 7d (not 30d)', async () => {
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
      await service.generateTokens({ id: 'u1', role: 'RETAILER', clientId: 'deoleo', phone: '99' } as any);

      const expiresAt: Date = mockPrisma.userSession.create.mock.calls[0][0].data.expiresAt;
      expect(expiresAt.getTime()).toBe(Date.now() + SEVEN_DAYS_MS);
    });

    it('refresh re-mints expiresAt ≈ now + 7d AND writes rotatedFromId = predecessor.id', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'pred_1', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const data = mockPrisma.userSession.create.mock.calls[0][0].data;
      expect((data.expiresAt as Date).getTime()).toBe(Date.now() + SEVEN_DAYS_MS);
      expect(data.rotatedFromId).toBe('pred_1');
    });

    it('assumed refresh re-mints expiresAt ≈ now + 7d and preserves assumed:true + tenant clientId', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({
        id: 'pred_a', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' },
      });
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await service.refreshToken('rt');

      const data = mockPrisma.userSession.create.mock.calls[0][0].data;
      expect((data.expiresAt as Date).getTime()).toBe(Date.now() + SEVEN_DAYS_MS);
      expect(data.clientId).toBe('deoleo'); // tenant scope preserved
      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({ clientId: 'deoleo', assumed: true });
    });
  });

  // ── Access-token TTL DECOUPLED from the session window (FIX 1a) ──────────────
  // The access JWT must be SHORT (ACCESS_TTL = 60m) on BOTH the normal and the assumed
  // paths so activity forces frequent refreshes; the SESSION ROW stays 7d (sliding), which
  // is what makes the rolling session non-inert. Fake timers → exact 7d math (relative to now).
  describe('access-token TTL (ACCESS_TTL = 60m, session row 7d)', () => {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
      mockPrisma.client.findFirst.mockResolvedValue({ id: 'deoleo', internalName: 'Deoleo' });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' });
      mockPrisma.auditLog.create.mockResolvedValue({});
    });
    afterEach(() => jest.useRealTimers());

    it('NORMAL login signs the access token with expiresIn = 60m (JWT_EXPIRES_IN), NOT 7d', async () => {
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
      await service.generateTokens({ id: 'u1', role: 'RETAILER', clientId: 'deoleo', phone: '99' } as any);

      // 2nd sign arg carries the JWT options; expiresIn is the SHORT access TTL.
      expect(mockJwt.sign.mock.calls[0][1].expiresIn).toBe('60m');
      // …while the persisted SESSION row still lives a full 7 days.
      const expiresAt: Date = mockPrisma.userSession.create.mock.calls[0][0].data.expiresAt;
      expect(expiresAt.getTime()).toBe(Date.now() + SEVEN_DAYS_MS);
    });

    it('ASSUMED (assume-tenant) signs the access token with expiresIn = 60m (not 168h), session row 7d', async () => {
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_a' });
      await service.assumeTenant(gifsyOp, 'deoleo');

      expect(mockJwt.sign.mock.calls[0][1].expiresIn).toBe('60m');
      const expiresAt: Date = mockPrisma.userSession.create.mock.calls[0][0].data.expiresAt;
      expect(expiresAt.getTime()).toBe(Date.now() + SEVEN_DAYS_MS); // 7d, NOT 168h-as-access
    });

    it('CODE default falls back to ACCESS_TTL (60m) when JWT_EXPIRES_IN is unset — never 7d', async () => {
      // Config returns undefined for JWT_EXPIRES_IN → the code default must be 60m.
      // Restore the shared default impl in finally so later describes aren't polluted.
      try {
        mockConfig.get.mockImplementation((key: string): any =>
          key === 'JWT_SECRET' ? 'test-secret' : undefined,
        );
        mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });
        await service.generateTokens({ id: 'u1', role: 'RETAILER', clientId: 'deoleo', phone: '99' } as any);

        expect(mockJwt.sign.mock.calls[0][1].expiresIn).toBe('60m');
      } finally {
        mockConfig.get.mockImplementation((key: string): any => {
          const cfg: Record<string, string> = {
            JWT_SECRET: 'test-secret', JWT_EXPIRES_IN: '60m',
            MSG91_AUTH_KEY: 'test-msg91-key', MSG91_SENDER_ID: 'GIFSY', MSG91_OTP_TEMPLATE_ID: 'test-template',
          };
          return cfg[key];
        });
      }
    });
  });

  // ── logout-all beats a concurrent refresh (FIX 1b) ──────────────────────────
  describe('logout-all authority vs concurrent refresh (1b)', () => {
    const liveSession = () => ({
      id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
      createdAt: new Date(Date.now() - 60_000), // created a minute ago (before any logout)
      expiresAt: new Date(Date.now() + 3600_000),
      user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null as Date | null },
    });

    beforeEach(() => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn().mockResolvedValue(null) };
      (mockPrisma as any).outlet = { count: jest.fn() };
    });

    it('logoutAllSessions stamps user.sessionsInvalidBefore in the SAME op as the revoke', async () => {
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const caller = { sub: 'me1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'Me' } as any;
      const res = await service.logoutAllSessions(caller);

      expect(res).toEqual({ revoked: 2 });
      // The stamp write targets the caller and sets a Date.
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'me1' },
        data:  { sessionsInvalidBefore: expect.any(Date) },
      });
    });

    it('a logout-all landing DURING the refresh revokes the just-minted successor → 401, no live successor', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession()); // read BEFORE logout: stamp null
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 }); // claim wins
      mockPrisma.userSession.create.mockResolvedValue({});
      // The post-mint re-read now SEES a logout-all stamped mid-refresh (comfortably >=
      // startedAt — a wide margin so the assertion never races the real wall clock).
      mockPrisma.user.findUnique.mockResolvedValue({ sessionsInvalidBefore: new Date(Date.now() + 60_000) });

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');

      // A successor WAS minted (create called once)…
      expect(mockPrisma.userSession.create).toHaveBeenCalledTimes(1);
      const mintedRefresh = mockPrisma.userSession.create.mock.calls[0][0].data.refreshToken;
      // …and then REVOKED: the LAST updateMany targets exactly that successor's refreshToken.
      const revokeCalls = mockPrisma.userSession.updateMany.mock.calls;
      const lastRevoke = revokeCalls[revokeCalls.length - 1][0];
      expect(lastRevoke.where).toMatchObject({ refreshToken: mintedRefresh, revokedAt: null });
      expect(lastRevoke.data.revokedAt).toBeInstanceOf(Date);
    });

    it('a predecessor created BEFORE a prior logout-all is refused up front (never mints)', async () => {
      const s = liveSession();
      // Stamp already visible on the predecessor read, and the session predates it.
      s.user.sessionsInvalidBefore = new Date(Date.now() - 1_000);
      s.createdAt = new Date(Date.now() - 60_000);
      mockPrisma.userSession.findFirst.mockResolvedValue(s);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      // Rejected before the atomic claim / mint.
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
    });

    it('a normal refresh with NO logout-all stamp still succeeds (re-read is a no-op)', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession());
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.userSession.create.mockResolvedValue({});
      mockPrisma.user.findUnique.mockResolvedValue({ sessionsInvalidBefore: null });

      const res = await service.refreshToken('rt');
      expect(res.accessToken).toBe('mock.jwt.token');
    });
  });

  // ── reuse detection revokes the lineage (FIX 1c) ────────────────────────────
  describe('refresh-token reuse detection (1c, grace = 5s)', () => {
    beforeEach(() => {
      (mockPrisma as any).channelPartner = { findFirst: jest.fn().mockResolvedValue(null) };
      (mockPrisma as any).outlet = { count: jest.fn() };
    });

    it('replay >5s grace WITH a live successor → hands back the successor tokens, NO lineage kill (legit collision)', async () => {
      // Under the 60m access token, a page-nav proxy refresh and an in-flight XHR refresh can
      // collide MORE than 5s apart. The 2nd (revoked-predecessor) replay must converge on the
      // live successor, NOT nuke the whole active user.
      const revokedPredecessor = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 7_000), // 7s ago — OUTSIDE the 5s grace
        createdAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      const successor = { id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null };
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(revokedPredecessor) // predecessor read
        .mockResolvedValueOnce(successor);         // live successor exists

      const res = await service.refreshToken('rt');

      // Converges on the successor's STORED tokens (no 401, no second mint).
      expect(res).toEqual({ accessToken: 'succ.access', refreshToken: 'succ-refresh' });
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      // Crucially: NO lineage kill — an active user is not logged out everywhere.
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      // The successor lookup requires revokedAt:null (a swept lineage can't be resurrected).
      expect(mockPrisma.userSession.findFirst.mock.calls[1][0].where).toEqual({
        rotatedFromId: 'sess_x', revokedAt: null,
      });
    });

    it('replay >5s grace with NO live successor → 401 AND revokes ALL sessions + stamps the user', async () => {
      const staleRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 7_000), // 7s ago: inside the OLD 10s grace, OUTSIDE the new 5s
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      // Predecessor revoked, NO live successor (already rotated away) → genuine theft signal.
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(staleRevoked)
        .mockResolvedValueOnce(null);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');

      // Predecessor read + successor lookup = 2 findFirsts; never mints.
      expect(mockPrisma.userSession.findFirst).toHaveBeenCalledTimes(2);
      expect(mockPrisma.userSession.create).not.toHaveBeenCalled();
      // STAMP-BEFORE-REVOKE: the user stamp is written BEFORE the session revoke.
      const stampOrder = mockPrisma.user.update.mock.invocationCallOrder[0];
      const revokeCall = mockPrisma.userSession.updateMany.mock.calls.findIndex(
        (c: any) => c[0]?.where?.userId === 'u1',
      );
      const revokeOrder = mockPrisma.userSession.updateMany.mock.invocationCallOrder[revokeCall];
      expect(stampOrder).toBeLessThan(revokeOrder);
      // Lineage kill: revoke EVERY live session for the user…
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
        data:  { revokedAt: expect.any(Date) },
      });
      // …and stamp the user so any in-flight refresh is invalidated too.
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data:  { sessionsInvalidBefore: expect.any(Date) },
      });
    });

    it('a merely EXPIRED-but-never-revoked session is NOT treated as reuse (no lineage kill)', async () => {
      const expired = {
        id: 'sess_e', clientId: 'deoleo', refreshToken: 'rt', revokedAt: null,
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 1_000), // expired
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      // Predecessor read → expired; successor lookup (a login session has no rotation) → none.
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(null);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      // revokedAt === null → not reuse → the user-wide revoke + stamp must NOT run.
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      // …and NO platform security-event row is written on a non-reuse path.
      expect(securityEventCalls()).toHaveLength(0);
    });

    // ── platform-level security-event audit (BE-1) ────────────────────────────
    // Every SECURITY_EVENT AuditLog write for refresh-token reuse; the report filters on
    // exactly this (entityType + metadata.event), so the tests assert on the same shape.
    const securityEventCalls = () =>
      mockPrisma.auditLog.create.mock.calls.filter(
        (c: any) =>
          c[0]?.data?.entityType === 'SECURITY_EVENT' &&
          c[0]?.data?.metadata?.event === 'refresh_token_reuse',
      );

    it('reuse (>5s grace, no live successor) writes ONE SECURITY_EVENT audit row AND still throws 401', async () => {
      const staleRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 7_000),
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(staleRevoked)
        .mockResolvedValueOnce(null);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.user.update.mockResolvedValue({});

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');

      const calls = securityEventCalls();
      expect(calls).toHaveLength(1);
      const data = calls[0][0].data;
      expect(data.action).toBe('LOGOUT');
      expect(data.entityType).toBe('SECURITY_EVENT');
      expect(data.targetUserId).toBe('u1');
      expect(data.entityId).toBe('u1');
      expect(data.actorId).toBe('u1');
      expect(data.metadata.event).toBe('refresh_token_reuse');
      // Which TENANT the reuse belongs to (AuditLog has no clientId column).
      expect(data.metadata.clientId).toBe('deoleo');
      expect(data.metadata.sessionId).toBe('sess_x');
    });

    it('best-effort: a failed SECURITY_EVENT audit write does NOT mask the 401', async () => {
      const staleRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 7_000),
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(staleRevoked)
        .mockResolvedValueOnce(null);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.user.update.mockResolvedValue({});
      // Audit write blows up — the caller must still get the 401, not a 500.
      mockPrisma.auditLog.create.mockRejectedValueOnce(new Error('audit db down'));

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
    });

    it('legit collision (>5s grace WITH a live successor) writes NO SECURITY_EVENT row', async () => {
      const revokedPredecessor = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 7_000),
        createdAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      const successor = { id: 'sess_y', token: 'succ.access', refreshToken: 'succ-refresh', revokedAt: null };
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(revokedPredecessor)
        .mockResolvedValueOnce(successor);

      await service.refreshToken('rt');
      expect(securityEventCalls()).toHaveLength(0);
    });

    it('in-grace loser (revoked < 5s ago, no live successor) writes NO SECURITY_EVENT row', async () => {
      const recentlyRevoked = {
        id: 'sess_x', clientId: 'deoleo', refreshToken: 'rt',
        revokedAt: new Date(Date.now() - 1_000), // 1s ago — INSIDE the 5s grace
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: null },
      };
      mockPrisma.userSession.findFirst
        .mockResolvedValueOnce(recentlyRevoked)
        .mockResolvedValueOnce(null);

      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired');
      // Transient in-grace loser → not reuse → no lineage kill, no security-event row.
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
      expect(securityEventCalls()).toHaveLength(0);
    });
  });

  // â”€â”€ Fixed OTP mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // ── assumeTenant (A2 operator-context switcher, #51) ────────────────────────
  describe('assumeTenant', () => {
    beforeEach(() => {
      mockPrisma.client.findFirst.mockResolvedValue({ id: 'deoleo', internalName: 'Deoleo' });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'op1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '98', name: 'Op' });
      mockPrisma.userSession.create.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});
    });

    it('mints a token scoped to the target tenant, keeping the GIFSY role + real operator sub', async () => {
      const res = await service.assumeTenant(gifsyOp, 'deoleo');
      expect(res.clientId).toBe('deoleo');
      expect(res.brandName).toBe('Deoleo');
      // the JWT payload carries the assumed tenant + assumed flag, sub stays the operator
      const payload = mockJwt.sign.mock.calls[0][0];
      expect(payload).toMatchObject({ sub: 'op1', role: 'GIFSY_ADMIN', clientId: 'deoleo', assumed: true });
      // the session row is bound to the assumed tenant
      expect(mockPrisma.userSession.create.mock.calls[0][0].data.clientId).toBe('deoleo');
      // the tenant lookup admits ACTIVE + ONBOARDING (configure-before-activate),
      // but excludes INACTIVE.
      expect(mockPrisma.client.findFirst.mock.calls[0][0].where).toEqual({
        id: 'deoleo',
        status: { in: ['ACTIVE', 'ONBOARDING'] },
      });
    });

    it('lets an operator assume an ONBOARDING tenant (configure before activating)', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({ id: 'clientb', internalName: 'Client B' });
      const res = await service.assumeTenant(gifsyOp, 'clientb');
      expect(res.clientId).toBe('clientb');
      // The where admits ONBOARDING, so the (mocked) row is returned and assume succeeds.
      expect(mockPrisma.client.findFirst.mock.calls[0][0].where.status).toEqual({
        in: ['ACTIVE', 'ONBOARDING'],
      });
    });

    it('cannot assume an INACTIVE tenant (excluded by the status filter → 404)', async () => {
      // An INACTIVE tenant never matches `status IN (ACTIVE, ONBOARDING)`, so the
      // findFirst resolves null exactly as it would for a disabled tenant.
      mockPrisma.client.findFirst.mockResolvedValue(null);
      await expect(service.assumeTenant(gifsyOp, 'old-inactive')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('audit-logs the assume, attributed to the real operator', async () => {
      await service.assumeTenant(gifsyOp, 'deoleo');
      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
      expect(audit.actorId).toBe('op1');
      expect(audit.metadata).toMatchObject({ event: 'ASSUME_TENANT', fromClientId: 'gifsy', toClientId: 'deoleo' });
    });

    it('refuses a non-GIFSY caller (403)', async () => {
      const clientAdmin = { ...gifsyOp, role: 'CLIENT_ADMIN', clientId: 'deoleo' };
      await expect(service.assumeTenant(clientAdmin, 'clientb')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('404s an unknown/inactive tenant', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(null);
      await expect(service.assumeTenant(gifsyOp, 'no-such')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400s assuming the operator’s own context', async () => {
      await expect(service.assumeTenant(gifsyOp, 'gifsy')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('FIXED_OTP mode', () => {
    it('should accept fixed OTP regardless of stored code when FIXED_OTP env is set', async () => {
      // Override config to return FIXED_OTP
      mockConfig.get.mockImplementation((key: string) => {
        if (key === 'FIXED_OTP') return '1234';
        const cfg: Record<string, string> = {
          JWT_SECRET: 'test-secret', JWT_EXPIRES_IN: '60m',
          MSG91_AUTH_KEY: 'key', MSG91_SENDER_ID: 'GIFSY', MSG91_OTP_TEMPLATE_ID: 'tmpl',
        };
        return cfg[key];
      });

      const otpWithDifferentCode = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
      mockPrisma.otpCode.findFirst.mockResolvedValue(otpWithDifferentCode);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'RETAILER', clientId: 'deoleo', status: 'ACTIVE' });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      // code in DB is '9999' but FIXED_OTP is '1234' â€” should accept '1234'
      const result = await service.verifyOtp('9876543210', '1234', 'deoleo');
      expect(result.accessToken).toBe('mock.jwt.token');
    });

    it('should reject even fixed OTP if the submitted code does not match it', async () => {
      mockConfig.get.mockImplementation((key: string): any => key === 'FIXED_OTP' ? '1234' : undefined);
      const record = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
      mockPrisma.otpCode.findFirst.mockResolvedValue(record);
      mockPrisma.otpCode.update.mockResolvedValue({});

      // '5678' is neither the stored code nor the fixed OTP
      await expect(service.verifyOtp('9876543210', '5678', 'deoleo')).rejects.toThrow('Invalid OTP');
    });

    it('REFUSES to honor FIXED_OTP in production (defense-in-depth NODE_ENV guard)', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        // Even with FIXED_OTP=1234 configured, prod must fall back to the stored code.
        mockConfig.get.mockImplementation((key: string): any => key === 'FIXED_OTP' ? '1234' : undefined);
        const record = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
        mockPrisma.otpCode.findFirst.mockResolvedValue(record);
        mockPrisma.otpCode.update.mockResolvedValue({});

        // Submitting the would-be fixed OTP must be rejected — only the real stored code works.
        await expect(service.verifyOtp('9876543210', '1234', 'deoleo')).rejects.toThrow('Invalid OTP');
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    it('HONORS FIXED_OTP in production-NODE_ENV staging when ALLOW_FIXED_OTP=true (the opt-in)', async () => {
      const prevEnv = process.env.NODE_ENV;
      const prevFlag = process.env.ALLOW_FIXED_OTP;
      const prevDb = process.env.DATABASE_URL;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_FIXED_OTP = 'true';
      process.env.DATABASE_URL = 'postgresql://u:p@h/gifsy_staging'; // not the prod DB
      try {
        mockConfig.get.mockImplementation((key: string): any => key === 'FIXED_OTP' ? '1234' : undefined);
        const record = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
        mockPrisma.otpCode.findFirst.mockResolvedValue(record);
        mockPrisma.otpCode.update.mockResolvedValue({});
        mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'RETAILER', clientId: 'deoleo', status: 'ACTIVE' });
        mockPrisma.user.update.mockResolvedValue({});
        mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

        // staging opt-in: the fixed OTP is accepted even though NODE_ENV=production
        const result = await service.verifyOtp('9876543210', '1234', 'deoleo');
        expect(result.accessToken).toBe('mock.jwt.token');
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevFlag === undefined) delete process.env.ALLOW_FIXED_OTP; else process.env.ALLOW_FIXED_OTP = prevFlag;
        if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
      }
    });

    it('still HARD-refuses FIXED_OTP when ALLOW_FIXED_OTP=true but the DB is prod', async () => {
      const prevEnv = process.env.NODE_ENV;
      const prevFlag = process.env.ALLOW_FIXED_OTP;
      const prevDb = process.env.DATABASE_URL;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_FIXED_OTP = 'true';
      process.env.DATABASE_URL = 'postgresql://u:p@h/gifsy_prod';
      try {
        mockConfig.get.mockImplementation((key: string): any => key === 'FIXED_OTP' ? '1234' : undefined);
        const record = { id: 'otp_1', code: '9999', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };
        mockPrisma.otpCode.findFirst.mockResolvedValue(record);
        mockPrisma.otpCode.update.mockResolvedValue({});
        await expect(service.verifyOtp('9876543210', '1234', 'deoleo')).rejects.toThrow('Invalid OTP');
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevFlag === undefined) delete process.env.ALLOW_FIXED_OTP; else process.env.ALLOW_FIXED_OTP = prevFlag;
        if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
      }
    });
  });

  describe('Business rule constants', () => {
    it('should have POINTS_TO_PAISE conversion of 100 (1 point = ₹1)', () => {
      expect(AuthService.POINTS_TO_PAISE).toBe(100);
    });
  });
});
