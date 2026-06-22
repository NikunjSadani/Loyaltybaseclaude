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

// â”€â”€â”€ Mocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const mockPrisma = {
  user:    { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  otpCode: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
  userSession: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  client:  { findFirst: jest.fn() },
  auditLog: { create: jest.fn() },
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
      JWT_EXPIRES_IN:          '7d',
      JWT_REFRESH_EXPIRES_IN:  '30d',
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
    });

    it('should create an OTP record and return success', async () => {
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1', code: '123456' });

      const result = await service.sendOtp('9876543210', 'SMS');

      expect(mockPrisma.otpCode.deleteMany).toHaveBeenCalledWith({
        where: { phone: '9876543210', verifiedAt: null },
      });
      expect(mockPrisma.otpCode.create).toHaveBeenCalled();
      expect(result.success).toBe(true);
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
  });

  // â”€â”€ verifyOtp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe('verifyOtp', () => {
    const phone    = '9876543210';
    const clientId = 'deoleo';
    const validOtp = { id: 'otp_1', code: '1234', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000), verifiedAt: null };

    it('should return access + refresh tokens on correct OTP', async () => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user_1', role: 'RETAILER', clientId, status: 'ACTIVE' });
      mockPrisma.userSession.create.mockResolvedValue({ id: 'sess_1' });

      const result = await service.verifyOtp(phone, '1234', clientId);

      expect(result.accessToken).toBe('mock.jwt.token');
      expect(result.refreshToken).toBeTruthy();
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
    });

    it('rejects a SECOND concurrent refresh with the same token (claim lost → count 0)', async () => {
      // Both racers see the un-revoked session (findFirst passes for both)…
      mockPrisma.userSession.findFirst.mockResolvedValue(liveSession);
      // …but the DB serialises the claim: first wins (count 1), second loses (count 0).
      mockPrisma.userSession.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      mockPrisma.userSession.create.mockResolvedValue({});

      await expect(service.refreshToken('rt')).resolves.toBeDefined();          // winner
      await expect(service.refreshToken('rt')).rejects.toThrow('Session expired'); // loser rejected

      // the loser must NOT mint a new token set
      expect(mockPrisma.userSession.create).toHaveBeenCalledTimes(1);
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
          JWT_SECRET: 'test-secret', JWT_EXPIRES_IN: '7d',
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
  });

  describe('Business rule constants', () => {
    it('should have POINTS_TO_PAISE conversion of 100 (1 point = ₹1)', () => {
      expect(AuthService.POINTS_TO_PAISE).toBe(100);
    });
  });
});
