// TDD: JwtStrategy
// Tests BEFORE implementation — RED first.
//
// S1: constructor throws if JWT_SECRET env var is absent
//       (currently falls back to 'changeme' — should be RED)
// S2: constructs normally when JWT_SECRET is present
// S3: validate() returns payload when session is active
// S4: validate() throws UnauthorizedException when session is revoked/expired

import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

const mockPrisma = {
  userSession: { findFirst: jest.fn() },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(secret: string | undefined) {
  return { get: jest.fn().mockReturnValue(secret) } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('JwtStrategy', () => {
  describe('constructor', () => {
    it('S1: throws at startup when JWT_SECRET is not set', () => {
      expect(() => new JwtStrategy(makeConfig(undefined), mockPrisma as any))
        .toThrow('JWT_SECRET environment variable is not set');
    });

    it('S2: constructs successfully when JWT_SECRET is present', () => {
      expect(() => new JwtStrategy(makeConfig('supersecret'), mockPrisma as any))
        .not.toThrow();
    });
  });

  describe('validate', () => {
    let strategy: JwtStrategy;

    beforeEach(() => {
      strategy = new JwtStrategy(makeConfig('supersecret'), mockPrisma as any);
      jest.clearAllMocks();
    });

    it('S3: returns the JWT payload when an active session exists', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'sess_1' });
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test' };
      const result  = await strategy.validate(payload as any);
      expect(result).toEqual(payload);
    });

    it('S4: throws UnauthorizedException when session is revoked or expired', async () => {
      mockPrisma.userSession.findFirst.mockResolvedValue(null);
      const payload = { sub: 'user_1', role: 'RETAILER', clientId: 'deoleo', phone: '9876543210', name: 'Test' };
      await expect(strategy.validate(payload as any)).rejects.toThrow(UnauthorizedException);
    });
  });
});
