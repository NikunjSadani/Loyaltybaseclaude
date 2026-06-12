// TDD: AuthService
// Tests written BEFORE implementation â€” each describes expected behaviour.
// Run: npx jest src/auth/auth.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

// â”€â”€â”€ Mocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const mockPrisma = {
  user:    { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  otpCode: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
  userSession: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
};

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
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
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

  // â”€â”€ Fixed OTP mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  });

  describe('Business rule constants', () => {
    it('should have POINTS_TO_PAISE conversion of 100 (1 point = ₹1)', () => {
      expect(AuthService.POINTS_TO_PAISE).toBe(100);
    });
  });
});
